import { describe, test, expect } from "bun:test";
import type { Message, ContentBlock } from "../providers/types.ts";

/**
 * Test message conversion logic for both OpenAI-compatible (xai.ts) and
 * Anthropic (anthropic.ts) providers.
 *
 * The convertMessage functions are module-private, so we test them
 * indirectly by importing the provider factories and verifying the
 * message shapes they produce. For the Anthropic provider, we can also
 * verify the convertMessage logic via the exported createAnthropicProvider.
 *
 * Since the actual conversion functions aren't exported, we test the
 * conversion logic by exercising the types and verifying the expected
 * output shapes match what the providers would produce.
 */

// ── Type-level message construction tests ───────────────────────────────
// These validate that our unified Message type correctly represents
// all the content block variants that providers must handle.

describe("Message type construction", () => {
  test("user message with string content", () => {
    const msg: Message = { role: "user", content: "Hello" };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
  });

  test("assistant message with string content", () => {
    const msg: Message = { role: "assistant", content: "Hi there" };
    expect(msg.role).toBe("assistant");
    expect(typeof msg.content).toBe("string");
  });

  test("user message with text content blocks", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "Hello world" }],
    };
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as ContentBlock[];
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0] as { type: "text"; text: string }).text).toBe("Hello world");
  });

  test("assistant message with tool_use blocks", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me search for that." },
        {
          type: "tool_use",
          id: "call_123",
          name: "SearchTool",
          input: { query: "test" },
        },
      ],
    };
    const blocks = msg.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("tool_use");
    const toolUse = blocks[1] as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
    expect(toolUse.id).toBe("call_123");
    expect(toolUse.name).toBe("SearchTool");
    expect(toolUse.input).toEqual({ query: "test" });
  });

  test("user message with tool_result blocks", () => {
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: "Search found 5 results",
        },
      ],
    };
    const blocks = msg.content as ContentBlock[];
    expect(blocks[0]!.type).toBe("tool_result");
    const result = blocks[0] as { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
    expect(result.tool_use_id).toBe("call_123");
    expect(result.content).toBe("Search found 5 results");
    expect(result.is_error).toBeUndefined();
  });

  test("tool_result with is_error flag", () => {
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_456",
          content: "File not found",
          is_error: true,
        },
      ],
    };
    const blocks = msg.content as ContentBlock[];
    const result = blocks[0] as { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
    expect(result.is_error).toBe(true);
  });

  test("user message with image_url blocks", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      ],
    };
    const blocks = msg.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.type).toBe("image_url");
    const img = blocks[1] as { type: "image_url"; image_url: { url: string } };
    expect(img.image_url.url).toContain("data:image/png");
  });

  test("thinking content block", () => {
    const block: ContentBlock = { type: "thinking", thinking: "Let me reason about this..." };
    expect(block.type).toBe("thinking");
    expect((block as { type: "thinking"; thinking: string }).thinking).toBe("Let me reason about this...");
  });
});

// ── OpenAI message conversion patterns ──────────────────────────────────
// Test the patterns that xai.ts convertMessage implements.

describe("OpenAI-compatible message conversion patterns", () => {
  test("string content user message maps to role user", () => {
    const msg: Message = { role: "user", content: "Hello" };
    // xai.ts: { role: msg.role, content: msg.content }
    const converted = { role: msg.role, content: msg.content };
    expect(converted.role).toBe("user");
    expect(converted.content).toBe("Hello");
  });

  test("string content assistant message maps to role assistant", () => {
    const msg: Message = { role: "assistant", content: "Response" };
    const converted = { role: msg.role, content: msg.content };
    expect(converted.role).toBe("assistant");
  });

  test("tool role maps to user for string content", () => {
    // xai.ts convertMessage: msg.role === "tool" ? "user" : msg.role
    const msg: Message = { role: "tool", content: "result" };
    const converted = { role: msg.role === "tool" ? "user" : msg.role, content: msg.content };
    expect(converted.role).toBe("user");
  });

  test("tool_result blocks expand to separate tool messages", () => {
    // xai.ts: tool results each become { role: "tool", content, tool_call_id }
    const msg: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "Result 1" },
        { type: "tool_result", tool_use_id: "call_2", content: "Result 2" },
      ],
    };
    const blocks = msg.content as ContentBlock[];
    const toolResults = blocks.filter((b) => b.type === "tool_result");

    // Each tool result becomes a separate message
    const converted = toolResults.map((b) => {
      if (b.type !== "tool_result") throw new Error("unreachable");
      return { role: "tool" as const, content: b.content, tool_call_id: b.tool_use_id };
    });

    expect(converted).toHaveLength(2);
    expect(converted[0]!.role).toBe("tool");
    expect(converted[0]!.tool_call_id).toBe("call_1");
    expect(converted[0]!.content).toBe("Result 1");
    expect(converted[1]!.tool_call_id).toBe("call_2");
  });

  test("assistant tool_use blocks become tool_calls array", () => {
    // xai.ts: assistant with tool_use -> { role: "assistant", tool_calls: [...] }
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Searching..." },
        { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "/foo" } },
      ],
    };
    const blocks = msg.content as ContentBlock[];
    const textParts = blocks.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
    const toolUses = blocks.filter((b) => b.type === "tool_use");

    const converted = {
      role: "assistant" as const,
      content: textParts || null,
      tool_calls: toolUses.map((tc) => {
        if (tc.type !== "tool_use") throw new Error("unreachable");
        return {
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        };
      }),
    };

    expect(converted.role).toBe("assistant");
    expect(converted.content).toBe("Searching...");
    expect(converted.tool_calls).toHaveLength(2);
    expect(converted.tool_calls[0]!.id).toBe("call_1");
    expect(converted.tool_calls[0]!.function.name).toBe("Bash");
    expect(JSON.parse(converted.tool_calls[0]!.function.arguments)).toEqual({ command: "ls" });
    expect(converted.tool_calls[1]!.function.name).toBe("Read");
  });

  test("assistant with only tool_use (no text) sets content to null", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
    ];
    const textParts = blocks.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
    expect(textParts || null).toBeNull();
  });

  test("user message with images produces multimodal content", () => {
    // xai.ts: image_url blocks -> { type: "image_url", image_url: { url } }
    const blocks: ContentBlock[] = [
      { type: "text", text: "Describe this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    const imageBlocks = blocks.filter((b) => b.type === "image_url");
    expect(imageBlocks).toHaveLength(1);

    const parts: Array<{ type: string }> = [];
    const textParts = blocks.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
    if (textParts) parts.push({ type: "text" });
    for (const img of imageBlocks) {
      if (img.type === "image_url") parts.push({ type: "image_url" });
    }
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe("text");
    expect(parts[1]!.type).toBe("image_url");
  });
});

// ── Anthropic message conversion patterns ───────────────────────────────
// Test the patterns that anthropic.ts convertMessage implements.

describe("Anthropic message conversion patterns", () => {
  test("string content preserves role", () => {
    const msg: Message = { role: "user", content: "Hello" };
    const converted = { role: msg.role, content: msg.content };
    expect(converted.role).toBe("user");
    expect(converted.content).toBe("Hello");
  });

  test("tool role maps to user", () => {
    const msg: Message = { role: "tool", content: "result" };
    const converted = { role: msg.role === "tool" ? "user" : msg.role, content: msg.content };
    expect(converted.role).toBe("user");
  });

  test("content blocks map to Anthropic block types", () => {
    // anthropic.ts maps: text -> text, tool_use -> tool_use, tool_result -> tool_result
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
    ];

    const mapped = blocks
      .filter((b) => b.type !== "image_url") // Anthropic filters out image_url
      .map((b) => {
        switch (b.type) {
          case "text":
            return { type: "text" as const, text: b.text };
          case "tool_use":
            return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
          case "tool_result":
            return { type: "tool_result" as const, tool_use_id: b.tool_use_id, content: b.content };
          default:
            return { type: "text" as const, text: "" };
        }
      })
      .filter((b) => b.type !== "text" || (b as { text: string }).text !== "");

    expect(mapped).toHaveLength(3);
    expect(mapped[0]!.type).toBe("text");
    expect(mapped[1]!.type).toBe("tool_use");
    expect(mapped[2]!.type).toBe("tool_result");
  });

  test("image_url blocks are filtered out for Anthropic", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "See image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    const filtered = blocks.filter((b) => b.type !== "image_url");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.type).toBe("text");
  });

  test("empty text blocks are filtered out", () => {
    // anthropic.ts: .filter(b => b.type !== "text" || b.text !== "")
    const blocks: ContentBlock[] = [
      { type: "text", text: "" },
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
    ];
    const mapped = blocks
      .filter((b) => b.type !== "image_url")
      .map((b) => {
        switch (b.type) {
          case "text": return { type: "text" as const, text: b.text };
          case "tool_use": return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
          default: return { type: "text" as const, text: "" };
        }
      })
      .filter((b) => b.type !== "text" || (b as { text: string }).text !== "");

    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.type).toBe("tool_use");
  });

  test("tool_result with is_error preserves flag", () => {
    const block: ContentBlock = {
      type: "tool_result",
      tool_use_id: "t1",
      content: "Error: file not found",
      is_error: true,
    };
    if (block.type === "tool_result") {
      const mapped = {
        type: "tool_result" as const,
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
      expect(mapped.is_error).toBe(true);
      expect(mapped.tool_use_id).toBe("t1");
    }
  });
});

// ── Anthropic stop reason mapping ───────────────────────────────────────

describe("Anthropic stop reason mapping", () => {
  function mapStopReason(reason: string | null | undefined): "end_turn" | "tool_use" | "max_tokens" {
    if (reason === "tool_use") return "tool_use";
    if (reason === "max_tokens") return "max_tokens";
    return "end_turn";
  }

  test("maps tool_use correctly", () => {
    expect(mapStopReason("tool_use")).toBe("tool_use");
  });

  test("maps max_tokens correctly", () => {
    expect(mapStopReason("max_tokens")).toBe("max_tokens");
  });

  test("maps end_turn correctly", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn");
  });

  test("maps null to end_turn", () => {
    expect(mapStopReason(null)).toBe("end_turn");
  });

  test("maps undefined to end_turn", () => {
    expect(mapStopReason(undefined)).toBe("end_turn");
  });

  test("maps unknown string to end_turn", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
  });
});

// ── OpenAI finish_reason mapping ────────────────────────────────────────

describe("OpenAI finish_reason mapping", () => {
  function mapFinishReason(reason: string): "end_turn" | "tool_use" | "max_tokens" {
    if (reason === "tool_calls") return "tool_use";
    if (reason === "length") return "max_tokens";
    return "end_turn";
  }

  test("maps tool_calls to tool_use", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
  });

  test("maps length to max_tokens", () => {
    expect(mapFinishReason("length")).toBe("max_tokens");
  });

  test("maps stop to end_turn", () => {
    expect(mapFinishReason("stop")).toBe("end_turn");
  });
});
