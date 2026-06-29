/**
 * Intelligent Tool Batching & Dependency-Aware Execution
 *
 * Enhances the base dependency scheduler with:
 *
 * 1. Full DAG construction including implicit file-path dependencies
 *    (Write → Read same file = sequential; Read A + Read B = parallel).
 *
 * 2. Redundancy detection and coalescing: repeated Grep/Read calls on the
 *    same file with different patterns are collapsed into a single
 *    batched call that returns { path → result } maps.
 *
 * 3. Speculative batching: pending safe read-only calls (Read, Glob, Grep)
 *    are grouped into a single "batch-read" virtual call, saving round-trips
 *    and parallelism overhead.
 *
 * 4. ASCII DAG printer: `visualiseExecutionPlan()` is re-exported from the
 *    base scheduler and augmented with batch-awareness.
 *
 * Primary export: `batchToolCalls(pending)` → `BatchedToolCall[]`
 *
 * Statistics are maintained in a session-level singleton and exposed via
 * `getBatchingStats()` / `resetBatchingStats()` for the `/tool-batch-stats`
 * command.
 */

import type { ToolCall } from "../providers/types.ts";
import {
  buildDAG,
  extractResourceAccess,
  topologicalWaves,
  visualiseExecutionPlan,
  buildExecutionPlan,
} from "./tool-dependency-scheduler.ts";
export { visualiseExecutionPlan } from "./tool-dependency-scheduler.ts";
export type { ExecutionPlan, DAGNode, DAGEdge, Wave, ResourceAccess } from "./tool-dependency-scheduler.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A batched representation of one or more original tool calls.
 *
 * - `tools` is the list of original ToolCall objects included in this batch.
 * - `batchId` is a stable unique identifier for debugging and stats.
 * - `dependencies` lists the batchIds that must complete before this batch runs.
 * - `estimatedParallelism` is the max number of tools that can run in parallel
 *   within this batch (all tools in a speculative-read batch run in parallel).
 * - `batchType` distinguishes single calls, merged redundant calls, and
 *   speculative-read super-batches.
 */
export interface BatchedToolCall {
  batchId: string;
  tools: ToolCall[];
  dependencies: string[];
  estimatedParallelism: number;
  batchType: "single" | "coalesced" | "speculative-read";
  /** For coalesced Grep calls: the merged pattern string. */
  mergedPattern?: string;
  /** For batch-read calls: map of file path → result placeholder. */
  batchReadPaths?: string[];
}

// ---------------------------------------------------------------------------
// Safe-to-batch tool sets
// ---------------------------------------------------------------------------

/** Tools that are safe to speculative-batch (pure reads, no side effects). */
const SAFE_READ_TOOLS = new Set([
  "read",
  "fileread",
  "file_read",
  "grep",
  "glob",
  "ls",
  "diff",
  "webfetch",
  "web_fetch",
  "websearch",
  "web_search",
]);

/** Tools that can be coalesced when they target the same resource. */
const COALESABLE_TOOLS = new Set([
  "grep",
  "read",
  "fileread",
  "file_read",
]);

function isSafeReadTool(name: string): boolean {
  return SAFE_READ_TOOLS.has(name.toLowerCase());
}

function isCoalesableTool(name: string): boolean {
  return COALESABLE_TOOLS.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Batching statistics
// ---------------------------------------------------------------------------

export interface BatchingStats {
  /** Total number of original tool calls processed. */
  totalCalls: number;
  /** Number of batched groups emitted (after reduction). */
  batchedGroups: number;
  /** Number of calls eliminated by redundancy coalescing. */
  redundancyEliminated: number;
  /** Number of speculative-read batches created. */
  speculativeBatches: number;
  /** Estimated round-trip savings (calls not emitted). */
  roundTripSavings: number;
  /** Estimated parallel efficiency: avg tools per batch. */
  avgParallelism: number;
  /** Batch reduction percentage: (1 - batchedGroups / totalCalls) * 100 */
  batchReductionPct: number;
}

let _stats: BatchingStats = _emptyStats();

function _emptyStats(): BatchingStats {
  return {
    totalCalls: 0,
    batchedGroups: 0,
    redundancyEliminated: 0,
    speculativeBatches: 0,
    roundTripSavings: 0,
    avgParallelism: 1,
    batchReductionPct: 0,
  };
}

export function getBatchingStats(): Readonly<BatchingStats> {
  return { ..._stats };
}

export function resetBatchingStats(): void {
  _stats = _emptyStats();
}

function _updateStats(original: number, batched: BatchedToolCall[]): void {
  const eliminated = batched.reduce(
    (sum, b) => sum + (b.batchType === "coalesced" ? b.tools.length - 1 : 0),
    0
  );
  const specBatches = batched.filter((b) => b.batchType === "speculative-read").length;
  const totalParallelism = batched.reduce((s, b) => s + b.estimatedParallelism, 0);

  _stats.totalCalls += original;
  _stats.batchedGroups += batched.length;
  _stats.redundancyEliminated += eliminated;
  _stats.speculativeBatches += specBatches;
  _stats.roundTripSavings += original - batched.length;
  _stats.avgParallelism =
    _stats.batchedGroups > 0 ? totalParallelism / _stats.batchedGroups : 1;
  _stats.batchReductionPct =
    _stats.totalCalls > 0
      ? Math.round((1 - _stats.batchedGroups / _stats.totalCalls) * 100 * 10) / 10
      : 0;
}

// ---------------------------------------------------------------------------
// Redundancy detection helpers
// ---------------------------------------------------------------------------

/**
 * Extract the primary resource key for a tool call.
 * Returns null when the tool has no identifiable resource target.
 */
function primaryResource(tc: ToolCall): string | null {
  const accesses = extractResourceAccess(tc);
  const reads = accesses.filter((a) => a.mode === "read");
  if (reads.length > 0) return reads[0]!.resource;
  const writes = accesses.filter((a) => a.mode === "write");
  if (writes.length > 0) return writes[0]!.resource;
  return null;
}

/** Extract the grep pattern from a tool call (if applicable). */
function grepPattern(tc: ToolCall): string | null {
  const n = tc.name.toLowerCase();
  if (n !== "grep") return null;
  const p = tc.input["pattern"] ?? tc.input["regex"] ?? tc.input["query"];
  return typeof p === "string" ? p : null;
}

/**
 * Group sequential Grep calls on the same file path into coalesced batches.
 *
 * Algorithm: sliding window — whenever two Grep calls share the same `path`
 * input they are coalesced into one BatchedToolCall whose `mergedPattern`
 * combines the patterns with `|` alternation.
 *
 * Returns remaining calls (non-grep or ungroupable) passthrough.
 */
function coalesceGrepCalls(calls: ToolCall[]): Array<ToolCall[] | "passthrough"> {
  // Group by file path
  const groups = new Map<string, ToolCall[]>();
  const order: string[] = []; // tracks insertion order of resource keys

  for (const tc of calls) {
    const n = tc.name.toLowerCase();
    if (n === "grep") {
      const path = tc.input["path"] ?? tc.input["file_path"] ?? tc.input["directory"];
      const key = typeof path === "string" ? `grep:${path}` : `grep:__global`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(tc);
    } else {
      // Non-grep passthrough — emit as a sentinel so we preserve relative order
      const sentinel = `pass:${tc.id}`;
      groups.set(sentinel, [tc]);
      order.push(sentinel);
    }
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    if (key.startsWith("pass:") || group.length === 1) return "passthrough";
    return group; // coalesced group
  });
}

// ---------------------------------------------------------------------------
// Speculative read batching
// ---------------------------------------------------------------------------

/**
 * Given a wave of tool-call indices, group all safe-read indices into a
 * single speculative-read BatchedToolCall and return each unsafe call as its
 * own single BatchedToolCall.
 */
function buildWaveBatches(
  wave: number[],
  calls: ToolCall[],
  batchIdPrefix: string
): BatchedToolCall[] {
  const safeIdx: number[] = [];
  const unsafeIdx: number[] = [];

  for (const idx of wave) {
    const tc = calls[idx];
    if (!tc) continue;
    if (isSafeReadTool(tc.name)) {
      safeIdx.push(idx);
    } else {
      unsafeIdx.push(idx);
    }
  }

  const result: BatchedToolCall[] = [];

  // Speculative-read super-batch
  if (safeIdx.length >= 2) {
    const tools = safeIdx.map((i) => calls[i]!);
    const paths = tools.flatMap((tc) => {
      const accesses = extractResourceAccess(tc);
      return accesses.map((a) => a.resource);
    });
    result.push({
      batchId: `${batchIdPrefix}-spec-read`,
      tools,
      dependencies: [],
      estimatedParallelism: tools.length,
      batchType: "speculative-read",
      batchReadPaths: [...new Set(paths)],
    });
  } else {
    // Not enough to batch — emit individually
    for (const idx of safeIdx) {
      const tc = calls[idx]!;
      result.push({
        batchId: `${batchIdPrefix}-single-${idx}`,
        tools: [tc],
        dependencies: [],
        estimatedParallelism: 1,
        batchType: "single",
      });
    }
  }

  // Unsafe tools always run individually
  for (const idx of unsafeIdx) {
    const tc = calls[idx]!;
    result.push({
      batchId: `${batchIdPrefix}-unsafe-${idx}`,
      tools: [tc],
      dependencies: [],
      estimatedParallelism: 1,
      batchType: "single",
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Monotonic batch sequence counter (per-session). */
let _batchSeq = 0;

/**
 * Batch a list of pending ToolCall objects into an optimised execution plan.
 *
 * Steps:
 * 1. Build full DAG including implicit file-path dependencies.
 * 2. Detect and coalesce redundant sequential Grep calls on same target.
 * 3. Topological sort → waves.
 * 4. Within each wave, group safe read-only tools into speculative-read batches.
 * 5. Wire inter-wave dependencies between BatchedToolCall objects.
 * 6. Update cumulative stats.
 *
 * @param pending  Raw tool calls from the agent.
 * @returns        Ordered list of BatchedToolCall objects.  The caller should
 *                 execute batches respecting the `dependencies` links.
 */
export function batchToolCalls(pending: ToolCall[]): BatchedToolCall[] {
  if (pending.length === 0) return [];

  const seq = ++_batchSeq;

  // ── Step 1: Full DAG ──────────────────────────────────────────────────────
  const { nodes, edges } = buildDAG(pending);
  const { waves, hasCycle } = topologicalWaves(nodes);

  // On cycle, fall back to fully serial single-call batches
  if (hasCycle) {
    const fallback: BatchedToolCall[] = pending.map((tc, i) => ({
      batchId: `b${seq}-cycle-${i}`,
      tools: [tc],
      dependencies: i > 0 ? [`b${seq}-cycle-${i - 1}`] : [],
      estimatedParallelism: 1,
      batchType: "single" as const,
    }));
    _updateStats(pending.length, fallback);
    return fallback;
  }

  // ── Step 2: Coalesce redundant sequential grep calls ─────────────────────
  // Operate on calls in original order; grouping by path key
  const grepCoalescedCalls: ToolCall[] = [];
  const coalescedMap = new Map<number, number>(); // original-index → coalesced-index

  // Build lookup: for each wave, coalesce grepping calls that share a path
  // We do this globally rather than per-wave to catch cross-wave redundancy.
  const grepGroups = new Map<string, ToolCall[]>();
  const grepGroupOrder: string[] = [];

  for (let i = 0; i < pending.length; i++) {
    const tc = pending[i]!;
    const n = tc.name.toLowerCase();
    if (n === "grep") {
      const path = tc.input["path"] ?? tc.input["file_path"] ?? tc.input["directory"] ?? "__global";
      const key = `grep:${path}`;
      if (!grepGroups.has(key)) {
        grepGroups.set(key, []);
        grepGroupOrder.push(key);
      }
      grepGroups.get(key)!.push(tc);
    }
  }

  // Now rebuild a deduplicated pending list, replacing redundant same-path greps
  const deduped: ToolCall[] = [];
  const originalToDeduped = new Map<number, number>(); // orig idx → deduped idx
  const consumed = new Set<string>(); // tc.id

  for (let i = 0; i < pending.length; i++) {
    const tc = pending[i]!;
    const n = tc.name.toLowerCase();

    if (n === "grep") {
      const path = tc.input["path"] ?? tc.input["file_path"] ?? tc.input["directory"] ?? "__global";
      const key = `grep:${path}`;
      const group = grepGroups.get(key);

      if (group && group.length > 1 && !consumed.has(key + ":done")) {
        // Merge: combine all patterns for this group into one call
        const patterns = group
          .map((g) => {
            const p = g.input["pattern"] ?? g.input["regex"] ?? g.input["query"];
            return typeof p === "string" ? p : "";
          })
          .filter(Boolean);

        const mergedPattern = patterns.length > 1 ? `(?:${patterns.join("|")})` : patterns[0] ?? "";

        const merged: ToolCall = {
          id: `merged-grep-${seq}-${path}`,
          name: "grep",
          input: {
            ...group[0]!.input,
            pattern: mergedPattern,
          },
        };

        const dedupedIdx = deduped.length;
        deduped.push(merged);

        // Map all originals in this group to this merged call
        for (const g of group) {
          const origIdx = pending.findIndex((p) => p.id === g.id);
          if (origIdx !== -1) originalToDeduped.set(origIdx, dedupedIdx);
          consumed.add(g.id);
        }
        consumed.add(key + ":done");
      } else if (!consumed.has(tc.id)) {
        // Already handled (part of a group that was merged above) or solo grep
        if (!consumed.has(tc.id)) {
          originalToDeduped.set(i, deduped.length);
          deduped.push(tc);
        }
      }
    } else {
      if (!consumed.has(tc.id)) {
        originalToDeduped.set(i, deduped.length);
        deduped.push(tc);
      }
    }
  }

  // ── Step 3: Rebuild DAG on deduped list ───────────────────────────────────
  const { nodes: dedupedNodes, edges: dedupedEdges } = buildDAG(deduped);
  const { waves: dedupedWaves } = topologicalWaves(dedupedNodes);

  // ── Step 4: Build BatchedToolCall list per wave ───────────────────────────
  const waveResults: BatchedToolCall[][] = [];
  for (let wi = 0; wi < dedupedWaves.length; wi++) {
    const wave = dedupedWaves[wi]!;
    const waveBatches = buildWaveBatches(wave, deduped, `b${seq}-w${wi}`);

    // Mark coalesced batches (tools that were grep-merged)
    for (const batch of waveBatches) {
      if (batch.tools.length === 1 && batch.tools[0]!.id.startsWith("merged-grep-")) {
        batch.batchType = "coalesced";
        const p = batch.tools[0]!.input["pattern"];
        batch.mergedPattern = typeof p === "string" ? p : undefined;
      }
    }

    waveResults.push(waveBatches);
  }

  // ── Step 5: Wire inter-wave dependencies ─────────────────────────────────
  // All batches in wave N depend on ALL batches in wave N-1 that write resources
  // consumed by this wave. For simplicity: every batch depends on every batch
  // from the immediately preceding wave (conservative but correct).
  const allBatches: BatchedToolCall[] = [];
  for (let wi = 0; wi < waveResults.length; wi++) {
    const wave = waveResults[wi]!;
    const prevWave = wi > 0 ? waveResults[wi - 1]! : [];
    const prevIds = prevWave.map((b) => b.batchId);

    for (const batch of wave) {
      batch.dependencies = [...prevIds];
      allBatches.push(batch);
    }
  }

  _updateStats(pending.length, allBatches);
  return allBatches;
}

// ---------------------------------------------------------------------------
// ASCII DAG printer for batched plans
// ---------------------------------------------------------------------------

/**
 * Render an ASCII DAG of a batched execution plan for debugging.
 *
 * Example output:
 * ```
 * Batched Execution Plan — 4 input calls → 2 batches (50.0% reduction)
 * ════════════════════════════════════════════════════════════════════════
 *  [b1-w0-spec-read]  speculative-read  parallelism=2  deps=[]
 *    ● Read(a.ts)
 *    ● Grep(src/)
 *  [b1-w1-unsafe-2]   single           parallelism=1  deps=[b1-w0-spec-read]
 *    ◆ Edit(b.ts)
 * ════════════════════════════════════════════════════════════════════════
 * ```
 */
export function visualiseBatchedPlan(batches: BatchedToolCall[], originalCount: number): string {
  if (batches.length === 0) return "Batched Execution Plan: (empty)";

  const reduction =
    originalCount > 0
      ? Math.round((1 - batches.length / originalCount) * 100 * 10) / 10
      : 0;

  const divider = "═".repeat(72);
  const lines: string[] = [
    `Batched Execution Plan — ${originalCount} input call${originalCount !== 1 ? "s" : ""} → ${batches.length} batch${batches.length !== 1 ? "es" : ""} (${reduction}% reduction)`,
    divider,
  ];

  for (const batch of batches) {
    const typeLabel = batch.batchType.padEnd(16);
    const deps = batch.dependencies.length > 0 ? `[${batch.dependencies.join(", ")}]` : "[]";
    lines.push(
      ` [${batch.batchId}]  ${typeLabel}  parallelism=${batch.estimatedParallelism}  deps=${deps}`
    );

    if (batch.mergedPattern) {
      lines.push(`    merged-pattern: ${batch.mergedPattern}`);
    }
    if (batch.batchReadPaths && batch.batchReadPaths.length > 0) {
      lines.push(`    batch-read paths: ${batch.batchReadPaths.slice(0, 5).join(", ")}${batch.batchReadPaths.length > 5 ? ` +${batch.batchReadPaths.length - 5} more` : ""}`);
    }

    for (const tc of batch.tools) {
      const accesses = extractResourceAccess(tc);
      const isWrite = accesses.some((a) => a.mode === "write");
      const bullet = isWrite ? "◆" : "●";
      const key =
        tc.input["file_path"] ??
        tc.input["path"] ??
        tc.input["command"] ??
        tc.input["pattern"] ??
        tc.input["query"] ??
        "";
      const label =
        typeof key === "string" && key
          ? `${tc.name}(${(key as string).split("/").pop() ?? key})`
          : tc.name;
      lines.push(`    ${bullet} ${label}`);
    }
  }

  lines.push(divider);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Format stats for display
// ---------------------------------------------------------------------------

export function formatBatchingStats(): string {
  const s = _stats;
  if (s.totalCalls === 0) return "No tool batching data recorded yet.";

  const lines: string[] = [
    "Tool Batching Statistics:",
    "",
    `  Total calls processed    : ${s.totalCalls}`,
    `  Batched groups emitted   : ${s.batchedGroups}`,
    `  Batch reduction          : ${s.batchReductionPct}%`,
    `  Round-trip savings       : ${s.roundTripSavings} call${s.roundTripSavings !== 1 ? "s" : ""} avoided`,
    `  Redundancy eliminated    : ${s.redundancyEliminated} duplicate${s.redundancyEliminated !== 1 ? "s" : ""}`,
    `  Speculative batches      : ${s.speculativeBatches}`,
    `  Avg parallelism/batch    : ${s.avgParallelism.toFixed(2)}`,
  ];

  return lines.join("\n");
}
