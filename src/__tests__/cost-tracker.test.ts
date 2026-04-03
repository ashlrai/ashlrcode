import { describe, test, expect, beforeEach } from "bun:test";
import { CostTracker } from "../providers/cost-tracker.ts";

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  // ── Basic recording ──────────────────────────────────────────────────

  test("records usage for a single provider/model", () => {
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", {
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(tracker.totalInputTokens).toBe(1000);
    expect(tracker.totalOutputTokens).toBe(500);
    expect(tracker.totalReasoningTokens).toBe(0);
  });

  test("accumulates usage across multiple calls to same model", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 500, outputTokens: 200 });
    tracker.record("xai", "grok-3-fast", { inputTokens: 500, outputTokens: 300 });

    expect(tracker.totalInputTokens).toBe(1000);
    expect(tracker.totalOutputTokens).toBe(500);

    const breakdown = tracker.getBreakdown();
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]!.calls).toBe(2);
  });

  test("handles partial usage (only inputTokens)", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 100 });
    expect(tracker.totalInputTokens).toBe(100);
    expect(tracker.totalOutputTokens).toBe(0);
  });

  test("handles empty usage object", () => {
    tracker.record("xai", "grok-3-fast", {});
    expect(tracker.totalInputTokens).toBe(0);
    expect(tracker.totalOutputTokens).toBe(0);
    expect(tracker.totalCostUSD).toBe(0);
    expect(tracker.getBreakdown()[0]!.calls).toBe(1);
  });

  // ── Pricing calculations ──────────────────────────────────────────────

  test("calculates Anthropic Sonnet pricing correctly", () => {
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    // (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
    expect(tracker.totalCostUSD).toBeCloseTo(0.0105, 6);
  });

  test("calculates Anthropic Opus pricing correctly", () => {
    tracker.record("anthropic", "claude-opus-4-6-20250514", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // $15/M input
    expect(tracker.totalCostUSD).toBeCloseTo(15.0, 2);
  });

  test("calculates xAI grok-3-fast pricing correctly", () => {
    tracker.record("xai", "grok-3-fast", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // $0.1/M input + $0.3/M output = $0.4
    expect(tracker.totalCostUSD).toBeCloseTo(0.4, 2);
  });

  test("calculates GPT-4o pricing correctly", () => {
    tracker.record("openai", "gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // $2.5/M input + $10/M output = $12.5
    expect(tracker.totalCostUSD).toBeCloseTo(12.5, 2);
  });

  test("free-tier models cost zero", () => {
    tracker.record("groq", "llama-3.3-70b-versatile", {
      inputTokens: 10_000_000,
      outputTokens: 5_000_000,
    });
    expect(tracker.totalCostUSD).toBe(0);
  });

  // ── Reasoning token pricing ───────────────────────────────────────────

  test("reasoning tokens use separate pricing when available (o1)", () => {
    tracker.record("openai", "o1", {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
    });
    // (1000/1M)*15 + (500/1M)*60 + (200/1M)*60 = 0.015 + 0.030 + 0.012 = 0.057
    expect(tracker.totalCostUSD).toBeCloseTo(0.057, 6);
    expect(tracker.totalTokens.reasoningTokens).toBe(200);
  });

  test("reasoning tokens use output rate when no separate rate (sonnet)", () => {
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    // No reasoningPerMillion defined, falls back to outputPerMillion = $15/M
    expect(tracker.totalCostUSD).toBeCloseTo(15.0, 2);
  });

  test("deepseek-reasoner reasoning pricing", () => {
    tracker.record("deepseek", "deepseek-reasoner", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    });
    // $0.55 + $2.19 + $2.19 = $4.93
    expect(tracker.totalCostUSD).toBeCloseTo(4.93, 2);
  });

  // ── Partial model name matching ───────────────────────────────────────

  test("matches model with date suffix", () => {
    tracker.record("anthropic", "claude-sonnet-4-6-20250514-latest", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // Should match claude-sonnet-4-6-20250514 pricing: $3/M input
    expect(tracker.totalCostUSD).toBeCloseTo(3.0, 2);
  });

  test("matches shorter model name to longer key via key.startsWith(model)", () => {
    // "grok-3-fast" starts with "grok-3" — getPricing iterates and finds the first match
    tracker.record("xai", "grok-3", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // grok-3-fast pricing: $0.1/M input
    expect(tracker.totalCostUSD).toBeCloseTo(0.1, 2);
  });

  // ── Unknown model fallback ────────────────────────────────────────────

  test("unknown models get default pricing ($1/M in, $3/M out)", () => {
    tracker.record("custom", "unknown-model-v2", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // Default: $1/M input + $3/M output = $4 total
    expect(tracker.totalCostUSD).toBeCloseTo(4.0, 2);
  });

  test("unknown model reasoning tokens use output rate ($3/M)", () => {
    tracker.record("custom", "mystery-model", {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    // Default fallback: no reasoningPerMillion, so uses outputPerMillion = $3/M
    expect(tracker.totalCostUSD).toBeCloseTo(3.0, 2);
  });

  // ── formatSummary ─────────────────────────────────────────────────────

  test("formatSummary contains cost and token counts", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });

    const summary = tracker.formatSummary();
    expect(summary).toContain("Cost:");
    expect(summary).toContain("1K in");
    expect(summary).toContain("500 out");
  });

  test("formatSummary includes reasoning when present", () => {
    tracker.record("openai", "o1", {
      inputTokens: 10000,
      outputTokens: 5000,
      reasoningTokens: 3000,
    });

    const summary = tracker.formatSummary();
    expect(summary).toContain("reasoning");
    expect(summary).toContain("10K in");
    expect(summary).toContain("5K out");
    expect(summary).toContain("3K reasoning");
  });

  test("formatSummary omits reasoning when zero", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });

    const summary = tracker.formatSummary();
    expect(summary).not.toContain("reasoning");
  });

  test("formatSummary formats millions correctly", () => {
    tracker.record("xai", "grok-3-fast", {
      inputTokens: 2_500_000,
      outputTokens: 1_200_000,
    });

    const summary = tracker.formatSummary();
    expect(summary).toContain("2.5M in");
    expect(summary).toContain("1.2M out");
  });

  // ── Multi-provider breakdown ──────────────────────────────────────────

  test("formatSummary shows per-provider breakdown when multiple providers", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", { inputTokens: 2000, outputTokens: 1000 });

    const summary = tracker.formatSummary();
    expect(summary).toContain("Per provider:");
    expect(summary).toContain("xai:grok-3-fast");
    expect(summary).toContain("anthropic:claude-sonnet-4-6-20250514");
  });

  test("formatSummary does not show breakdown for single provider", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });

    const summary = tracker.formatSummary();
    expect(summary).not.toContain("Per provider:");
  });

  test("multi-provider breakdown includes call counts", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 100, outputTokens: 50 });
    tracker.record("xai", "grok-3-fast", { inputTokens: 100, outputTokens: 50 });
    tracker.record("openai", "gpt-4o", { inputTokens: 200, outputTokens: 100 });

    const summary = tracker.formatSummary();
    expect(summary).toContain("2 calls");
    expect(summary).toContain("1 calls");
  });

  test("getBreakdown returns correct number of entries", () => {
    tracker.record("xai", "grok-3-fast", { inputTokens: 100, outputTokens: 50 });
    tracker.record("openai", "gpt-4o", { inputTokens: 200, outputTokens: 100 });
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", { inputTokens: 300, outputTokens: 150 });

    const breakdown = tracker.getBreakdown();
    expect(breakdown).toHaveLength(3);
  });

  test("totalCostUSD sums across all providers", () => {
    // xai grok-3-fast: (1M/1M)*0.1 + (1M/1M)*0.3 = 0.4
    tracker.record("xai", "grok-3-fast", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // openai gpt-4o: (1M/1M)*2.5 + (1M/1M)*10 = 12.5
    tracker.record("openai", "gpt-4o", { inputTokens: 1_000_000, outputTokens: 1_000_000 });

    expect(tracker.totalCostUSD).toBeCloseTo(12.9, 2);
  });

  // ── Legacy compat getters ─────────────────────────────────────────────

  test("legacy getters match totalTokens", () => {
    tracker.record("openai", "o1", {
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
    });

    expect(tracker.totalInputTokens).toBe(tracker.totalTokens.inputTokens);
    expect(tracker.totalOutputTokens).toBe(tracker.totalTokens.outputTokens);
    expect(tracker.totalReasoningTokens).toBe(tracker.totalTokens.reasoningTokens);
  });
});
