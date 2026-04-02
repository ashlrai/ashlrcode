import { test, expect, describe } from "bun:test";
import { estimateTokens, needsCompaction, snipCompact } from "../agent/context.ts";
import type { Message } from "../providers/types.ts";

describe("estimateTokens", () => {
  test("estimates tokens for string content", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello world" }, // 11 chars => ceil(11/4) = 3
    ];
    expect(estimateTokens(messages)).toBe(3);
  });

  test("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });

  test("estimates tokens for text blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "abcdefgh" }], // 8 chars => 2 tokens
      },
    ];
    expect(estimateTokens(messages)).toBe(2);
  });

  test("estimates tokens for tool_use blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } },
        ],
      },
    ];
    // name "Bash" (4) + JSON.stringify({command: "ls"}) (16) = 20 => ceil(20/4) = 5
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  test("estimates tokens for tool_result blocks", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "file1.ts\nfile2.ts" },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  test("sums across multiple messages", () => {
    const messages: Message[] = [
      { role: "user", content: "aaaa" }, // 4 chars => 1 token
      { role: "assistant", content: "bbbbbbbb" }, // 8 chars => 2 tokens
    ];
    expect(estimateTokens(messages)).toBe(3);
  });
});

describe("needsCompaction", () => {
  test("returns false when well under limit", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    expect(needsCompaction(messages, 100)).toBe(false);
  });

  test("returns true when over limit", () => {
    // Create a message that's clearly over the default limit
    // Default: maxContextTokens=100000, reserveTokens=8192
    // So threshold is 91808 tokens => 91808 * 4 = 367232 chars
    const bigContent = "x".repeat(400_000);
    const messages: Message[] = [{ role: "user", content: bigContent }];
    expect(needsCompaction(messages, 0)).toBe(true);
  });

  test("respects custom config", () => {
    // "hello world test" = 16 chars / 4 = 4 tokens. Limit 3, so should trigger.
    const messages: Message[] = [{ role: "user", content: "hello world test" }];
    expect(
      needsCompaction(messages, 0, { maxContextTokens: 3, reserveTokens: 0 })
    ).toBe(true);
  });

  test("accounts for system prompt tokens", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    // "hi" = 1 token. systemPromptTokens = 95000. Total = 95001.
    // maxContext 100000 - reserve 8192 = 91808. 95001 > 91808 = true
    expect(
      needsCompaction(messages, 95_000, {
        maxContextTokens: 100_000,
        reserveTokens: 8192,
      })
    ).toBe(true);
  });
});

describe("snipCompact", () => {
  test("does not modify short tool results", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "1", content: "short result" },
        ],
      },
    ];
    const result = snipCompact(messages);
    expect((result[0]!.content as any)[0].content).toBe("short result");
  });

  test("truncates tool results longer than 2000 chars", () => {
    const longContent = "a".repeat(3000);
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "1", content: longContent },
        ],
      },
    ];
    const result = snipCompact(messages);
    const content = (result[0]!.content as any)[0].content as string;
    expect(content.length).toBeLessThan(longContent.length);
    expect(content).toContain("[... truncated ...]");
  });

  test("preserves string content messages unchanged", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = snipCompact(messages);
    expect(result[0]!.content).toBe("hello");
  });

  test("preserves text blocks unchanged", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "some analysis" }],
      },
    ];
    const result = snipCompact(messages);
    expect((result[0]!.content as any)[0].text).toBe("some analysis");
  });

  test("truncated result keeps first 800 and last 800 chars", () => {
    const longContent = "a".repeat(800) + "MIDDLE" + "b".repeat(800) + "c".repeat(1400);
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "1", content: longContent },
        ],
      },
    ];
    const result = snipCompact(messages);
    const content = (result[0]!.content as any)[0].content as string;
    // Should start with 800 chars from the beginning
    expect(content.startsWith("a".repeat(800))).toBe(true);
    // Should end with last 800 chars from the original
    expect(content.endsWith(longContent.slice(-800))).toBe(true);
  });
});
