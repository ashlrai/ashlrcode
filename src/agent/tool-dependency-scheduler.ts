/**
 * Agent Parallel Execution Plan Cache with Dependency Scheduler
 *
 * Builds a dependency-aware DAG from tool call inputs/outputs so the executor
 * can run truly independent tools in parallel — beyond the coarse
 * isConcurrencySafe() flag — while preserving data-dependency order.
 *
 * Algorithm:
 * 1. Static analysis: extract file/resource "reads" and "writes" from each
 *    tool call's input.
 * 2. Build a directed acyclic graph (DAG): add an edge A → B whenever tool B
 *    reads a resource that tool A writes (write-after-write also serialises).
 * 3. Topological sort (Kahn's algorithm) to emit ordered "waves" — tools in
 *    the same wave have no mutual dependencies and can run in parallel.
 * 4. Cache the execution plan (DAG + waves) keyed by a hash of the tool-call
 *    fingerprints so identical patterns skip re-analysis.
 * 5. Record per-wave timings for replay / latency visibility.
 *
 * Integration point: call `buildExecutionPlan()` in tool-executor.ts before
 * dispatching tool calls.  The returned `ExecutionPlan.waves` replaces the
 * old safe/unsafe partition with fine-grained dependency waves.
 */

import { createHash } from "crypto";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Resource access model
// ---------------------------------------------------------------------------

/** A resource (file path, URL, env var, etc.) accessed by a tool call. */
export interface ResourceAccess {
  /** Normalised resource identifier, e.g. "/abs/path/file.ts". */
  resource: string;
  mode: "read" | "write";
}

// ---------------------------------------------------------------------------
// DAG node / edge types
// ---------------------------------------------------------------------------

export interface DAGNode {
  /** Index into the original toolCalls array. */
  index: number;
  toolCallId: string;
  toolName: string;
  /** Resources this node reads. */
  reads: Set<string>;
  /** Resources this node writes. */
  writes: Set<string>;
  /** Indices of nodes that must complete before this one starts. */
  deps: Set<number>;
  /** Indices of nodes that depend on this one. */
  dependents: Set<number>;
}

export interface DAGEdge {
  /** Producer node index. */
  from: number;
  /** Consumer node index. */
  to: number;
  /** Shared resource that created this dependency. */
  resource: string;
}

// ---------------------------------------------------------------------------
// Execution plan
// ---------------------------------------------------------------------------

/**
 * A "wave" is a group of tool-call indices that have no mutual dependencies
 * and can therefore be executed in parallel.
 */
export type Wave = number[];

export interface ExecutionPlan {
  /** Fingerprint of the input tool calls (used as cache key). */
  fingerprint: string;
  nodes: DAGNode[];
  edges: DAGEdge[];
  /** Ordered list of parallel waves. Execute waves sequentially, but all
   *  indices within a wave in parallel. */
  waves: Wave[];
  /** True when the scheduler detected a cycle (falls back to serial execution). */
  hasCycle: boolean;
  /** Wall-clock timings recorded for each wave during execution. */
  waveTimingsMs: number[];
}

// ---------------------------------------------------------------------------
// Static resource extractor
// ---------------------------------------------------------------------------

/**
 * Extract the resources a tool call reads and writes based purely on its
 * name and input fields — no runtime information required.
 *
 * Convention-based rules cover the standard ashlrcode tool vocabulary.
 * Unknown tools with no recognised input keys are treated as writing a
 * synthetic `tool:<name>` resource so they serialise with each other but
 * remain parallel with independent read-only tools.
 */
export function extractResourceAccess(tc: ToolCall): ResourceAccess[] {
  const accesses: ResourceAccess[] = [];
  const n = tc.name.toLowerCase();

  // ----- Read-only tools -----
  if (
    n === "read" ||
    n === "fileread" ||
    n === "diff" ||
    n === "grep" ||
    n === "glob" ||
    n === "ls"
  ) {
    // file_path, path, pattern target, old_file_path, new_file_path
    for (const key of ["file_path", "path", "old_file_path", "new_file_path"]) {
      const v = tc.input[key];
      if (typeof v === "string" && v) {
        accesses.push({ resource: normalisePath(v), mode: "read" });
      }
    }
    return accesses;
  }

  // ----- Write tools -----
  if (n === "edit" || n === "fileedit" || n === "write" || n === "filewrite") {
    const fp = tc.input.file_path ?? tc.input.path;
    if (typeof fp === "string" && fp) {
      accesses.push({ resource: normalisePath(fp), mode: "write" });
      // Also implicitly reads the file before editing
      if (n === "edit" || n === "fileedit") {
        accesses.push({ resource: normalisePath(fp), mode: "read" });
      }
    }
    return accesses;
  }

  // ----- Bash / shell — extract file arguments heuristically -----
  if (n === "bash" || n === "shell" || n === "powershell") {
    const cmd = tc.input.command ?? tc.input.cmd ?? "";
    if (typeof cmd === "string") {
      // Heuristic: grab absolute/relative paths mentioned in the command.
      const paths = extractPathsFromCommand(cmd);
      for (const p of paths) {
        // If command contains a redirect (> or >>) treat as write; otherwise read.
        const isWrite = />\s*["']?\S/.test(cmd) && cmd.includes(p);
        accesses.push({ resource: normalisePath(p), mode: isWrite ? "write" : "read" });
      }
      if (paths.length === 0) {
        // No identifiable paths — treat as write to opaque "bash" resource so
        // concurrent bash calls stay serialised (safest default).
        accesses.push({ resource: "tool:bash", mode: "write" });
      }
    }
    return accesses;
  }

  // ----- TodoWrite -----
  if (n === "todowrite" || n === "todo_write") {
    accesses.push({ resource: "tool:todo", mode: "write" });
    return accesses;
  }

  // ----- WebFetch / WebSearch — keyed by URL -----
  if (n === "webfetch" || n === "web_fetch") {
    const url = tc.input.url ?? tc.input.href;
    if (typeof url === "string") {
      accesses.push({ resource: `url:${url}`, mode: "read" });
    }
    return accesses;
  }

  if (n === "websearch" || n === "web_search") {
    const q = tc.input.query ?? tc.input.q;
    if (typeof q === "string") {
      accesses.push({ resource: `search:${q}`, mode: "read" });
    }
    return accesses;
  }

  // ----- Notebook tools -----
  if (n === "notebookedit" || n === "notebook_edit") {
    const nb = tc.input.notebook_path ?? tc.input.path;
    if (typeof nb === "string" && nb) {
      accesses.push({ resource: normalisePath(nb), mode: "write" });
      accesses.push({ resource: normalisePath(nb), mode: "read" });
    }
    return accesses;
  }

  // ----- Generic fallback: unknown write-ish tool -----
  // Check common "output" field names; if a file_path is present assume a write.
  const maybeWrite = tc.input.file_path ?? tc.input.output_path ?? tc.input.path;
  if (typeof maybeWrite === "string" && maybeWrite) {
    accesses.push({ resource: normalisePath(maybeWrite), mode: "write" });
    return accesses;
  }

  // No recognisable resource — treat as an isolated opaque action keyed by
  // tool name so two calls to the same unknown tool serialise with each other.
  accesses.push({ resource: `tool:${tc.name}`, mode: "write" });
  return accesses;
}

/** Normalise a file path for use as a resource key. */
function normalisePath(p: string): string {
  // Remove trailing slashes, collapse double slashes, lowercase drive letters on Windows
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .replace(/^([A-Z]):/, (_, d: string) => d.toLowerCase() + ":");
}

/** Extract file-path-looking tokens from a shell command string. */
function extractPathsFromCommand(cmd: string): string[] {
  const results: string[] = [];
  // Match absolute POSIX paths or ./relative paths
  const re = /(?:^|\s)((?:\/|\.\/|\.\.\/)[^\s"'`;&|>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const p = m[1]!.replace(/['"`;,)]+$/, ""); // strip trailing punctuation
    if (p.length > 1) results.push(p);
  }
  return results;
}

// ---------------------------------------------------------------------------
// DAG construction
// ---------------------------------------------------------------------------

/**
 * Build a DAG from a list of tool calls.
 *
 * Two tools are ordered (A before B) when:
 * - A writes a resource that B reads (read-after-write)
 * - A writes a resource that B also writes (write-after-write)
 *
 * Read-after-read has no dependency; multiple readers run in parallel.
 */
export function buildDAG(toolCalls: ToolCall[]): { nodes: DAGNode[]; edges: DAGEdge[] } {
  const nodes: DAGNode[] = toolCalls.map((tc, i) => {
    const accesses = extractResourceAccess(tc);
    const reads = new Set(accesses.filter((a) => a.mode === "read").map((a) => a.resource));
    const writes = new Set(accesses.filter((a) => a.mode === "write").map((a) => a.resource));
    return {
      index: i,
      toolCallId: tc.id,
      toolName: tc.name,
      reads,
      writes,
      deps: new Set<number>(),
      dependents: new Set<number>(),
    };
  });

  const edges: DAGEdge[] = [];

  for (let b = 0; b < nodes.length; b++) {
    const nodeB = nodes[b]!;
    for (let a = 0; a < b; a++) {
      const nodeA = nodes[a]!;

      // Find shared resources that create a dependency A → B
      for (const w of nodeA.writes) {
        if (nodeB.reads.has(w) || nodeB.writes.has(w)) {
          nodeA.dependents.add(b);
          nodeB.deps.add(a);
          edges.push({ from: a, to: b, resource: w });
          break; // one edge per (a, b) pair is enough
        }
      }
      // Also check: B writes something A reads — means B must run after A
      // if A already established a write dependency. But in a strict left-to-right
      // model we only add forward edges (a < b already handled above).
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Topological sort → wave decomposition (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Run Kahn's algorithm on the DAG and return waves of parallel-safe indices.
 *
 * Returns `{ waves, hasCycle }`.  On cycle detection `hasCycle` is true and
 * `waves` contains a single wave with all indices in original order (safe
 * serial fallback).
 */
export function topologicalWaves(nodes: DAGNode[]): { waves: Wave[]; hasCycle: boolean } {
  const n = nodes.length;
  // Clone in-degree from deps
  const inDegree = nodes.map((nd) => nd.deps.size);
  const waves: Wave[] = [];
  let processed = 0;

  while (processed < n) {
    // Collect all nodes with zero in-degree (ready to run)
    const wave: Wave = [];
    for (let i = 0; i < n; i++) {
      if (inDegree[i] === 0) {
        wave.push(i);
      }
    }

    if (wave.length === 0) {
      // Cycle detected — return all remaining nodes as a single serial wave
      const remaining: Wave = [];
      for (let i = 0; i < n; i++) {
        if (inDegree[i]! > 0) remaining.push(i);
      }
      waves.push(remaining);
      return { waves, hasCycle: true };
    }

    waves.push(wave);

    // Remove these nodes and reduce in-degrees of their dependents
    for (const idx of wave) {
      inDegree[idx] = -1; // mark as processed
      for (const dep of nodes[idx]!.dependents) {
        inDegree[dep]!--;
      }
    }
    processed += wave.length;
  }

  return { waves, hasCycle: false };
}

// ---------------------------------------------------------------------------
// Plan cache
// ---------------------------------------------------------------------------

/** Max cached plans (LRU eviction). */
const PLAN_CACHE_MAX = 200;

interface CachedPlan {
  plan: ExecutionPlan;
  lastUsed: number;
}

const _planCache = new Map<string, CachedPlan>();

/**
 * Compute a stable fingerprint for a list of tool calls.
 * Two lists are identical when they have the same tool names in the same order
 * with the same (semantically significant) inputs.
 */
export function planFingerprint(toolCalls: ToolCall[]): string {
  const parts = toolCalls.map((tc) => {
    // Sort input keys for stability
    const sortedInput: Record<string, unknown> = {};
    for (const k of Object.keys(tc.input).sort()) {
      sortedInput[k] = tc.input[k];
    }
    return `${tc.name}:${JSON.stringify(sortedInput)}`;
  });
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function evictLRU(): void {
  if (_planCache.size < PLAN_CACHE_MAX) return;
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [k, v] of _planCache) {
    if (v.lastUsed < oldestTime) {
      oldestTime = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) _planCache.delete(oldestKey);
}

/** Retrieve a cached plan, or null on miss. */
export function getCachedPlan(fingerprint: string): ExecutionPlan | null {
  const entry = _planCache.get(fingerprint);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.plan;
}

/** Store a plan in the cache. */
export function cachePlan(plan: ExecutionPlan): void {
  evictLRU();
  _planCache.set(plan.fingerprint, { plan, lastUsed: Date.now() });
}

/** Clear the plan cache (for testing / coordinator turn boundary). */
export function clearPlanCache(): void {
  _planCache.clear();
}

/** Return the number of cached plans. */
export function planCacheSize(): number {
  return _planCache.size;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Build (or retrieve from cache) an execution plan for `toolCalls`.
 *
 * Callers should iterate `plan.waves` sequentially and execute all indices
 * within each wave in parallel.  Record actual wave durations via
 * `recordWaveTiming()` for latency telemetry.
 */
export function buildExecutionPlan(toolCalls: ToolCall[]): ExecutionPlan {
  if (toolCalls.length === 0) {
    return {
      fingerprint: "",
      nodes: [],
      edges: [],
      waves: [],
      hasCycle: false,
      waveTimingsMs: [],
    };
  }

  const fingerprint = planFingerprint(toolCalls);

  const cached = getCachedPlan(fingerprint);
  if (cached) {
    // Return a shallow clone so callers can mutate waveTimingsMs independently
    return { ...cached, waveTimingsMs: [] };
  }

  const { nodes, edges } = buildDAG(toolCalls);
  const { waves, hasCycle } = topologicalWaves(nodes);

  const plan: ExecutionPlan = {
    fingerprint,
    nodes,
    edges,
    waves,
    hasCycle,
    waveTimingsMs: [],
  };

  cachePlan(plan);
  return { ...plan, waveTimingsMs: [] };
}

/**
 * Record the wall-clock time for a wave execution.
 * Call this after each wave completes to populate `plan.waveTimingsMs`.
 */
export function recordWaveTiming(plan: ExecutionPlan, waveIndex: number, ms: number): void {
  plan.waveTimingsMs[waveIndex] = ms;
}

// ---------------------------------------------------------------------------
// Visualisation helper (/plan show-parallel)
// ---------------------------------------------------------------------------

/**
 * Render a human-readable ASCII visualisation of the execution DAG and waves.
 *
 * Example output:
 * ```
 * Execution Plan (3 waves, 0 edges):
 *   Wave 0 [parallel]: Read(a.ts), Read(b.ts)
 *   Wave 1 [parallel]: Edit(a.ts)
 *   Wave 2 [serial]:   Bash(deploy)
 * ```
 */
export function visualiseExecutionPlan(plan: ExecutionPlan, toolCalls: ToolCall[]): string {
  if (plan.waves.length === 0) return "Execution Plan: (empty)";

  const lines: string[] = [
    `Execution Plan (${plan.waves.length} wave${plan.waves.length !== 1 ? "s" : ""}, ${plan.edges.length} dep${plan.edges.length !== 1 ? "s" : ""}):`,
  ];

  if (plan.hasCycle) {
    lines.push("  WARNING: dependency cycle detected — falling back to serial execution");
  }

  for (let wi = 0; wi < plan.waves.length; wi++) {
    const wave = plan.waves[wi]!;
    const mode = wave.length > 1 ? "parallel" : "serial  ";
    const toolLabels = wave.map((idx) => {
      const tc = toolCalls[idx];
      if (!tc) return `?[${idx}]`;
      const key = tc.input.file_path ?? tc.input.path ?? tc.input.command ?? tc.input.query ?? "";
      const label = typeof key === "string" && key ? `${tc.name}(${key.split("/").pop() ?? key})` : tc.name;
      return label;
    });
    const timing = plan.waveTimingsMs[wi] !== undefined ? ` — ${Math.round(plan.waveTimingsMs[wi]!)}ms` : "";
    lines.push(`  Wave ${wi} [${mode}]: ${toolLabels.join(", ")}${timing}`);
  }

  if (plan.edges.length > 0) {
    lines.push("  Dependencies:");
    for (const e of plan.edges) {
      const from = toolCalls[e.from]?.name ?? `?[${e.from}]`;
      const to = toolCalls[e.to]?.name ?? `?[${e.to}]`;
      lines.push(`    ${from} → ${to}  [${e.resource}]`);
    }
  }

  return lines.join("\n");
}
