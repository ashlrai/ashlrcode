/**
 * Streaming Tool Executor — parallel execution for concurrency-safe tools.
 *
 * Partitions tool calls by isConcurrencySafe():
 * - Safe tools run in parallel via Promise.all()
 * - Unsafe tools run sequentially
 */

import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";
import type { SpeculationCache } from "./speculation.ts";
import { trackFileModification } from "./verification.ts";

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
  }
): Promise<ToolExecutionResult[]> {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) {
    return [await executeSingle(toolCalls[0]!, registry, context, callbacks)];
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
      safe.map((tc) => executeSingle(tc, registry, context, callbacks))
    );
    results.push(...parallelResults);
  }

  // Run unsafe tools sequentially
  for (const tc of unsafe) {
    const result = await executeSingle(tc, registry, context, callbacks);
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
  }
): Promise<ToolExecutionResult> {
  const startTime = performance.now();
  const tool = registry.get(tc.name);

  // Check speculation cache for read-only tools (skip the full execute path)
  if (tool?.isReadOnly() && _speculationCache) {
    const cached = _speculationCache.get(tc.name, tc.input);
    if (cached !== null) {
      callbacks?.onToolStart?.(tc.name, tc.input);
      callbacks?.onToolEnd?.(tc.name, cached, false);
      recordToolMetric(tc.name, performance.now() - startTime, false);

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

  callbacks?.onToolStart?.(tc.name, tc.input);

  // Per-slug budget guard — consulted before every tool call when the
  // autopilot drain has installed a bucket on the ToolContext. The guard
  // throws `BudgetExceededError` when the per-slug budget is breached;
  // we surface that as a tool error so the agent loop can bail cleanly.
  // Estimate is 0 here — tools that actually drive LLM calls should call
  // `context.budgetGuard` themselves with a real estimate if they have one.
  // A zero-cost probe still fires the halt branch once `spent >= budget`.
  if (context.budgetGuard) {
    try {
      context.budgetGuard(0, tc.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks?.onToolEnd?.(tc.name, message, true);
      recordToolMetric(tc.name, performance.now() - startTime, true);
      throw err;
    }
  }

  const { result, isError } = await registry.execute(tc.name, tc.input, context);

  callbacks?.onToolEnd?.(tc.name, result, isError);
  recordToolMetric(tc.name, performance.now() - startTime, isError);

  // Cache successful read-only results for future speculation
  if (tool?.isReadOnly() && _speculationCache && !isError) {
    _speculationCache.set(tc.name, tc.input, result);
  }

  // Invalidate cache and track modifications when write tools execute
  if (!tool?.isReadOnly()) {
    const filePath = tc.input.file_path;
    if (typeof filePath === "string") {
      _speculationCache?.invalidateForFile(filePath);
      trackFileModification(filePath);
    }
  }

  // Track and speculatively pre-fetch next likely calls
  trackAndSpeculate(tc.name, tc.input, isError ? undefined : result);

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
