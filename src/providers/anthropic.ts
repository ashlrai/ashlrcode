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
} from "./types.ts";
import { categorizeError } from "../agent/error-handler.ts";

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

      const createStream = () =>
        client.messages.stream({
          model: config.model,
          system: request.systemPrompt,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: request.maxTokens ?? config.maxTokens ?? 8192,
        });

      // Retry loop: create a new stream on each attempt. Errors from the
      // Anthropic SDK surface during iteration (not during stream creation),
      // so we catch them here and retry with backoff when appropriate.
      const MAX_RETRIES_RATE_LIMIT = 3; // 3 retries = 4 total attempts
      const MAX_RETRIES_NETWORK = 2;   // 2 retries = 3 total attempts
      let attempt = 0;

      while (true) {
        const stream = createStream();
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

              case "content_block_stop": {
                // Tool call end will be handled when we get the full message
                break;
              }

              case "message_delta": {
                const delta = event.delta;
                yield {
                  type: "message_end",
                  stopReason:
                    delta.stop_reason === "tool_use"
                      ? "tool_use"
                      : delta.stop_reason === "max_tokens"
                        ? "max_tokens"
                        : "end_turn",
                  usage: {
                    inputTokens: 0,
                    outputTokens: event.usage?.output_tokens ?? 0,
                  },
                };
                break;
              }

              case "message_start": {
                if (event.message.usage) {
                  yield {
                    type: "usage",
                    usage: {
                      inputTokens: event.message.usage.input_tokens,
                      outputTokens: event.message.usage.output_tokens,
                    },
                  };
                }
                break;
              }
            }
          }

          // Get the final message to extract completed tool calls
          const finalMessage = await stream.finalMessage();
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

          // Success — break out of retry loop
          break;
        } catch (err) {
          const error = err as Error;
          const categorized = categorizeError(error);

          // Auth errors: fail immediately with clear message
          if (categorized.category === "auth") {
            throw new Error(
              `[anthropic] Authentication failed — check your API key. (${error.message})`
            );
          }

          const maxRetries =
            categorized.category === "rate_limit"
              ? MAX_RETRIES_RATE_LIMIT
              : categorized.category === "network"
                ? MAX_RETRIES_NETWORK
                : 0;

          if (!categorized.retryable || attempt >= maxRetries) {
            throw error;
          }

          const baseDelay = categorized.category === "rate_limit" ? 1000 : 2000;
          const delay = baseDelay * Math.pow(2, attempt);
          process.stderr.write(
            `[anthropic] ${categorized.category} error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...\n`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
        }
      }
    },
  };
}

function convertMessage(
  msg: ProviderRequest["messages"][number]
): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role === "tool" ? "user" : msg.role, content: msg.content };
  }

  const blocks: Anthropic.ContentBlockParam[] = msg.content.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text" as const, text: b.text };
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
    }
  });

  return {
    role: msg.role === "tool" ? "user" : msg.role,
    content: blocks,
  };
}
