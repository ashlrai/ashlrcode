/**
 * xAI Grok provider — uses OpenAI SDK with xAI base URL.
 * Pattern from ashlr-landing/lib/xai-client.ts.
 */

import OpenAI from "openai";
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  StreamEvent,
  ToolCall,
} from "./types.ts";
import { withRetry } from "./retry.ts";

export function createXAIProvider(config: ProviderConfig): Provider {
  return createOpenAICompatibleProvider("xai", config, [0.2, 0.5]);
}

export function createOpenAICompatibleProvider(
  name: string,
  config: ProviderConfig,
  pricing: [number, number]
): Provider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "https://api.x.ai/v1",
  });

  return {
    name,
    config,
    pricing,

    async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = request.tools.map(
        (t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema as Record<string, unknown>,
          },
        })
      );

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: request.systemPrompt },
        ...request.messages.flatMap(convertMessage),
      ];

      const stream = await withRetry(
        () =>
          client.chat.completions.create({
            model: config.model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: request.maxTokens ?? config.maxTokens ?? 8192,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            stream: true,
            stream_options: { include_usage: true },
          }),
        { providerName: name },
      );

      const toolCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        // Usage comes in a chunk with empty choices — handle it first
        if (chunk.usage) {
          const usage = chunk.usage as unknown as Record<string, unknown>;
          const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              costTicks: usage.cost_in_usd_ticks as number | undefined,
              reasoningTokens: completionDetails?.reasoning_tokens,
            },
          };
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text content
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              yield {
                type: "tool_call_start",
                toolCall: { id: tc.id ?? "", name: tc.function?.name ?? "" },
              };
            }
            const existing = toolCalls.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                toolCall: { id: existing.id, name: existing.name },
                text: tc.function.arguments,
              };
            }
          }
        }

        // Finish
        if (choice.finish_reason) {
          // Emit completed tool calls
          for (const [, tc] of toolCalls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.args);
            } catch {
              input = { raw: tc.args };
            }
            yield {
              type: "tool_call_end",
              toolCall: { id: tc.id, name: tc.name, input } as ToolCall,
            };
          }

          yield {
            type: "message_end",
            stopReason:
              choice.finish_reason === "tool_calls"
                ? "tool_use"
                : choice.finish_reason === "length"
                  ? "max_tokens"
                  : "end_turn",
          };
        }

      }
    },
  };
}

/**
 * Convert our unified message format to OpenAI format.
 * Returns an array because tool results expand into multiple messages.
 */
function convertMessage(
  msg: ProviderRequest["messages"][number]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // Handle tool results — each one becomes a separate "tool" message
  if (msg.role === "user" && Array.isArray(msg.content)) {
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    if (toolResults.length > 0) {
      return toolResults.map((b) => {
        if (b.type !== "tool_result") throw new Error("unreachable");
        return {
          role: "tool" as const,
          content: b.content,
          tool_call_id: b.tool_use_id,
        };
      });
    }
  }

  if (typeof msg.content === "string") {
    return [{ role: msg.role === "tool" ? "user" : msg.role, content: msg.content }];
  }

  // Handle content blocks — extract text, images, and tool uses
  const textParts = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const imageBlocks = msg.content.filter((b) => b.type === "image_url");
  const toolUses = msg.content.filter((b) => b.type === "tool_use");

  // User message with images — send as multimodal content array
  if (msg.role === "user" && imageBlocks.length > 0) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    if (textParts) parts.push({ type: "text", text: textParts });
    for (const img of imageBlocks) {
      if (img.type === "image_url") {
        parts.push({ type: "image_url", image_url: { url: img.image_url.url } });
      }
    }
    return [{ role: "user" as const, content: parts }];
  }

  if (msg.role === "assistant" && toolUses.length > 0) {
    return [{
      role: "assistant",
      content: textParts || null,
      tool_calls: toolUses.map((tc) => {
        if (tc.type !== "tool_use") throw new Error("unreachable");
        return {
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        };
      }),
    }];
  }

  return [{ role: msg.role === "tool" ? "user" : msg.role, content: textParts }];
}

