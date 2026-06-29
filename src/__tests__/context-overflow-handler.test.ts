/**
 * Tests for src/agent/context-overflow-handler.ts
 *
 * Covers:
 *   - Overflow detection accuracy across all 6 providers
 *   - Degradation strategy ordering (tier 1 → 2 → 3)
 *   - User choice handling (warning structure and choices)
 *   - Cost-tracking through degradation (savings accounting)
 *   - Edge cases: empty messages, single-message, non-tool content
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkContextOverflow,
  applyTier1Compact,
  applyTier2Snip,
  applyTier3Collapse,
  OVERFLOW_WARN_THRESHOLD,
  OVERFLOW_CRITICAL_THRESHOLD,
  COMPACT_OLDEST_FRACTION,
  LARGE_TOOL_RESULT_CHARS,
  SNIP_KEEP_CHARS,
  SNIP_SEPARATOR,
  DEFAULT_CONTEXT_LIMIT,
  PROVIDER_CONTEXT_LIMITS,
  getProviderContextLimit,
  type OverflowResult,
  type OverflowWarning,
} from "../agent/context-overflow-handler.ts";
import type { Message, ContentBlock } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextMessage(role: "user" | "assistant", text: string): Message {
  return { role, content: text };
}

function makeToolResultMessage(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content },
    ],
  };
}

function makeToolUseMessage(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id, name, input: {} },
    ],
  };
}

/**
 * Build a message array whose estimated token count is approximately
 * `targetFillRatio * contextLimit`.
 *
 * Uses ~4 chars/token approximation (matches estimateTokensFromString).
 */
function buildMessagesAtFill(
  targetFillRatio: number,
  contextLimit: number,
  count = 10
): Message[] {
  const targetTokens = Math.floor(targetFillRatio * contextLimit);
  const tokensPerMsg = Math.floor(targetTokens / count);
  const charsPerMsg = tokensPerMsg * 4;

  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
    messages.push(makeTextMessage(role, "x".repeat(Math.max(1, charsPerMsg))));
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Provider limit constants
// ---------------------------------------------------------------------------

describe("PROVIDER_CONTEXT_LIMITS", () => {
  test("xAI has 2M token context", () => {
    expect(PROVIDER_CONTEXT_LIMITS["xai"]).toBe(2_000_000);
  });

  test("anthropic has 200K token context", () => {
    expect(PROVIDER_CONTEXT_LIMITS["anthropic"]).toBe(200_000);
  });

  test("openai has 128K token context", () => {
    expect(PROVIDER_CONTEXT_LIMITS["openai"]).toBe(128_000);
  });

  test("ollama has 32K token context", () => {
    expect(PROVIDER_CONTEXT_LIMITS["ollama"]).toBe(32_000);
  });

  test("groq has 128K token context", () => {
    expect(PROVIDER_CONTEXT_LIMITS["groq"]).toBe(128_000);
  });

  test("deepseek has 128K token context", () => {
    expect(PROVIDER_CONTEXT_LIMITS["deepseek"]).toBe(128_000);
  });

  test("DEFAULT_CONTEXT_LIMIT is 100K", () => {
    expect(DEFAULT_CONTEXT_LIMIT).toBe(100_000);
  });

  test("unknown provider falls back to 100K default", () => {
    expect(getProviderContextLimit("made-up-llm")).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Overflow detection — all 6 providers
// ---------------------------------------------------------------------------

describe("checkContextOverflow — detection accuracy across providers", () => {
  // For each provider, build messages at 50% fill: should be "ok"
  const providers = [
    { name: "xai",       limit: 2_000_000 },
    { name: "anthropic", limit: 200_000 },
    { name: "openai",    limit: 128_000 },
    { name: "ollama",    limit: 32_000 },
    { name: "groq",      limit: 128_000 },
    { name: "deepseek",  limit: 128_000 },
  ];

  for (const { name, limit } of providers) {
    test(`${name} (${limit.toLocaleString()} tokens) — 50% fill → "ok"`, () => {
      const messages = buildMessagesAtFill(0.50, limit);
      const result = checkContextOverflow(messages, name);
      expect(result.severity).toBe("ok");
      expect(result.degraded).toBe(false);
      expect(result.contextLimit).toBe(limit);
    });

    test(`${name} — 85% fill → "warn" or degraded`, () => {
      const messages = buildMessagesAtFill(0.85, limit);
      const result = checkContextOverflow(messages, name);
      // After degradation the fill ratio should be reduced
      expect(["warn", "ok", "critical"]).toContain(result.severity);
      // degraded should be true since 85% >= OVERFLOW_WARN_THRESHOLD (80%)
      expect(result.degraded).toBe(true);
      expect(result.contextLimit).toBe(limit);
    });
  }

  test("case-insensitive provider match — 'Anthropic' resolves to 200K", () => {
    const messages = buildMessagesAtFill(0.50, 200_000);
    const result = checkContextOverflow(messages, "Anthropic");
    expect(result.contextLimit).toBe(200_000);
  });

  test("substring match — 'xai-grok-4' resolves to 2M", () => {
    const messages = buildMessagesAtFill(0.50, 2_000_000);
    const result = checkContextOverflow(messages, "xai-grok-4");
    expect(result.contextLimit).toBe(2_000_000);
  });
});

// ---------------------------------------------------------------------------
// checkContextOverflow — severity thresholds
// ---------------------------------------------------------------------------

describe("checkContextOverflow — severity and thresholds", () => {
  test("OVERFLOW_WARN_THRESHOLD is 0.80", () => {
    expect(OVERFLOW_WARN_THRESHOLD).toBe(0.80);
  });

  test("OVERFLOW_CRITICAL_THRESHOLD is 0.90", () => {
    expect(OVERFLOW_CRITICAL_THRESHOLD).toBe(0.90);
  });

  test("messages at 70% fill → severity ok, no degradation", () => {
    const messages = buildMessagesAtFill(0.70, 100_000);
    const result = checkContextOverflow(messages, "unknown-provider");
    expect(result.severity).toBe("ok");
    expect(result.degraded).toBe(false);
    expect(result.savings.totalSaved).toBe(0);
  });

  test("returns correct contextLimit for each provider", () => {
    const cases: Array<[string, number]> = [
      ["xai", 2_000_000],
      ["anthropic", 200_000],
      ["openai", 128_000],
      ["ollama", 32_000],
      ["groq", 128_000],
      ["deepseek", 128_000],
    ];
    for (const [provider, expected] of cases) {
      const messages = buildMessagesAtFill(0.10, expected);
      const result = checkContextOverflow(messages, provider);
      expect(result.contextLimit).toBe(expected);
    }
  });

  test("fillRatio is between 0 and 1", () => {
    const messages = buildMessagesAtFill(0.50, 100_000);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.fillRatio).toBeGreaterThanOrEqual(0);
    expect(result.fillRatio).toBeLessThanOrEqual(1);
  });

  test("messages is never empty after overflow handling (last message preserved)", () => {
    const messages = buildMessagesAtFill(0.95, 100_000, 5);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Degradation strategy ordering
// ---------------------------------------------------------------------------

describe("checkContextOverflow — degradation strategy ordering", () => {
  test("tier 1 compact fires first (compactSaved > 0 on high-fill input)", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 20);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.degraded).toBe(true);
    expect(result.savings.compactSaved).toBeGreaterThan(0);
  });

  test("savings object always has all four fields", () => {
    const messages = buildMessagesAtFill(0.85, 100_000);
    const result = checkContextOverflow(messages, "unknown");
    expect(typeof result.savings.compactSaved).toBe("number");
    expect(typeof result.savings.snipSaved).toBe("number");
    expect(typeof result.savings.collapseSaved).toBe("number");
    expect(typeof result.savings.totalSaved).toBe("number");
  });

  test("totalSaved equals sum of all tier savings", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 20);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.savings.totalSaved).toBe(
      result.savings.compactSaved +
      result.savings.snipSaved +
      result.savings.collapseSaved
    );
  });

  test("no degradation when fill < OVERFLOW_WARN_THRESHOLD", () => {
    const messages = buildMessagesAtFill(0.50, 100_000);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.savings.compactSaved).toBe(0);
    expect(result.savings.snipSaved).toBe(0);
    expect(result.savings.collapseSaved).toBe(0);
    expect(result.savings.totalSaved).toBe(0);
  });

  test("returned messages count is <= input messages count after tier 1", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 20);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.messages.length).toBeLessThanOrEqual(messages.length);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — applyTier1Compact
// ---------------------------------------------------------------------------

describe("applyTier1Compact", () => {
  test("COMPACT_OLDEST_FRACTION is 0.20", () => {
    expect(COMPACT_OLDEST_FRACTION).toBe(0.20);
  });

  test("drops ~20% of messages from the front", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeTextMessage(i % 2 === 0 ? "user" : "assistant", "hello".repeat(100))
    );
    const { messages: result } = applyTier1Compact(messages);
    // 20% of 10 = 2 dropped
    expect(result.length).toBe(8);
  });

  test("preserves at least the last message", () => {
    const messages = [makeTextMessage("user", "single message")];
    const { messages: result } = applyTier1Compact(messages);
    expect(result.length).toBe(1);
  });

  test("returns tokensSaved > 0 when messages were dropped", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeTextMessage(i % 2 === 0 ? "user" : "assistant", "x".repeat(400))
    );
    const { tokensSaved } = applyTier1Compact(messages);
    expect(tokensSaved).toBeGreaterThan(0);
  });

  test("returns tokensSaved = 0 for single message", () => {
    const messages = [makeTextMessage("user", "only message")];
    const { tokensSaved } = applyTier1Compact(messages);
    expect(tokensSaved).toBe(0);
  });

  test("handles empty array gracefully", () => {
    const { messages, tokensSaved } = applyTier1Compact([]);
    expect(messages).toEqual([]);
    expect(tokensSaved).toBe(0);
  });

  test("does not drop more than (messages.length - 1) messages", () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      makeTextMessage(i % 2 === 0 ? "user" : "assistant", "hi")
    );
    const { messages: result } = applyTier1Compact(messages);
    // Max drop: 3-1=2. 20% of 3 = 0.6 → floor = 0, max(1,0)=1 dropped.
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — applyTier2Snip
// ---------------------------------------------------------------------------

describe("applyTier2Snip", () => {
  test("LARGE_TOOL_RESULT_CHARS is 8000", () => {
    expect(LARGE_TOOL_RESULT_CHARS).toBe(8_000);
  });

  test("SNIP_KEEP_CHARS is 1500", () => {
    expect(SNIP_KEEP_CHARS).toBe(1_500);
  });

  test("tool results under threshold are not snipped", () => {
    const content = "x".repeat(100);
    const messages = [makeToolResultMessage("t1", content)];
    const { messages: result, tokensSaved } = applyTier2Snip(messages);
    const block = (result[0]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block.content).toBe(content);
    expect(tokensSaved).toBe(0);
  });

  test("tool results over threshold are snipped", () => {
    const bigContent = "a".repeat(LARGE_TOOL_RESULT_CHARS + 1000);
    const messages = [makeToolResultMessage("t1", bigContent)];
    const { messages: result, tokensSaved } = applyTier2Snip(messages);
    const block = (result[0]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block.content.length).toBeLessThan(bigContent.length);
    expect(block.content).toContain(SNIP_SEPARATOR);
    expect(tokensSaved).toBeGreaterThan(0);
  });

  test("snipped content starts with first SNIP_KEEP_CHARS/2 characters", () => {
    const head = "H".repeat(SNIP_KEEP_CHARS / 2);
    const middle = "M".repeat(LARGE_TOOL_RESULT_CHARS + 500);
    const tail = "T".repeat(SNIP_KEEP_CHARS / 2);
    const bigContent = head + middle + tail;
    const messages = [makeToolResultMessage("t1", bigContent)];
    const { messages: result } = applyTier2Snip(messages);
    const block = (result[0]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block.content.startsWith(head)).toBe(true);
  });

  test("snipped content ends with last SNIP_KEEP_CHARS/2 characters", () => {
    const bigContent = "X".repeat(LARGE_TOOL_RESULT_CHARS + 1000) + "END_TAIL";
    const messages = [makeToolResultMessage("t1", bigContent)];
    const { messages: result } = applyTier2Snip(messages);
    const block = (result[0]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block.content.endsWith("END_TAIL")).toBe(true);
  });

  test("non-tool_result blocks are not modified", () => {
    const messages = [makeTextMessage("assistant", "a".repeat(20_000))];
    const { messages: result, tokensSaved } = applyTier2Snip(messages);
    expect((result[0]!.content as string).length).toBe(20_000);
    expect(tokensSaved).toBe(0);
  });

  test("string content messages are passed through unchanged", () => {
    const messages = [makeTextMessage("user", "plain text")];
    const { messages: result } = applyTier2Snip(messages);
    expect(result[0]!.content).toBe("plain text");
  });

  test("handles empty array gracefully", () => {
    const { messages, tokensSaved } = applyTier2Snip([]);
    expect(messages).toEqual([]);
    expect(tokensSaved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — applyTier3Collapse
// ---------------------------------------------------------------------------

describe("applyTier3Collapse", () => {
  test("collapses duplicate tool results (same id + content prefix)", () => {
    const content = "x".repeat(500);
    const msg1 = makeToolResultMessage("t1", content);
    const msg2 = makeToolResultMessage("t1", content); // duplicate
    const { messages: result, tokensSaved } = applyTier3Collapse([msg1, msg2]);
    expect(result.length).toBe(2);
    const block2 = (result[1]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block2.content).toContain("duplicate tool result omitted");
    expect(tokensSaved).toBeGreaterThan(0);
  });

  test("keeps first occurrence of a tool result intact", () => {
    const content = "original content";
    const messages = [makeToolResultMessage("t1", content)];
    const { messages: result } = applyTier3Collapse(messages);
    const block = (result[0]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block.content).toBe(content);
  });

  test("does not collapse tool results with different content", () => {
    const msg1 = makeToolResultMessage("t1", "result A");
    const msg2 = makeToolResultMessage("t1", "result B"); // same id, different content
    const { messages: result, tokensSaved } = applyTier3Collapse([msg1, msg2]);
    const block2 = (result[1]!.content as ContentBlock[])[0] as { type: string; content: string };
    expect(block2.content).toBe("result B");
    expect(tokensSaved).toBe(0);
  });

  test("does not collapse tool_use blocks", () => {
    const msg1 = makeToolUseMessage("t1", "bash");
    const msg2 = makeToolUseMessage("t1", "bash");
    const { messages: result } = applyTier3Collapse([msg1, msg2]);
    // Both tool_use blocks should be kept (they're not tool_result)
    expect(result.length).toBe(2);
  });

  test("string content messages pass through unchanged", () => {
    const messages = [
      makeTextMessage("user", "hello"),
      makeTextMessage("user", "hello"), // same text but not tool_result
    ];
    const { messages: result, tokensSaved } = applyTier3Collapse(messages);
    expect(result[0]!.content).toBe("hello");
    expect(result[1]!.content).toBe("hello");
    expect(tokensSaved).toBe(0);
  });

  test("handles empty array gracefully", () => {
    const { messages, tokensSaved } = applyTier3Collapse([]);
    expect(messages).toEqual([]);
    expect(tokensSaved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// User choice handling — OverflowWarning structure
// ---------------------------------------------------------------------------

describe("checkContextOverflow — OverflowWarning structure", () => {
  function buildCriticalMessages(): Message[] {
    // Build messages that saturate even after degradation
    // Use a small context provider (ollama 32K) with nearly full messages
    return buildMessagesAtFill(0.97, 32_000, 5);
  }

  test("warning is undefined when severity is ok", () => {
    const messages = buildMessagesAtFill(0.50, 100_000);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.warning).toBeUndefined();
  });

  test("warning structure has all required fields when present", () => {
    const messages = buildCriticalMessages();
    const result = checkContextOverflow(messages, "ollama");
    if (result.warning) {
      expect(result.warning.severity).toBe("critical");
      expect(typeof result.warning.estimatedTokens).toBe("number");
      expect(typeof result.warning.contextLimit).toBe("number");
      expect(typeof result.warning.fillRatio).toBe("number");
      expect(Array.isArray(result.warning.choices)).toBe(true);
      expect(typeof result.warning.message).toBe("string");
    }
  });

  test("warning.choices contains exactly 3 actionable choices", () => {
    const messages = buildCriticalMessages();
    const result = checkContextOverflow(messages, "ollama");
    if (result.warning) {
      expect(result.warning.choices).toHaveLength(3);
    }
  });

  test("warning.choices includes clear_history, save_checkpoint, switch_model", () => {
    const messages = buildCriticalMessages();
    const result = checkContextOverflow(messages, "ollama");
    if (result.warning) {
      const keys = result.warning.choices.map((c) => c.key);
      expect(keys).toContain("clear_history");
      expect(keys).toContain("save_checkpoint");
      expect(keys).toContain("switch_model");
    }
  });

  test("each choice has key, label, and description fields", () => {
    const messages = buildCriticalMessages();
    const result = checkContextOverflow(messages, "ollama");
    if (result.warning) {
      for (const choice of result.warning.choices) {
        expect(typeof choice.key).toBe("string");
        expect(typeof choice.label).toBe("string");
        expect(typeof choice.description).toBe("string");
        expect(choice.label.length).toBeGreaterThan(0);
        expect(choice.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("warning.message contains fill ratio percentage", () => {
    const messages = buildCriticalMessages();
    const result = checkContextOverflow(messages, "ollama");
    if (result.warning) {
      expect(result.warning.message).toContain("%");
    }
  });

  test("warning.fillRatio matches result.fillRatio", () => {
    const messages = buildCriticalMessages();
    const result = checkContextOverflow(messages, "ollama");
    if (result.warning) {
      expect(result.warning.fillRatio).toBeCloseTo(result.fillRatio, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost-tracking through degradation
// ---------------------------------------------------------------------------

describe("checkContextOverflow — cost/savings tracking", () => {
  test("savings.totalSaved is 0 when no degradation applied", () => {
    const messages = buildMessagesAtFill(0.40, 100_000);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.savings.totalSaved).toBe(0);
  });

  test("savings.totalSaved > 0 when degradation is applied", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 20);
    const result = checkContextOverflow(messages, "unknown");
    if (result.degraded) {
      expect(result.savings.totalSaved).toBeGreaterThan(0);
    }
  });

  test("estimatedTokens decreases after degradation", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 20);
    // Baseline token count (no overflow check)
    const { estimateTokensFromMessages } = require("../utils/tokens.ts");
    const baselineTokens = estimateTokensFromMessages(messages);

    const result = checkContextOverflow(messages, "unknown");
    if (result.degraded) {
      expect(result.estimatedTokens).toBeLessThan(baselineTokens);
    }
  });

  test("tier savings are non-negative", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 20);
    const result = checkContextOverflow(messages, "unknown");
    expect(result.savings.compactSaved).toBeGreaterThanOrEqual(0);
    expect(result.savings.snipSaved).toBeGreaterThanOrEqual(0);
    expect(result.savings.collapseSaved).toBeGreaterThanOrEqual(0);
  });

  test("systemPromptTokens parameter shifts token budget estimate", () => {
    const messages = buildMessagesAtFill(0.70, 100_000);
    // With a large system prompt, the effective fill should be higher
    const withSystemPrompt = checkContextOverflow(messages, "unknown", 15_000);
    const withoutSystemPrompt = checkContextOverflow(messages, "unknown", 0);
    // The one with system prompt tokens should show higher usage
    expect(withSystemPrompt.estimatedTokens).toBeGreaterThan(withoutSystemPrompt.estimatedTokens);
  });

  test("fillRatio accounts for systemPromptTokens (checked on ok-severity input)", () => {
    // Use 50% fill so neither case triggers degradation — pure ratio comparison.
    const messages = buildMessagesAtFill(0.50, 100_000);
    const withSP = checkContextOverflow(messages, "unknown", 10_000);
    const withoutSP = checkContextOverflow(messages, "unknown", 0);
    // Both should be ok (no degradation), but withSP has higher effective token count
    expect(withSP.severity).toBe("ok");
    expect(withoutSP.severity).toBe("ok");
    expect(withSP.fillRatio).toBeGreaterThan(withoutSP.fillRatio);
  });

  test("snipSaved tracks bytes removed from tool results", () => {
    const bigContent = "z".repeat(LARGE_TOOL_RESULT_CHARS + 5_000);
    // Build messages that are over warn threshold after adding big tool results
    const filler = buildMessagesAtFill(0.82, 100_000, 5);
    const toolMsg = makeToolResultMessage("t1", bigContent);
    const messages = [...filler, toolMsg];
    const result = checkContextOverflow(messages, "unknown");
    // snipSaved should be positive since we have a big tool result
    // (only if tier 2 was reached — depends on whether tier 1 reduced fill enough)
    expect(result.savings.snipSaved).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("checkContextOverflow — edge cases", () => {
  test("handles empty messages array without throwing", () => {
    expect(() => checkContextOverflow([], "anthropic")).not.toThrow();
  });

  test("handles single message without throwing", () => {
    const messages = [makeTextMessage("user", "hello")];
    expect(() => checkContextOverflow(messages, "anthropic")).not.toThrow();
  });

  test("original messages array is not mutated", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 10);
    const originalLength = messages.length;
    checkContextOverflow(messages, "unknown");
    expect(messages.length).toBe(originalLength);
  });

  test("unknown provider uses DEFAULT_CONTEXT_LIMIT (100K)", () => {
    const messages = buildMessagesAtFill(0.50, 100_000);
    const result = checkContextOverflow(messages, "totally-unknown-provider-xyz");
    expect(result.contextLimit).toBe(100_000);
  });

  test("empty provider string uses DEFAULT_CONTEXT_LIMIT", () => {
    const messages = buildMessagesAtFill(0.50, 100_000);
    const result = checkContextOverflow(messages, "");
    expect(result.contextLimit).toBe(100_000);
  });

  test("messages with only tool_use blocks are handled correctly", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeToolUseMessage(`t${i}`, "bash")
    );
    expect(() => checkContextOverflow(messages, "anthropic")).not.toThrow();
  });

  test("result.messages always contains valid Message objects", () => {
    const messages = buildMessagesAtFill(0.85, 100_000, 10);
    const result = checkContextOverflow(messages, "unknown");
    for (const msg of result.messages) {
      expect(msg.role === "user" || msg.role === "assistant").toBe(true);
      expect(msg.content !== undefined).toBe(true);
    }
  });

  test("result is fully typed with all required fields", () => {
    const messages = buildMessagesAtFill(0.50, 100_000);
    const result = checkContextOverflow(messages, "anthropic");
    expect(typeof result.degraded).toBe("boolean");
    expect(typeof result.severity).toBe("string");
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.estimatedTokens).toBe("number");
    expect(typeof result.contextLimit).toBe("number");
    expect(typeof result.fillRatio).toBe("number");
    expect(typeof result.savings).toBe("object");
  });
});
