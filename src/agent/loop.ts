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
import type { SystemPrompt, AgentId } from "../types/branded.ts";
import { runWithAgentContext, createChildContext, getAgentContext } from "./async-context.ts";

/** Default inactivity timeout for provider streams (5 minutes). */
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

export interface AgentConfig {
  systemPrompt: string | SystemPrompt;
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  maxIterations?: number;
  /** Inactivity timeout (ms) for provider streams. Defaults to 5 minutes. */
  streamTimeoutMs?: number;
  /** If true, only allow read-only tools (plan mode) */
  readOnly?: boolean;
  /** Agent identity — used for context isolation in multi-agent scenarios */
  agentId?: string;
  /** Parent agent ID — set when this is a sub-agent */
  parentAgentId?: string;
  /** Human-readable agent name/role */
  agentName?: string;
  /** Callback for streaming text to the UI */
  onText?: (text: string) => void;
  /** Callback for streaming thinking/reasoning text to the UI */
  onThinking?: (text: string) => void;
  /** Callback when a tool is being called */
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  /** Callback when a tool completes */
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
  /** Callback when token usage is reported */
  onUsage?: (usage: import("../providers/types.ts").TokenUsage) => void;
}

export interface AgentResult {
  messages: Message[];
  finalText: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
}

/* ── Streaming event types for streamAgentLoop() ───────────────── */

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; name: string; result: string; isError: boolean }
  | { type: "turn_end"; finalText: string; toolCalls: AgentResult["toolCalls"] };

/**
 * Wrap an async iterable with an inactivity timeout.
 * If no event is yielded within `ms` milliseconds, throws a timeout error.
 * The timer resets after each successfully received event.
 */
async function* withStreamTimeout<T>(
  iterable: AsyncIterable<T>,
  ms: number
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Stream timeout: no response from provider for ${Math.round(ms / 1000)} seconds`
                )
              ),
            ms
          );
        }),
      ]);
      clearTimeout(timer);
      if (result.done) break;
      yield result.value;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

/**
 * Run the agent loop for a single user turn.
 * Streams responses, executes tools, and loops until the model stops.
 * When agentId/agentName are provided, runs inside an isolated AsyncLocalStorage
 * context so parallel sub-agents don't share state.
 */
export async function runAgentLoop(
  userMessage: string,
  history: Message[],
  config: AgentConfig
): Promise<AgentResult> {
  // Wrap in agent context isolation if agent identity is specified
  if (config.agentId || config.agentName) {
    const parentCtx = getAgentContext();
    const childCtx = createChildContext(
      parentCtx,
      config.agentName ?? config.agentId ?? "agent",
      config.toolContext.cwd,
      config.readOnly ?? false,
    );
    return runWithAgentContext(childCtx, () => _runAgentLoop(userMessage, history, config));
  }
  return _runAgentLoop(userMessage, history, config);
}

async function _runAgentLoop(
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
 * Supports agent context isolation via config.agentId/agentName.
 */
export async function* streamAgentLoop(
  userMessage: string,
  history: Message[],
  config: AgentConfig
): AsyncGenerator<AgentEvent> {
  // Note: streamAgentLoop does not use AsyncLocalStorage context isolation.
  // Sub-agents should use runAgentLoop (which wraps in runWithAgentContext)
  // rather than the streaming variant for proper context isolation.
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

    const rawStream = config.router.stream({
      systemPrompt: config.systemPrompt,
      messages,
      tools,
    });
    const stream = withStreamTimeout(
      rawStream,
      config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
    );

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          if (event.text) {
            text += event.text;
            yield { type: "text_delta", text: event.text };
          }
          break;

        case "thinking_delta":
          if (event.text) {
            yield { type: "thinking_delta", text: event.text };
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

        case "usage":
          if (event.usage) config.onUsage?.(event.usage);
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

    // Execute tool calls, collecting start/end events in order.
    // Events are buffered during execution since we can't yield from callbacks,
    // then yielded immediately after. The onToolStart/onToolEnd callbacks on
    // config still fire in real-time for non-streaming consumers.
    const toolEvents: AgentEvent[] = [];
    const executionResults = await executeToolCalls(
      toolCalls,
      config.toolRegistry,
      config.toolContext,
      {
        onToolStart: (name, input) => {
          toolEvents.push({ type: "tool_start", name, input });
          config.onToolStart?.(name, input);
        },
        onToolEnd: (name, result, isError) => {
          toolEvents.push({ type: "tool_end", name, result, isError });
          config.onToolEnd?.(name, result, isError);
        },
      }
    );

    // Yield buffered tool events in execution order
    for (const event of toolEvents) {
      yield event;
    }

    for (const er of executionResults) {
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

  const rawStream = config.router.stream({
    systemPrompt: config.systemPrompt,
    messages,
    tools,
  });
  const stream = withStreamTimeout(
    rawStream,
    config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
  );

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        if (event.text) {
          text += event.text;
          config.onText?.(event.text);
        }
        break;

      case "thinking_delta":
        if (event.text) {
          config.onThinking?.(event.text);
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

      case "usage":
        if (event.usage) config.onUsage?.(event.usage);
        break;
    }
  }

  return { text, toolCalls, stopReason };
}
