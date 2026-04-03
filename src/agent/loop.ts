/**
 * Core agent loop — the heart of AshlrCode.
 *
 * Pattern from Claude Code's query.ts:
 *   User Input → messages[] → Provider API (streaming) → stop_reason check
 *     → "tool_use"? → Execute tool → Append result → Loop
 *     → No tool_use? → Return text to user
 */

import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import { executeToolCalls } from "./tool-executor.ts";
import type {
  Message,
  ContentBlock,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "../providers/types.ts";

export interface AgentConfig {
  systemPrompt: string;
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  maxIterations?: number;
  /** If true, only allow read-only tools (plan mode) */
  readOnly?: boolean;
  /** Callback for streaming text to the UI */
  onText?: (text: string) => void;
  /** Callback when a tool is being called */
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  /** Callback when a tool completes */
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
}

export interface AgentResult {
  messages: Message[];
  finalText: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
}

/* ── Streaming event types for streamAgentLoop() ───────────────── */

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; name: string; result: string; isError: boolean }
  | { type: "turn_end"; finalText: string; toolCalls: AgentResult["toolCalls"] };

/**
 * Run the agent loop for a single user turn.
 * Streams responses, executes tools, and loops until the model stops.
 */
export async function runAgentLoop(
  userMessage: string,
  history: Message[],
  config: AgentConfig
): Promise<AgentResult> {
  const messages: Message[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const tools = config.readOnly
    ? config.toolRegistry.getReadOnlyDefinitions()
    : config.toolRegistry.getDefinitions();

  const maxIterations = config.maxIterations ?? 25;
  const allToolCalls: AgentResult["toolCalls"] = [];
  let finalText = "";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const { text, toolCalls, stopReason } = await streamResponse(
      messages,
      tools,
      config
    );

    finalText = text;

    // Build assistant message with content blocks
    const contentBlocks: ContentBlock[] = [];
    if (text) {
      contentBlocks.push({ type: "text", text });
    }
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    messages.push({
      role: "assistant",
      content: contentBlocks.length === 1 && contentBlocks[0]!.type === "text"
        ? text
        : contentBlocks,
    });

    // If no tool calls, we're done
    if (stopReason !== "tool_use" || toolCalls.length === 0) {
      break;
    }

    // Execute tool calls (parallel for safe tools, sequential for unsafe)
    const executionResults = await executeToolCalls(
      toolCalls,
      config.toolRegistry,
      config.toolContext,
      {
        onToolStart: config.onToolStart,
        onToolEnd: config.onToolEnd,
      }
    );

    const resultBlocks: ContentBlock[] = [];
    for (const er of executionResults) {
      allToolCalls.push({ name: er.name, input: er.input, result: er.result });
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: er.toolCallId,
        content: er.result,
        is_error: er.isError,
      });
    }

    messages.push({ role: "user", content: resultBlocks });
  }

  // If we hit max iterations with no final text, add a fallback
  if (!finalText && allToolCalls.length > 0) {
    finalText = `[Reached maximum iterations (${maxIterations}). ${allToolCalls.length} tool calls were executed.]`;
  }

  return { messages, finalText, toolCalls: allToolCalls };
}

/**
 * Streaming agent loop — yields incremental events as an AsyncGenerator.
 *
 * Unlike runAgentLoop() which buffers everything and returns a Promise<AgentResult>,
 * this lets callers react to each event as it arrives (text deltas, tool
 * invocations, etc.). Useful for streaming UIs and programmatic consumers.
 *
 * The existing runAgentLoop() is intentionally left unchanged so current
 * callers keep working — this is an additive, opt-in API.
 */
export async function* streamAgentLoop(
  userMessage: string,
  history: Message[],
  config: AgentConfig
): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const tools = config.readOnly
    ? config.toolRegistry.getReadOnlyDefinitions()
    : config.toolRegistry.getDefinitions();

  const maxIterations = config.maxIterations ?? 25;
  const allToolCalls: AgentResult["toolCalls"] = [];
  let finalText = "";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Stream API response, yielding text deltas as they arrive
    let text = "";
    const toolCalls: ToolCall[] = [];
    let stopReason = "end_turn";

    const stream = config.router.stream({
      systemPrompt: config.systemPrompt,
      messages,
      tools,
    });

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          if (event.text) {
            text += event.text;
            yield { type: "text_delta", text: event.text };
          }
          break;

        case "tool_call_end":
          if (event.toolCall?.id && event.toolCall?.name && event.toolCall?.input) {
            toolCalls.push(event.toolCall as ToolCall);
          }
          break;

        case "message_end":
          if (event.stopReason) {
            stopReason = event.stopReason;
          }
          break;
      }
    }

    finalText = text;

    // Build assistant message with content blocks
    const contentBlocks: ContentBlock[] = [];
    if (text) {
      contentBlocks.push({ type: "text", text });
    }
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    messages.push({
      role: "assistant",
      content: contentBlocks.length === 1 && contentBlocks[0]!.type === "text"
        ? text
        : contentBlocks,
    });

    // If no tool calls, we're done
    if (stopReason !== "tool_use" || toolCalls.length === 0) {
      break;
    }

    // Execute tool calls, yielding start/end events for each
    const executionResults = await executeToolCalls(
      toolCalls,
      config.toolRegistry,
      config.toolContext,
      {
        onToolStart: config.onToolStart,
        onToolEnd: config.onToolEnd,
      }
    );

    for (const er of executionResults) {
      yield { type: "tool_start", name: er.name, input: er.input };
      yield { type: "tool_end", name: er.name, result: er.result, isError: er.isError };
      allToolCalls.push({ name: er.name, input: er.input, result: er.result });
    }

    // Add tool results to messages for the next iteration
    const resultBlocks: ContentBlock[] = executionResults.map((er) => ({
      type: "tool_result" as const,
      tool_use_id: er.toolCallId,
      content: er.result,
      is_error: er.isError,
    }));
    messages.push({ role: "user", content: resultBlocks });
  }

  // If we hit max iterations with no final text, add a fallback
  if (!finalText && allToolCalls.length > 0) {
    finalText = `[Reached maximum iterations (${maxIterations}). ${allToolCalls.length} tool calls were executed.]`;
  }

  yield { type: "turn_end", finalText, toolCalls: allToolCalls };
}

/**
 * Stream a single API response, collecting text and tool calls.
 */
async function streamResponse(
  messages: Message[],
  tools: ToolDefinition[],
  config: AgentConfig
): Promise<{
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
}> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let stopReason = "end_turn";

  const stream = config.router.stream({
    systemPrompt: config.systemPrompt,
    messages,
    tools,
  });

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        if (event.text) {
          text += event.text;
          config.onText?.(event.text);
        }
        break;

      case "tool_call_end":
        if (event.toolCall?.id && event.toolCall?.name && event.toolCall?.input) {
          toolCalls.push(event.toolCall as ToolCall);
        }
        break;

      case "message_end":
        if (event.stopReason) {
          stopReason = event.stopReason;
        }
        break;
    }
  }

  return { text, toolCalls, stopReason };
}
