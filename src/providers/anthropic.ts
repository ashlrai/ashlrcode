/**
 * Anthropic Claude provider — uses the official Anthropic SDK.
 * Fallback provider for when Claude API access is available.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
} from "./types.ts";
import { withStreamRetry } from "./retry.ts";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  return {
    name: "anthropic",
    config,
    pricing: [3.0, 15.0], // Sonnet 4.6 per million tokens

    async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
      const tools: Anthropic.Tool[] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }));

      const messages: Anthropic.MessageParam[] = request.messages.map(
        convertMessage
      );

      // Use withStreamRetry to wrap the async generator — if an error
      // surfaces mid-stream, the generator is recreated from scratch.
      yield* withStreamRetry(
        () => streamAnthropicEvents(client, config, request, messages, tools),
        { providerName: "anthropic" },
      );
    },
  };
}

async function* streamAnthropicEvents(
  client: Anthropic,
  config: ProviderConfig,
  request: ProviderRequest,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): AsyncGenerator<StreamEvent> {
  const stream = client.messages.stream({
    model: config.model,
    system: request.systemPrompt,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    max_tokens: request.maxTokens ?? config.maxTokens ?? 8192,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
  });

  // SDK usage counters are cumulative within an attempt, not increments. Keep
  // a snapshot so each attempt records one call with its latest known totals.
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let hasUsage = false;
  try {
    for await (const event of stream) {
      switch (event.type) {
        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            yield {
              type: "tool_call_delta",
              text: delta.partial_json,
            };
          } else if (delta.type === "thinking_delta" && "thinking" in delta) {
            yield {
              type: "thinking_delta",
              text: (delta as unknown as { thinking: string }).thinking,
            };
          } else if (delta.type === "signature_delta" && "signature" in delta) {
            yield {
              type: "thinking_delta",
              text: "",
              signature: (delta as unknown as { signature: string }).signature,
            };
          }
          break;
        }

        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            yield {
              type: "tool_call_start",
              toolCall: { id: block.id, name: block.name },
            };
          }
          break;
        }

        case "content_block_stop":
          break;

        case "message_delta": {
          if (event.usage) {
            usage.inputTokens = event.usage.input_tokens ?? usage.inputTokens;
            usage.outputTokens = event.usage.output_tokens;
            hasUsage = true;
          }
          const delta = event.delta;
          if (delta.stop_reason != null) {
            yield {
              type: "message_end",
              stopReason: mapStopReason(delta.stop_reason),
              usage: {
                inputTokens: 0,
                outputTokens: event.usage?.output_tokens ?? 0,
              },
            };
          }
          break;
        }

        case "message_start": {
          if (event.message.usage) {
            usage.inputTokens = event.message.usage.input_tokens;
            usage.outputTokens = event.message.usage.output_tokens;
            hasUsage = true;
          }
          break;
        }
      }
    }

    // The SDK's completed message is authoritative when the attempt succeeds.
    const finalMessage = await stream.finalMessage();
    usage.inputTokens = finalMessage.usage.input_tokens;
    usage.outputTokens = finalMessage.usage.output_tokens;
    hasUsage = true;
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        yield {
          type: "tool_call_end",
          toolCall: {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          },
        };
      }
    }
  } finally {
    // Flush known partial usage before an SDK error reaches withStreamRetry.
    // Retries each own a new snapshot, so a failed attempt is not lost or
    // combined with the next attempt's cumulative counters.
    if (hasUsage) {
      yield {
        type: "usage",
        usage,
      };
    }
  }
}

function mapStopReason(reason: string | null | undefined): "end_turn" | "tool_use" | "max_tokens" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

function convertMessage(
  msg: ProviderRequest["messages"][number]
): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role === "tool" ? "user" : msg.role, content: msg.content };
  }

  const blocks: Anthropic.ContentBlockParam[] = msg.content
    .filter((b) => b.type !== "image_url") // Anthropic uses different image format
    .map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text" as const, text: b.text };
      case "thinking":
        return { type: "thinking" as const, thinking: b.thinking, signature: b.signature ?? "" };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: b.id,
          name: b.name,
          input: b.input,
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error,
        };
      default:
        return { type: "text" as const, text: "" };
    }
  }).filter(b => b.type !== "text" || ("text" in b && b.text !== ""));

  return {
    role: msg.role === "tool" ? "user" : msg.role,
    content: blocks,
  };
}
