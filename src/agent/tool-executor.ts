/**
 * Streaming Tool Executor — parallel execution for concurrency-safe tools.
 *
 * Partitions tool calls by isConcurrencySafe():
 * - Safe tools run in parallel via Promise.all()
 * - Unsafe tools run sequentially
 *
 * Also exports streamResultCompressor() which wraps tool.call() and yields
 * delta events, truncating large outputs mid-stream with inline summaries so
 * LLM context stays bounded.
 */

import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { Tool } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";
import type { SpeculationCache } from "./speculation.ts";
import type { PersistentSpeculationCache } from "./speculation.ts";
import { trackFileModification } from "./verification.ts";
import { recordStep } from "./time-travel.ts";
import {
  recordToolSelection,
  recordSpeculationHit,
  recordSpeculationMiss,
  recordDedupHit,
  currentTurn,
} from "./intent-trace.ts";
import { getBudgetAllocator } from "./budget-allocator.ts";
import { getAgentContext } from "./async-context.ts";
import { DedupCache, getGlobalDedupCache } from "./dedup-cache.ts";
import {
  getToolMetrics as getToolMetricsSingleton,
  resolveCompressionOptions,
} from "./tool-metrics.ts";
export type { CompressorConfig } from "./tool-metrics.ts";

// ---------------------------------------------------------------------------
// Streaming result compression
// ---------------------------------------------------------------------------

/** Default: emit first 15 KB verbatim, then start summarising. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 15_360; // 15 KB

/** Default: summarise every subsequent 2 KB chunk. */
export const DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD = 2_048; // 2 KB

export interface CompressorOptions {
  /** Byte limit for the verbatim head section. Default: 15 KB. */
  maxBytes?: number;
  /** Size of each summary chunk after the head. Default: 2 KB. */
  chunkSummaryThreshold?: number;
  /**
   * Pre-computed predicted output size in bytes.  When provided,
   * streamResultCompressor() adapts its thresholds via resolveCompressionOptions()
   * before executing the tool.  When omitted the raw CompressorOptions values
   * (or defaults) are used unchanged.
   */
  predictedSize?: number;
}

export interface CompressorEvent {
  type: "delta";
  text: string;
}

/**
 * Summarise a chunk of tool output into a compact inline annotation.
 *
 * This is intentionally a pure, synchronous heuristic (no LLM call) so it
 * never blocks the stream.  Pattern detection covers the most common large
 * outputs: stack-traces, grep results, file listings, and generic repetitive
 * text.
 */
export function summariseChunk(chunk: string): string {
  const lines = chunk.split("\n");
  const lineCount = lines.length;

  // Detect dominant pattern
  let pattern = "text";
  const errorLike = lines.filter((l) => /\b(error|Error|ERROR|exception|Exception|EXCEPTION|traceback|Traceback)\b/.test(l)).length;
  const atLike = lines.filter((l) => /^\s+at /.test(l)).length;
  const grepLike = lines.filter((l) => /^[^:]+:\d+:/.test(l)).length;
  const listLike = lines.filter((l) => /^[-*+]\s/.test(l) || /^\s*\d+\.\s/.test(l)).length;
  const pathLike = lines.filter((l) => /^(\/|\.\/|[A-Za-z]:\\)/.test(l.trim())).length;

  if (errorLike + atLike > lineCount * 0.3) pattern = "stack trace";
  else if (grepLike > lineCount * 0.5) pattern = "grep matches";
  else if (pathLike > lineCount * 0.5) pattern = "file listing";
  else if (listLike > lineCount * 0.4) pattern = "list items";

  return `[SUMMARY: ${lineCount} lines, pattern "${pattern}" detected]`;
}

/**
 * Wrap a tool's call() and yield delta events for the caller to forward to
 * the rendering layer (e.g. renderMarkdownDelta).
 *
 * Behaviour:
 * - The first `maxBytes` of the result are yielded verbatim as delta events.
 * - Every subsequent `chunkSummaryThreshold` bytes are replaced with a
 *   `[SUMMARY: …]` annotation, keeping the overall result well under
 *   `maxBytes + a few hundred bytes of annotations`.
 * - If the result is within `maxBytes`, it is yielded as a single delta
 *   with no modification.
 *
 * @param tool   - The tool whose call() we are wrapping.
 * @param input  - Raw tool input forwarded to call().
 * @param context - Tool execution context.
 * @param opts   - Optional byte thresholds.
 * @returns      - Final (compressed) result string and an async iterable of
 *                 CompressorEvents for streaming.
 */
export async function* streamResultCompressor(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolContext,
  opts?: CompressorOptions
): AsyncGenerator<CompressorEvent, string, unknown> {
  // ---------------------------------------------------------------------------
  // Adaptive threshold resolution
  // ---------------------------------------------------------------------------
  // If a predictedSize was supplied (or we can derive one from ToolMetrics),
  // let resolveCompressionOptions() pick the right maxBytes / chunkSize.
  // Explicit opts.maxBytes / opts.chunkSummaryThreshold override the adaptive
  // values when both are present (handled inside resolveCompressionOptions).
  let maxBytes: number;
  let chunkSize: number;

  const predictedSize =
    opts?.predictedSize ??
    getToolMetricsSingleton().predictOutputSize(tool.name, input);

  const resolved = resolveCompressionOptions(
    {
      maxBytes: opts?.maxBytes,
      chunkSummaryThreshold: opts?.chunkSummaryThreshold,
    },
    predictedSize
  );
  maxBytes = resolved.maxBytes;
  chunkSize = resolved.chunkSummaryThreshold;

  // Execute the tool to completion (tools don't natively stream text yet).
  const execStart = performance.now();
  const rawResult: string = await tool.call(input, context);
  const execDurationMs = performance.now() - execStart;

  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(rawResult).length;

  // Record execution stats so future predictions improve over time.
  getToolMetricsSingleton().record(tool.name, rawBytes, execDurationMs);

  if (rawBytes <= maxBytes) {
    // Fast path: small result — yield as-is.
    yield { type: "delta", text: rawResult };
    return rawResult;
  }

  // Large result: emit verbatim head then summarise remaining chunks.
  // We work with the string directly, using character positions as an
  // approximation of byte positions (safe for ASCII-dominant tool output;
  // for multi-byte chars the verbatim section may be slightly under maxBytes).
  const verbatimEnd = approximateCharOffset(rawResult, maxBytes);
  const head = rawResult.slice(0, verbatimEnd);
  const tail = rawResult.slice(verbatimEnd);

  // Yield verbatim head
  yield { type: "delta", text: head };

  // Yield compressed tail in chunks
  const summaries: string[] = [];
  let offset = 0;
  while (offset < tail.length) {
    const chunkEnd = approximateCharOffset(tail, chunkSize, offset);
    const chunk = tail.slice(offset, chunkEnd);
    const summary = summariseChunk(chunk);
    summaries.push(summary);
    yield { type: "delta", text: "\n" + summary };
    offset = chunkEnd;
  }

  const finalResult = head + "\n" + summaries.join("\n");
  return finalResult;
}

/**
 * Convenience wrapper: runs streamResultCompressor() to completion and
 * returns the final compressed string without streaming.
 */
export async function compressToolResult(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolContext,
  opts?: CompressorOptions
): Promise<string> {
  const gen = streamResultCompressor(tool, input, context, opts);
  let result = "";
  while (true) {
    const step = await gen.next();
    if (step.done) {
      // step.value is the return value (final compressed string)
      result = step.value ?? result;
      break;
    }
    // Accumulate deltas in case caller ignores the return value
    result += (step.value as CompressorEvent).text;
  }
  return result;
}

/**
 * Return the character index in `str` that corresponds approximately to
 * `targetBytes` UTF-8 bytes from `startChar`.
 *
 * For ASCII this is exact.  For multi-byte content it errs on the side of
 * returning fewer characters (never more than `targetBytes` bytes).
 */
function approximateCharOffset(str: string, targetBytes: number, startChar = 0): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  let i = startChar;
  while (i < str.length) {
    const charBytes = encoder.encode(str[i]).length;
    if (bytes + charBytes > targetBytes) break;
    bytes += charBytes;
    i++;
  }
  return i;
}

// Monotonic per-session step index for the time-travel timeline.
const _ttStepIndex = new Map<string, number>();

// ---------------------------------------------------------------------------
// Module-level speculation cache (set from repl startup)
// ---------------------------------------------------------------------------

let _speculationCache: SpeculationCache | null = null;

export function setSpeculationCache(cache: SpeculationCache): void {
  _speculationCache = cache;
}

export function getSpeculationCache(): SpeculationCache | null {
  return _speculationCache;
}

// ---------------------------------------------------------------------------
// Module-level persistent speculation cache (cross-provider, cross-session)
// ---------------------------------------------------------------------------

let _persistentCache: PersistentSpeculationCache | null = null;

export function setPersistentSpeculationCache(cache: PersistentSpeculationCache): void {
  _persistentCache = cache;
}

export function getPersistentSpeculationCache(): PersistentSpeculationCache | null {
  return _persistentCache;
}

// ---------------------------------------------------------------------------
// Tool execution metrics — cumulative timing and success tracking
// ---------------------------------------------------------------------------

interface ToolMetric {
  name: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

const _toolMetrics = new Map<string, ToolMetric>();

/** Record a tool execution for metrics tracking. */
function recordToolMetric(name: string, durationMs: number, isError: boolean): void {
  const existing = _toolMetrics.get(name) ?? {
    name,
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    minDurationMs: Infinity,
    maxDurationMs: 0,
  };

  existing.calls++;
  if (isError) existing.errors++;
  existing.totalDurationMs += durationMs;
  existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
  existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);

  _toolMetrics.set(name, existing);
}

/** Get all tool execution metrics (sorted by total calls descending). */
export function getToolMetrics(): ToolMetric[] {
  return Array.from(_toolMetrics.values())
    .sort((a, b) => b.calls - a.calls);
}

/** Format tool metrics for display. */
export function formatToolMetrics(): string {
  const metrics = getToolMetrics();
  if (metrics.length === 0) return "No tool calls recorded.";

  const lines: string[] = ["Tool Execution Metrics:"];
  const totalCalls = metrics.reduce((s, m) => s + m.calls, 0);
  const totalDuration = metrics.reduce((s, m) => s + m.totalDurationMs, 0);

  lines.push(`  Total: ${totalCalls} calls, ${formatMs(totalDuration)} total`);
  lines.push("");

  for (const m of metrics.slice(0, 15)) {
    const avgMs = m.calls > 0 ? m.totalDurationMs / m.calls : 0;
    const errorRate = m.calls > 0 ? Math.round((m.errors / m.calls) * 100) : 0;
    lines.push(
      `  ${m.name.padEnd(16)} ${String(m.calls).padStart(4)} calls · avg ${formatMs(avgMs)} · ${errorRate}% err`
    );
  }

  return lines.join("\n");
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Reset metrics (for testing). */
export function resetToolMetrics(): void {
  _toolMetrics.clear();
}

export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/**
 * Execute tool calls with optimal parallelism.
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  context: ToolContext,
  callbacks?: {
    onToolStart?: (name: string, input: Record<string, unknown>) => void;
    onToolEnd?: (name: string, result: string, isError: boolean) => void;
  },
  /** Total context window size in tokens — used by the budget allocator. Pass 0 when unknown. */
  totalContextTokens = 0
): Promise<ToolExecutionResult[]> {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) {
    return [await executeSingle(toolCalls[0]!, registry, context, callbacks, totalContextTokens)];
  }

  // Partition by concurrency safety
  const safe: ToolCall[] = [];
  const unsafe: ToolCall[] = [];

  for (const tc of toolCalls) {
    const tool = registry.get(tc.name);
    if (tool?.isConcurrencySafe()) {
      safe.push(tc);
    } else {
      unsafe.push(tc);
    }
  }

  const results: ToolExecutionResult[] = [];

  // Run safe tools in parallel
  if (safe.length > 0) {
    const parallelResults = await Promise.all(
      safe.map((tc) => executeSingle(tc, registry, context, callbacks, totalContextTokens))
    );
    results.push(...parallelResults);
  }

  // Run unsafe tools sequentially
  for (const tc of unsafe) {
    const result = await executeSingle(tc, registry, context, callbacks, totalContextTokens);
    results.push(result);
  }

  // Restore original tool call ordering
  const orderMap = new Map(toolCalls.map((tc, i) => [tc.id, i]));
  results.sort((a, b) => (orderMap.get(a.toolCallId) ?? 0) - (orderMap.get(b.toolCallId) ?? 0));

  return results;
}

/** Recent tool calls tracked for speculation heuristics. */
const recentToolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string }> = [];
const MAX_RECENT = 10;

async function executeSingle(
  tc: ToolCall,
  registry: ToolRegistry,
  context: ToolContext,
  callbacks?: {
    onToolStart?: (name: string, input: Record<string, unknown>) => void;
    onToolEnd?: (name: string, result: string, isError: boolean) => void;
  },
  totalContextTokens = 0
): Promise<ToolExecutionResult> {
  const startTime = performance.now();
  const tool = registry.get(tc.name);

  const sid = context.sessionId ?? "default";
  const turn = currentTurn(sid);

  // ------------------------------------------------------------------
  // Dedup cache — checked first, before speculation/persistent caches.
  // Serves results from the wave-scoped cache shared across all sub-agents
  // in a coordinator wave, preventing re-execution of identical read calls.
  // ------------------------------------------------------------------
  const agentCtx = getAgentContext();
  // Prefer the context-local cache (inherited from coordinator); fall back to global.
  const dedupCache: DedupCache | undefined =
    agentCtx?.dedupCache ?? (getGlobalDedupCache() as DedupCache | undefined);

  if (dedupCache && tool && DedupCache.shouldDedup(tc.name, tool.isReadOnly())) {
    const dedupHit = dedupCache.get(tc.name, tc.input, context.cwd);
    if (dedupHit !== null) {
      callbacks?.onToolStart?.(tc.name, tc.input);
      callbacks?.onToolEnd?.(tc.name, dedupHit, false);
      const hitMs = performance.now() - startTime;
      recordToolMetric(tc.name, hitMs, false);

      // Intent trace: record dedup hit (distinct from speculation hit)
      void recordDedupHit(sid, turn, tc.name, hitMs);

      trackAndSpeculate(tc.name, tc.input, dedupHit);

      return {
        toolCallId: tc.id,
        name: tc.name,
        input: tc.input,
        result: dedupHit,
        isError: false,
      };
    }
  }

  // Check in-memory speculation cache for read-only tools (skip the full execute path)
  if (tool?.isReadOnly() && _speculationCache) {
    const cached = _speculationCache.get(tc.name, tc.input);
    if (cached !== null) {
      callbacks?.onToolStart?.(tc.name, tc.input);
      callbacks?.onToolEnd?.(tc.name, cached, false);
      const hitMs = performance.now() - startTime;
      recordToolMetric(tc.name, hitMs, false);

      // Intent trace: record speculation hit
      void recordSpeculationHit(sid, turn, tc.name, "memory", hitMs);

      // Track for speculation and trigger pre-fetch for next likely call
      trackAndSpeculate(tc.name, tc.input, cached);

      return {
        toolCallId: tc.id,
        name: tc.name,
        input: tc.input,
        result: cached,
        isError: false,
      };
    }
  }

  // Check persistent cross-provider cache for read-only tools
  if (tool?.isReadOnly() && _persistentCache) {
    const persistedHit = await _persistentCache.get(tc.name, tc.input);
    if (persistedHit !== null) {
      const { result: cachedResult } = persistedHit;
      callbacks?.onToolStart?.(tc.name, tc.input);
      callbacks?.onToolEnd?.(tc.name, cachedResult, false);
      const hitMs = performance.now() - startTime;
      recordToolMetric(tc.name, hitMs, false);

      // Intent trace: record persistent speculation hit
      void recordSpeculationHit(sid, turn, tc.name, "persistent", hitMs);

      // Also populate the in-memory cache so subsequent calls in this session
      // don't need to hit disk
      _speculationCache?.set(tc.name, tc.input, cachedResult);

      trackAndSpeculate(tc.name, tc.input, cachedResult);

      return {
        toolCallId: tc.id,
        name: tc.name,
        input: tc.input,
        result: cachedResult,
        isError: false,
      };
    }
  }

  callbacks?.onToolStart?.(tc.name, tc.input);

  // Compute dynamic compression limits for this tool based on current context budget.
  const compressionLimits = getBudgetAllocator().getCompressionLimits(tc.name, totalContextTokens);

  const { result: rawResult, isError } = await registry.execute(tc.name, tc.input, context);

  // Apply dynamic compression: if the raw result exceeds the adaptive maxBytes threshold,
  // compress it using the allocator-supplied limits so reasoning-heavy models retain more
  // of each tool result within the available context budget.
  let result = rawResult;
  if (!isError) {
    const encoder = new TextEncoder();
    if (encoder.encode(rawResult).length > compressionLimits.maxBytes) {
      // Re-use the pure compression logic from streamResultCompressor by constructing
      // a lightweight shim tool and draining the generator synchronously.
      const shimTool = {
        name: tc.name,
        prompt: () => "",
        inputSchema: () => ({ type: "object" as const, properties: {} }),
        isReadOnly: () => true,
        isDestructive: () => false,
        isConcurrencySafe: () => true,
        validateInput: () => null,
        call: async () => rawResult,
      };
      result = await compressToolResult(shimTool, tc.input, context, compressionLimits);
    }
  }

  callbacks?.onToolEnd?.(tc.name, result, isError);
  const executionMs = performance.now() - startTime;
  recordToolMetric(tc.name, executionMs, isError);

  // Store in dedup cache for cross-agent reuse within the same coordinator wave
  if (dedupCache && tool && DedupCache.shouldDedup(tc.name, tool.isReadOnly()) && !isError) {
    dedupCache.set(tc.name, tc.input, context.cwd, result, executionMs);
  }

  // Cache successful read-only results for future speculation
  if (tool?.isReadOnly() && _speculationCache && !isError) {
    _speculationCache.set(tc.name, tc.input, result);
  }

  // Also persist to the cross-provider cache so other agents/sessions can reuse
  if (tool?.isReadOnly() && _persistentCache && !isError) {
    _persistentCache.set(tc.name, tc.input, result, executionMs).catch(() => {});
  }

  // Invalidate cache and track modifications when write tools execute
  if (!tool?.isReadOnly()) {
    const filePath = tc.input.file_path;
    if (typeof filePath === "string") {
      dedupCache?.invalidateForFile(filePath);
      _speculationCache?.invalidateForFile(filePath);
      _persistentCache?.invalidateForFile(filePath).catch(() => {});
      trackFileModification(filePath);
    }
  }

  // Track and speculatively pre-fetch next likely calls
  trackAndSpeculate(tc.name, tc.input, isError ? undefined : result);

  // Time-travel: record this step into the session timeline (never throws, flag-gated).
  const idx = (_ttStepIndex.get(sid) ?? 0);
  _ttStepIndex.set(sid, idx + 1);
  void recordStep(sid, { index: idx, toolName: tc.name, args: tc.input, result, isError, cwd: context.cwd });

  // Intent trace: record tool selection (cache miss path = live execution).
  void recordToolSelection(sid, turn, tc.name, tc.input, "", idx);
  void recordSpeculationMiss(sid, turn, tc.name, executionMs);

  return {
    toolCallId: tc.id,
    name: tc.name,
    input: tc.input,
    result,
    isError,
  };
}

/** Track a tool call and kick off speculative pre-fetching in background. */
function trackAndSpeculate(name: string, input: Record<string, unknown>, result?: string): void {
  recentToolCalls.push({ name, input, result });
  if (recentToolCalls.length > MAX_RECENT) recentToolCalls.shift();

  // Fire-and-forget — speculation failures are harmless
  _speculationCache?.speculateFromHistory(recentToolCalls).catch(() => {});
}
