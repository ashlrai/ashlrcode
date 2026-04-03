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
  const tool = registry.get(tc.name);

  // Check speculation cache for read-only tools (skip the full execute path)
  if (tool?.isReadOnly() && _speculationCache) {
    const cached = _speculationCache.get(tc.name, tc.input);
    if (cached !== null) {
      callbacks?.onToolStart?.(tc.name, tc.input);
      callbacks?.onToolEnd?.(tc.name, cached, false);

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

  const { result, isError } = await registry.execute(tc.name, tc.input, context);

  callbacks?.onToolEnd?.(tc.name, result, isError);

  // Cache successful read-only results for future speculation
  if (tool?.isReadOnly() && _speculationCache && !isError) {
    _speculationCache.set(tc.name, tc.input, result);
  }

  // Invalidate cache when write tools execute
  if (!tool?.isReadOnly() && _speculationCache) {
    const filePath = tc.input.file_path;
    if (typeof filePath === "string") {
      _speculationCache.invalidateForFile(filePath);
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
