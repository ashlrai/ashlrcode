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

export function createXAIProvider(config: ProviderConfig): Provider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "https://api.x.ai/v1",
  });

  return {
    name: "xai",
    config,
    pricing: [0.2, 0.5], // grok-4-1-fast-reasoning per million tokens

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
        ...request.messages.map(convertMessage),
      ];

      const stream = await client.chat.completions.create({
        model: config.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        max_tokens: request.maxTokens ?? config.maxTokens ?? 8192,
        stream: true,
      });

      const toolCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
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

        // Usage
        if (chunk.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            },
          };
        }
      }
    },
  };
}

function convertMessage(
  msg: ProviderRequest["messages"][number]
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === "tool") {
    // Tool results need special handling
    const content = typeof msg.content === "string" ? msg.content : "";
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const toolResults = blocks.filter((b) => b.type === "tool_result");

    if (toolResults.length > 0) {
      // Return as tool message for each result
      const result = toolResults[0]!;
      if (result.type === "tool_result") {
        return {
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_use_id,
        };
      }
    }

    return { role: "user", content };
  }

  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  // Handle content blocks — extract text and tool uses
  const textParts = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const toolUses = msg.content.filter((b) => b.type === "tool_use");

  if (msg.role === "assistant" && toolUses.length > 0) {
    return {
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
    };
  }

  return { role: msg.role, content: textParts };
}
