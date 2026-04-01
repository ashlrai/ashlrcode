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

  return results;
}

async function executeSingle(
  tc: ToolCall,
  registry: ToolRegistry,
  context: ToolContext,
  callbacks?: {
    onToolStart?: (name: string, input: Record<string, unknown>) => void;
    onToolEnd?: (name: string, result: string, isError: boolean) => void;
  }
): Promise<ToolExecutionResult> {
  callbacks?.onToolStart?.(tc.name, tc.input);

  const { result, isError } = await registry.execute(tc.name, tc.input, context);

  callbacks?.onToolEnd?.(tc.name, result, isError);

  return {
    toolCallId: tc.id,
    name: tc.name,
    input: tc.input,
    result,
    isError,
  };
}
