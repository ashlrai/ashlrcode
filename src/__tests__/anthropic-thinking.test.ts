import { test, expect, describe } from "bun:test";
import type { Message, ContentBlock } from "../providers/types.ts";

/**
 * Tests for thinking block handling across providers.
 *
 * The Anthropic provider must preserve thinking blocks in message history,
 * while OpenAI-compatible providers (xAI, OpenAI, Groq, etc.) must strip them.
 */

// --- Anthropic convertMessage (extracted logic matching src/providers/anthropic.ts) ---

function convertMessageAnthropic(msg: Message) {
  if (typeof msg.content === "string") {
    return { role: msg.role === "tool" ? "user" : msg.role, content: msg.content };
  }

  const blocks = msg.content
    .filter((b) => b.type !== "image_url")
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
    })
    .filter((b) => b.type !== "text" || ("text" in b && b.text !== ""));

  return {
    role: msg.role === "tool" ? "user" : msg.role,
    content: blocks,
  };
}

// --- OpenAI-compatible convertMessage (extracted logic matching src/providers/xai.ts) ---

function convertMessageOpenAI(msg: Message) {
  if (typeof msg.content === "string") {
    return [{ role: msg.role === "tool" ? "user" : msg.role, content: msg.content }];
  }

  // Only extract text blocks — thinking blocks are stripped
  const textParts = msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolUses = msg.content.filter((b) => b.type === "tool_use");

  if (msg.role === "assistant" && toolUses.length > 0) {
    return [
      {
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
      },
    ];
  }

  return [{ role: msg.role === "tool" ? "user" : msg.role, content: textParts }];
}

describe("Anthropic thinking blocks", () => {
  const assistantWithThinking: Message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me reason about this step by step...", signature: "sig_abc123" },
      { type: "text", text: "Here is my answer." },
    ],
  };

  const assistantWithThinkingAndTools: Message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I need to read the file first.", signature: "sig_def456" },
      { type: "text", text: "Let me check that file." },
      { type: "tool_use", id: "tool_1", name: "Read", input: { path: "/tmp/test.ts" } },
    ],
  };

  test("Anthropic preserves thinking blocks in converted messages", () => {
    const result = convertMessageAnthropic(assistantWithThinking);
    expect(result.role).toBe("assistant");
    expect(Array.isArray(result.content)).toBe(true);

    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("thinking");
    expect(blocks[0]!.thinking).toBe("Let me reason about this step by step...");
    expect(blocks[0]!.signature).toBe("sig_abc123");
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[1]!.text).toBe("Here is my answer.");
  });

  test("Anthropic preserves thinking blocks alongside tool_use", () => {
    const result = convertMessageAnthropic(assistantWithThinkingAndTools);
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe("thinking");
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[2]!.type).toBe("tool_use");
  });

  test("OpenAI-compatible strips thinking blocks from messages", () => {
    const result = convertMessageOpenAI(assistantWithThinking);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("Here is my answer.");
    // Should not contain any thinking content
    expect(JSON.stringify(result)).not.toContain("Let me reason");
  });

  test("OpenAI-compatible strips thinking blocks with tool_use present", () => {
    const result = convertMessageOpenAI(assistantWithThinkingAndTools);
    expect(result).toHaveLength(1);
    const msg = result[0] as { role: string; content: string | null; tool_calls?: unknown[] };
    expect(msg.content).toBe("Let me check that file.");
    expect(msg.tool_calls).toHaveLength(1);
    // Thinking content must not leak
    expect(JSON.stringify(result)).not.toContain("I need to read the file first");
  });

  test("Anthropic handles message with only thinking block", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Just thinking...", signature: "sig_only" }],
    };
    const result = convertMessageAnthropic(msg);
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("thinking");
    expect(blocks[0]!.signature).toBe("sig_only");
  });

  test("OpenAI-compatible returns empty text for thinking-only message", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Just thinking..." }],
    };
    const result = convertMessageOpenAI(msg);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("");
  });

  test("Anthropic defaults missing signature to empty string", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "No signature here" }],
    };
    const result = convertMessageAnthropic(msg);
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks[0]!.signature).toBe("");
  });
});
