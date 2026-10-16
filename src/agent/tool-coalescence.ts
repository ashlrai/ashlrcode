/**
 * Tool-Call Coalescence — batch similar sequential tool invocations.
 *
 * Detects adjacent identical or near-identical tool calls and merges them into
 * a single batched call, reducing round-trips and token overhead.
 *
 * Primary use cases:
 *   - Multiple Bash calls on the same file with different grep patterns
 *     → merged into a single grep with alternation or `&&`-chained commands
 *   - Repeated Bash commands that touch overlapping file paths
 *     → merged with `&&` chaining so a single shell invocation runs all
 *
 * Architecture:
 *   1. coalesceToolCalls(calls) — public entry point; receives the raw batch,
 *      returns a CoalescedBatch describing merged groups + passthrough calls.
 *   2. CoalescedBatch.execute(registry, context, callbacks) — runs the merged
 *      calls and re-fans results back to their original ToolCall slots.
 *   3. CoalescenceStats — tracks saved tokens / latency estimates; exposed via
 *      getCoalescenceStats() for /stats display.
 *
 * Opt-out: set input.__noCoalesce = true on any ToolCall to skip it.
 */

import type { ToolCall, ToolResult } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { ToolExecutionResult } from "./tool-executor.ts";
import { executeToolCalls } from "./tool-executor.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Collect calls into a window of at most this many calls before flushing. */
export const COALESCENCE_MAX_WINDOW = 3;

/** Maximum Levenshtein distance ratio (0–1) to consider two commands "similar". */
export const COALESCENCE_SIMILARITY_THRESHOLD = 0.6;

/** Tools eligible for coalescence (only Bash for now; easily extended). */
export const COALESCIBLE_TOOLS = new Set(["Bash"]);

// ---------------------------------------------------------------------------
// Levenshtein distance (string similarity)
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Capped at max(a.length, b.length) for O(n*m) worst-case; strings longer
 * than 500 chars are truncated for performance.
 */
export function levenshtein(a: string, b: string): number {
  const MAX_LEN = 500;
  if (a.length > MAX_LEN) a = a.slice(0, MAX_LEN);
  if (b.length > MAX_LEN) b = b.slice(0, MAX_LEN);

  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two-row DP to save memory
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,        // insertion
        prev[j]! + 1,            // deletion
        prev[j - 1]! + cost      // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length]!;
}

/**
 * Similarity ratio between two strings in [0, 1].
 * 1.0 = identical, 0.0 = completely different.
 */
export function similarityRatio(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

// ---------------------------------------------------------------------------
// Path overlap detection
// ---------------------------------------------------------------------------

/**
 * Extract file-path-like tokens from a shell command string.
 * Returns a Set of normalised paths (lowercased, no trailing slash).
 */
export function extractPaths(command: string): Set<string> {
  const paths = new Set<string>();
  // Match absolute paths, relative ./paths, and bare filenames with extensions
  const RE = /(?:^|\s)((?:\/|\.\/|[A-Za-z0-9_.-]+\/)[^\s;|&><"'`]+|[A-Za-z0-9_.-]+\.[a-zA-Z]{1,6})/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(command)) !== null) {
    paths.add(m[1]!.replace(/\/+$/, "").toLowerCase());
  }
  return paths;
}

/**
 * Returns true when two path sets share at least one element.
 */
export function pathsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const p of a) {
    if (b.has(p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Coalescence decision
// ---------------------------------------------------------------------------

/**
 * Determine whether two Bash tool calls are candidates for coalescence.
 *
 * Criteria (all must hold):
 *   1. Same tool name.
 *   2. Neither call opts out via __noCoalesce.
 *   3. Command strings exceed similarity threshold OR paths overlap.
 */
export function areCoalescible(a: ToolCall, b: ToolCall): boolean {
  if (a.name !== b.name) return false;
  if (!COALESCIBLE_TOOLS.has(a.name)) return false;
  if (a.input.__noCoalesce || b.input.__noCoalesce) return false;

  const cmdA = typeof a.input.command === "string" ? a.input.command : "";
  const cmdB = typeof b.input.command === "string" ? b.input.command : "";

  // Fast path: identical commands
  if (cmdA === cmdB) return true;

  // Semantic similarity check
  const ratio = similarityRatio(cmdA, cmdB);
  if (ratio >= COALESCENCE_SIMILARITY_THRESHOLD) return true;

  // Path overlap check — even dissimilar commands on the same file coalesce
  const pathsA = extractPaths(cmdA);
  const pathsB = extractPaths(cmdB);
  if (pathsA.size > 0 && pathsB.size > 0 && pathsOverlap(pathsA, pathsB)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Merge strategy: multi-pattern grep vs && chaining
// ---------------------------------------------------------------------------

/** Regex that matches a standalone grep invocation (not piped from another command). */
const GREP_PATTERN_RE =
  /^(?:grep|rg)\s+(?:-[a-zA-Z]*\s+)*(?:-e\s+)?(['"]?)([^'"]+)\1\s+(.*)/;

/**
 * Attempt to merge an array of bash commands into a single grep with
 * alternation when they all look like `grep <pattern> <path>`.
 *
 * Returns null if the commands are not all simple greps on the same path.
 */
function tryMergeAsMultiGrep(commands: string[]): string | null {
  const matches = commands.map((cmd) => GREP_PATTERN_RE.exec(cmd.trim()));
  if (matches.some((m) => m === null)) return null;

  // All must target the same path(s)
  const paths = matches.map((m) => m![3]!.trim());
  if (new Set(paths).size !== 1) return null;

  // Extract patterns and merge with alternation
  const patterns = matches.map((m) => m![2]!.trim());
  const flags = matches[0]![0]!.match(/^(?:grep|rg)((\s+-[a-zA-Z]+)*)/)![1]?.trim() ?? "";

  const mergedPattern = patterns.map((p) => `(${p})`).join("|");
  const cmd = commands[0]!.trim();
  const tool = cmd.startsWith("rg") ? "rg" : "grep";
  const flagStr = flags ? `${flags} ` : "";
  return `${tool} ${flagStr}-E '${mergedPattern}' ${paths[0]}`;
}

/**
 * Merge an array of bash commands using `&&` chaining.
 * If they look like multi-pattern greps, uses grep alternation instead.
 */
export function mergeCommands(commands: string[]): string {
  if (commands.length === 1) return commands[0]!;

  // Try smarter grep merge first
  const grepMerge = tryMergeAsMultiGrep(commands);
  if (grepMerge !== null) return grepMerge;

  // Fall back to && chaining
  return commands.join(" && ");
}

// ---------------------------------------------------------------------------
// Result splitting
// ---------------------------------------------------------------------------

/**
 * Split the output of a `&&`-chained command back into per-command results.
 *
 * Strategy: inject a unique sentinel between commands when building the merged
 * command, then split on that sentinel in the output.  When coalescence uses
 * grep alternation (no sentinels) the full output is replicated to every
 * original call (the LLM gets all matches regardless of which pattern triggered).
 */
export const RESULT_SENTINEL_PREFIX = "__COALESCENCE_SENTINEL_";

/**
 * Build a merged command that wraps each sub-command with a sentinel echo so
 * output can be split back.  Only used for && chains, not grep alternation.
 */
export function buildSentinelCommand(commands: string[]): string {
  if (commands.length === 1) return commands[0]!;

  return commands
    .map((cmd, i) => `${cmd}; echo "${RESULT_SENTINEL_PREFIX}${i}"`)
    .join("; ");
}

/**
 * Split a sentinel-delimited output string into per-command results.
 *
 * @param output   - Raw stdout from the merged command.
 * @param count    - Number of original commands.
 * @returns Array of per-command result strings (length === count).
 */
export function splitSentinelOutput(output: string, count: number): string[] {
  if (count === 1) return [output];

  const results: string[] = new Array(count).fill("");
  let current = 0;
  const lines = output.split("\n");
  const buffer: string[] = [];

  for (const line of lines) {
    const sentinelMatch = line.match(new RegExp(`^${RESULT_SENTINEL_PREFIX}(\\d+)$`));
    if (sentinelMatch) {
      const idx = parseInt(sentinelMatch[1]!, 10);
      results[idx] = buffer.join("\n").trimEnd();
      buffer.length = 0;
      current = idx + 1;
      void current; // suppress unused warning
    } else {
      buffer.push(line);
    }
  }

  // Remaining buffer goes to the last slot if no sentinel was emitted
  if (buffer.length > 0 && current <= count - 1) {
    results[count - 1] = buffer.join("\n").trimEnd();
  }

  return results;
}

// ---------------------------------------------------------------------------
// CoalescedGroup — represents one merged "super-call"
// ---------------------------------------------------------------------------

export interface CoalescedGroup {
  /** Merged single ToolCall to be executed. */
  mergedCall: ToolCall;
  /** Original ToolCall objects in this group (preserves ordering). */
  originalCalls: ToolCall[];
  /**
   * "grep" when merged as a multi-pattern grep (output replicated to all),
   * "chain" when merged as an && chain (output split by sentinel).
   */
  mergeStrategy: "grep" | "chain" | "passthrough";
}

/**
 * Partition a sequential list of ToolCalls into CoalescedGroups.
 *
 * Window logic:
 *   - Walk the list; accumulate a run of coalescible calls (same tool, similar command).
 *   - Flush the run when: max window reached, tool changes, similarity drops, or opt-out.
 *   - Runs of length 1 are emitted as passthrough groups (no merge overhead).
 */
export function buildCoalescedGroups(calls: ToolCall[]): CoalescedGroup[] {
  const groups: CoalescedGroup[] = [];
  let window: ToolCall[] = [];

  const flush = () => {
    if (window.length === 0) return;

    if (window.length === 1) {
      groups.push({
        mergedCall: window[0]!,
        originalCalls: [window[0]!],
        mergeStrategy: "passthrough",
      });
      window = [];
      return;
    }

    const commands = window.map((tc) =>
      typeof tc.input.command === "string" ? tc.input.command : ""
    );

    // Try grep merge
    const grepMerge = tryMergeAsMultiGrep(commands);
    if (grepMerge !== null) {
      const mergedCall: ToolCall = {
        id: `coalesced_${window[0]!.id}`,
        name: window[0]!.name,
        input: { ...window[0]!.input, command: grepMerge },
      };
      groups.push({ mergedCall, originalCalls: [...window], mergeStrategy: "grep" });
    } else {
      // Sentinel-based && chain
      const sentinelCmd = buildSentinelCommand(commands);
      const mergedCall: ToolCall = {
        id: `coalesced_${window[0]!.id}`,
        name: window[0]!.name,
        input: { ...window[0]!.input, command: sentinelCmd },
      };
      groups.push({ mergedCall, originalCalls: [...window], mergeStrategy: "chain" });
    }

    window = [];
  };

  for (const tc of calls) {
    if (window.length === 0) {
      window.push(tc);
      continue;
    }

    const last = window[window.length - 1]!;
    const canExtend =
      window.length < COALESCENCE_MAX_WINDOW &&
      areCoalescible(last, tc);

    if (canExtend) {
      window.push(tc);
    } else {
      flush();
      window.push(tc);
    }
  }

  flush();
  return groups;
}

// ---------------------------------------------------------------------------
// CoalescenceStats
// ---------------------------------------------------------------------------

export interface CoalescenceStats {
  /** Total number of original calls that were merged into fewer batched calls. */
  mergedCalls: number;
  /** Number of merged super-calls actually executed. */
  batchedCalls: number;
  /** Calls saved (mergedCalls - batchedCalls). */
  callsSaved: number;
  /** Estimated tokens saved (rough: 30 tokens per saved call). */
  estimatedTokensSaved: number;
  /** Approximate latency saved in ms (rough: 100 ms per saved round-trip). */
  estimatedLatencySavedMs: number;
}

const _stats = {
  mergedCalls: 0,
  batchedCalls: 0,
};

/** Record a coalescence event. */
function recordCoalescence(originalCount: number, batchedCount: number): void {
  _stats.mergedCalls += originalCount;
  _stats.batchedCalls += batchedCount;
}

/** Get cumulative coalescence statistics. */
export function getCoalescenceStats(): CoalescenceStats {
  const callsSaved = Math.max(0, _stats.mergedCalls - _stats.batchedCalls);
  return {
    mergedCalls: _stats.mergedCalls,
    batchedCalls: _stats.batchedCalls,
    callsSaved,
    estimatedTokensSaved: callsSaved * 30,
    estimatedLatencySavedMs: callsSaved * 100,
  };
}

/** Reset stats (for testing). */
export function resetCoalescenceStats(): void {
  _stats.mergedCalls = 0;
  _stats.batchedCalls = 0;
}

/** Format coalescence stats for /stats display. */
export function formatCoalescenceStats(): string {
  const s = getCoalescenceStats();
  if (s.mergedCalls === 0) return "tool coalescence: no batches recorded";
  return [
    "Tool Coalescence:",
    `  Merged calls    : ${s.mergedCalls} → ${s.batchedCalls} batched`,
    `  Calls saved     : ${s.callsSaved}`,
    `  Tokens saved ~  : ${s.estimatedTokensSaved}`,
    `  Latency saved ~ : ${s.estimatedLatencySavedMs} ms`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Coalesce a list of ToolCalls and execute them with optional parallelism.
 *
 * Drop-in replacement for executeToolCalls() when coalescence is desired.
 * Non-Bash tools and opt-out calls pass through unchanged.
 *
 * Steps:
 *   1. Partition calls into CoalescedGroups.
 *   2. Execute each group's mergedCall via executeToolCalls().
 *   3. Fan out merged results back to individual ToolExecutionResults.
 *   4. Re-sort to restore original call order.
 */
export async function executeWithCoalescence(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  context: ToolContext,
  callbacks?: {
    onToolStart?: (name: string, input: Record<string, unknown>) => void;
    onToolEnd?: (name: string, result: string, isError: boolean) => void;
  },
  totalContextTokens = 0
): Promise<ToolExecutionResult[]> {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) {
    return executeToolCalls(toolCalls, registry, context, callbacks, totalContextTokens);
  }

  const groups = buildCoalescedGroups(toolCalls);

  // Record stats
  const originalTotal = toolCalls.length;
  const batchedTotal = groups.length;
  if (batchedTotal < originalTotal) {
    recordCoalescence(originalTotal, batchedTotal);
  }

  // Execute one merged call per group
  const mergedCalls = groups.map((g) => g.mergedCall);
  const mergedResults = await executeToolCalls(
    mergedCalls,
    registry,
    context,
    callbacks,
    totalContextTokens
  );

  // Build a lookup from mergedCall.id → execution result
  const mergedResultMap = new Map(mergedResults.map((r) => [r.toolCallId, r]));

  // Fan out results back to original calls
  const finalResults: ToolExecutionResult[] = [];

  for (const group of groups) {
    const mergedResult = mergedResultMap.get(group.mergedCall.id);
    if (!mergedResult) continue;

    if (group.mergeStrategy === "passthrough" || group.originalCalls.length === 1) {
      // Passthrough: restore original toolCallId
      finalResults.push({
        ...mergedResult,
        toolCallId: group.originalCalls[0]!.id,
        name: group.originalCalls[0]!.name,
        input: group.originalCalls[0]!.input,
      });
      continue;
    }

    if (group.mergeStrategy === "grep") {
      // Grep alternation: replicate full output to every original call
      for (const orig of group.originalCalls) {
        finalResults.push({
          ...mergedResult,
          toolCallId: orig.id,
          name: orig.name,
          input: orig.input,
        });
      }
      continue;
    }

    // Chain strategy: split sentinel output
    const subResults = splitSentinelOutput(
      mergedResult.result,
      group.originalCalls.length
    );

    for (let i = 0; i < group.originalCalls.length; i++) {
      const orig = group.originalCalls[i]!;
      finalResults.push({
        toolCallId: orig.id,
        name: orig.name,
        input: orig.input,
        result: subResults[i] ?? "",
        isError: mergedResult.isError,
      });
    }
  }

  // Restore original ordering
  const orderMap = new Map(toolCalls.map((tc, i) => [tc.id, i]));
  finalResults.sort(
    (a, b) => (orderMap.get(a.toolCallId) ?? 0) - (orderMap.get(b.toolCallId) ?? 0)
  );

  return finalResults;
}
