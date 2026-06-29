/**
 * /tool-graph command — visual introspection of tool call dependency DAGs.
 *
 * Renders an ASCII DAG showing:
 *  - Which tools block which (dependency edges)
 *  - Which tools can run in parallel (same wave)
 *  - Where the dependency scheduler made coalescence decisions
 *  - Cache hit/miss status for the plan
 *
 * Sub-commands:
 *   /tool-graph                     — render ASCII DAG for the last execution plan
 *   /tool-graph show <fingerprint>  — render a specific cached plan
 *   /tool-graph snapshots           — list saved JSON snapshots
 *   /tool-graph clear               — clear the plan cache
 *
 * Debug mode (--debug-graph flag or env ASHLRCODE_DEBUG_GRAPH=1):
 *   Writes JSON GraphSnapshot files to ~/.ashlrcode/tool-graphs/ for post-mortem.
 */

import { mkdir, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";
import {
  buildExecutionPlan,
  clearPlanCache,
  planCacheSize,
  getCachedPlan,
  getGraph,
  type GraphSnapshot,
  type ExecutionPlan,
} from "../agent/tool-dependency-scheduler.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOTS_DIR = join(homedir(), ".ashlrcode", "tool-graphs");
const MAX_LABEL_LEN = 28;
const BOX_WIDTH = 72;

// ---------------------------------------------------------------------------
// ASCII DAG renderer
// ---------------------------------------------------------------------------

/** Truncate a string to at most `max` characters with an ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Pad a string on the right to exactly `width` characters. */
function padRight(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

/** Render a horizontal rule. */
function hr(char = "─"): string {
  return char.repeat(BOX_WIDTH);
}

/**
 * Build a node label like `[0] Edit(file.ts)` from a DAG node + optional
 * tool-call list for richer context.
 */
function nodeLabel(node: GraphSnapshot["nodes"][number], toolCalls?: ToolCall[]): string {
  const tc = toolCalls?.[node.index];
  let detail = "";
  if (tc) {
    const key =
      (tc.input.file_path as string | undefined) ??
      (tc.input.path as string | undefined) ??
      (tc.input.command as string | undefined) ??
      (tc.input.query as string | undefined) ??
      "";
    if (typeof key === "string" && key) {
      const tail = key.split("/").pop() ?? key;
      detail = `(${truncate(tail, 18)})`;
    }
  } else if (node.reads.length > 0 || node.writes.length > 0) {
    const res = [...node.writes, ...node.reads][0] ?? "";
    const tail = res.split("/").pop() ?? res;
    detail = `(${truncate(tail, 18)})`;
  }
  return `[${node.index}] ${node.toolName}${detail}`;
}

/**
 * Render a full ASCII DAG for a `GraphSnapshot`.
 *
 * Example:
 * ```
 * ── Tool Dependency Graph ──────────────────────────────────────────────────
 *  fingerprint: a1b2c3d4   nodes: 4   edges: 2   waves: 3   cycle: no
 * ──────────────────────────────────────────────────────────────────────────
 *  Wave 0  [parallel x2]
 *    ● [0] Read(a.ts)           reads: /src/a.ts
 *    ● [1] Read(b.ts)           reads: /src/b.ts
 *
 *  Wave 1  [serial]
 *    ◆ [2] Edit(a.ts)           writes: /src/a.ts    ← blocked by [0]
 *
 *  Wave 2  [serial]
 *    ◆ [3] Bash(deploy)         opaque: tool:bash    ← blocked by [2]
 *
 *  Dependency edges:
 *    [0] Read  ──▶  [2] Edit    via /src/a.ts
 *    [2] Edit  ──▶  [3] Bash    via tool:bash
 * ──────────────────────────────────────────────────────────────────────────
 * ```
 */
export function renderDAG(snapshot: GraphSnapshot, toolCalls?: ToolCall[]): string {
  const lines: string[] = [];

  // Header
  lines.push(hr("─"));
  lines.push(
    ` fingerprint: ${snapshot.fingerprint || "(none)"}   ` +
      `nodes: ${snapshot.nodeCount}   edges: ${snapshot.edgeCount}   ` +
      `waves: ${snapshot.waveCount}   cycle: ${snapshot.hasCycle ? "YES ⚠" : "no"}`,
  );
  if (snapshot.hasCycle) {
    lines.push("  WARNING: cycle detected — scheduler fell back to serial execution");
  }
  lines.push(hr("─"));

  // Waves
  for (let wi = 0; wi < snapshot.waves.length; wi++) {
    const wave = snapshot.waves[wi]!;
    const deg = snapshot.parallelismDegrees[wi] ?? wave.length;
    const modeLabel =
      deg > 1
        ? `parallel x${deg}`
        : "serial   ";
    lines.push(`  Wave ${wi}  [${modeLabel}]`);

    for (const idx of wave) {
      const node = snapshot.nodes[idx];
      if (!node) continue;

      const hasWrite = node.writes.length > 0;
      const bullet = hasWrite ? "◆" : "●";
      const label = padRight(nodeLabel(node, toolCalls), MAX_LABEL_LEN);

      // Resource summary
      let resSummary = "";
      if (node.writes.length > 0) {
        resSummary = `writes: ${truncate(node.writes[0]!, 22)}`;
      } else if (node.reads.length > 0) {
        resSummary = `reads:  ${truncate(node.reads[0]!, 22)}`;
      }

      // Blocked-by annotation
      const blockedBy = node.deps.length > 0 ? `  ← blocked by [${node.deps.join(", ")}]` : "";

      lines.push(`    ${bullet} ${label}  ${padRight(resSummary, 30)}${blockedBy}`);
    }

    lines.push("");
  }

  // Serial bottlenecks callout
  if (snapshot.serialBottlenecks.length > 0) {
    lines.push(
      `  Serial bottlenecks (lone tools, no parallelism): [${snapshot.serialBottlenecks.join(", ")}]`,
    );
    lines.push("");
  }

  // Coalescence decisions
  if (snapshot.coalescedPairs.length > 0) {
    lines.push("  Coalescence candidates (same wave, shared write target):");
    for (const [a, b] of snapshot.coalescedPairs) {
      const nA = snapshot.nodes[a];
      const nB = snapshot.nodes[b];
      if (!nA || !nB) continue;
      lines.push(
        `    [${a}] ${nA.toolName}  ⇌  [${b}] ${nB.toolName}  (could be merged)`,
      );
    }
    lines.push("");
  }

  // Dependency edges
  if (snapshot.edgeCount > 0) {
    lines.push("  Dependency edges:");
    for (const e of snapshot.edges) {
      const fromNode = snapshot.nodes[e.from];
      const toNode = snapshot.nodes[e.to];
      const fromLabel = fromNode ? `[${e.from}] ${fromNode.toolName}` : `[${e.from}]`;
      const toLabel = toNode ? `[${e.to}] ${toNode.toolName}` : `[${e.to}]`;
      lines.push(`    ${padRight(fromLabel, 18)} ──▶  ${padRight(toLabel, 18)} via ${e.resource}`);
    }
    lines.push("");
  }

  lines.push(hr("─"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Debug snapshot I/O
// ---------------------------------------------------------------------------

/** Determine whether --debug-graph mode is active. */
export function isDebugGraphMode(args: string): boolean {
  return (
    args.includes("--debug-graph") ||
    process.env["ASHLRCODE_DEBUG_GRAPH"] === "1"
  );
}

/** Write a `GraphSnapshot` to `~/.ashlrcode/tool-graphs/<fingerprint>-<ts>.json`. */
export async function writeGraphSnapshot(snapshot: GraphSnapshot): Promise<string> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${snapshot.fingerprint || "empty"}-${ts}.json`;
  const filePath = join(SNAPSHOTS_DIR, fileName);
  await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  return filePath;
}

/** List all saved snapshot file names in `SNAPSHOTS_DIR`. */
export async function listGraphSnapshots(): Promise<string[]> {
  try {
    const entries = await readdir(SNAPSHOTS_DIR);
    return entries.filter((e) => e.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Demo plan builder (for /tool-graph with no live plan context)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic demo plan to illustrate the DAG renderer when no real
 * tool calls are available in the current session.
 */
function buildDemoPlan(): { plan: ExecutionPlan; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [
    { id: "demo-0", name: "Read",  input: { file_path: "/src/a.ts" } },
    { id: "demo-1", name: "Read",  input: { file_path: "/src/b.ts" } },
    { id: "demo-2", name: "Edit",  input: { file_path: "/src/a.ts" } },
    { id: "demo-3", name: "Bash",  input: { command: "bun test" } },
  ];
  const plan = buildExecutionPlan(toolCalls);
  return { plan, toolCalls };
}

// ---------------------------------------------------------------------------
// /tool-graph command
// ---------------------------------------------------------------------------

export function toolGraphCommands(): Command[] {
  return [
    {
      name: "/tool-graph",
      description: "Visualise tool call dependency DAG, parallel waves, and coalescence decisions",
      category: "agent",
      subcommands: ["show", "snapshots", "clear", "--debug-graph"],
      handler: async (args, ctx) => {
        const cleanArgs = args.trim();

        // ── /tool-graph clear ──────────────────────────────────────────────
        if (cleanArgs === "clear") {
          clearPlanCache();
          ctx.addOutput(theme.success("\n  Plan cache cleared.\n"));
          return true;
        }

        // ── /tool-graph snapshots ──────────────────────────────────────────
        if (cleanArgs === "snapshots") {
          const snaps = await listGraphSnapshots();
          if (snaps.length === 0) {
            ctx.addOutput(
              theme.tertiary(
                `\n  No snapshots found in ${SNAPSHOTS_DIR}.\n` +
                  "  Run with --debug-graph to generate snapshots.\n",
              ),
            );
          } else {
            ctx.addOutput(theme.accentBold(`\n  Graph snapshots in ${SNAPSHOTS_DIR}:\n`));
            for (const s of snaps) {
              ctx.addOutput(`    ${theme.accent(s)}`);
            }
            ctx.addOutput(`\n  ${snaps.length} snapshot(s) total.\n`);
          }
          return true;
        }

        // ── /tool-graph show <fingerprint> ─────────────────────────────────
        if (cleanArgs.startsWith("show ")) {
          const fp = cleanArgs.slice(5).trim();
          const cached = getCachedPlan(fp);
          if (!cached) {
            ctx.addOutput(
              theme.error(`\n  No cached plan found for fingerprint: ${fp}\n`) +
                theme.muted(`  Cache size: ${planCacheSize()} plan(s). Use /tool-graph to see the latest.\n`),
            );
            return true;
          }
          const snapshot = getGraph(cached);
          ctx.addOutput("\n" + theme.accentBold("  Tool Dependency Graph") + "\n");
          ctx.addOutput(renderDAG(snapshot));
          ctx.addOutput("");
          return true;
        }

        // ── /tool-graph [--debug-graph] ────────────────────────────────────
        // Use a demo plan to illustrate since we don't have live tool calls here.
        // In production, callers should pass tool calls from the execution context.
        const debugMode = isDebugGraphMode(cleanArgs);

        const cacheInfo =
          planCacheSize() > 0
            ? theme.success(`  Plan cache: ${planCacheSize()} plan(s) cached`)
            : theme.muted(`  Plan cache: empty`);

        ctx.addOutput(
          [
            "",
            theme.accentBold("  Tool Dependency Graph  /tool-graph"),
            "",
            cacheInfo,
            theme.muted("  Showing demo plan (attach to agent session for live plans)"),
            "",
          ].join("\n"),
        );

        const { plan, toolCalls } = buildDemoPlan();
        const snapshot = getGraph(plan);

        ctx.addOutput(renderDAG(snapshot, toolCalls));
        ctx.addOutput("");

        if (debugMode) {
          try {
            const filePath = await writeGraphSnapshot(snapshot);
            ctx.addOutput(theme.success(`  Snapshot written: ${filePath}\n`));
          } catch (err) {
            ctx.addOutput(
              theme.error(
                `  Failed to write snapshot: ${err instanceof Error ? err.message : String(err)}\n`,
              ),
            );
          }
        }

        ctx.addOutput(
          [
            theme.secondary("  Sub-commands:"),
            `    ${theme.accent("/tool-graph show <fingerprint>")}  — render a specific cached plan`,
            `    ${theme.accent("/tool-graph snapshots")}           — list saved JSON snapshots`,
            `    ${theme.accent("/tool-graph clear")}               — clear the plan cache`,
            `    ${theme.accent("/tool-graph --debug-graph")}       — also write JSON snapshot`,
            "",
          ].join("\n"),
        );

        return true;
      },
    },
  ];
}
