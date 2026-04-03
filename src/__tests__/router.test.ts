import { test, expect, describe } from "bun:test";
import { ProviderRouter, CostTracker } from "../providers/router.ts";

// We can't easily test the full router without real providers, but we can test
// the cost tracking logic by creating a CostTracker directly.

describe("CostTracker", () => {
  test("record accumulates usage and computes cost", () => {
    const tracker = new CostTracker();
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", {
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(tracker.totalInputTokens).toBe(1000);
    expect(tracker.totalOutputTokens).toBe(500);
    // (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
    expect(tracker.totalCostUSD).toBeCloseTo(0.0105, 6);
  });

  test("reasoning tokens use separate pricing when available", () => {
    const tracker = new CostTracker();
    tracker.record("openai", "o1", {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
    });

    expect(tracker.totalTokens.reasoningTokens).toBe(200);
    // (1000/1M)*15 + (500/1M)*60 + (200/1M)*60 = 0.015 + 0.030 + 0.012 = 0.057
    expect(tracker.totalCostUSD).toBeCloseTo(0.057, 6);
  });

  test("multiple calls to same provider:model accumulate", () => {
    const tracker = new CostTracker();
    tracker.record("xai", "grok-3-fast", { inputTokens: 500, outputTokens: 200 });
    tracker.record("xai", "grok-3-fast", { inputTokens: 500, outputTokens: 300 });

    const breakdown = tracker.getBreakdown();
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]!.calls).toBe(2);
    expect(breakdown[0]!.usage.inputTokens).toBe(1000);
    expect(breakdown[0]!.usage.outputTokens).toBe(500);
  });

  test("multiple providers show in breakdown", () => {
    const tracker = new CostTracker();
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", { inputTokens: 2000, outputTokens: 1000 });

    const breakdown = tracker.getBreakdown();
    expect(breakdown).toHaveLength(2);
    expect(tracker.totalInputTokens).toBe(3000);
    expect(tracker.totalOutputTokens).toBe(1500);
  });

  test("formatSummary includes reasoning when present", () => {
    const tracker = new CostTracker();
    tracker.record("openai", "o1", {
      inputTokens: 10000,
      outputTokens: 5000,
      reasoningTokens: 3000,
    });

    const summary = tracker.formatSummary();
    expect(summary).toContain("Cost:");
    expect(summary).toContain("reasoning");
    expect(summary).toContain("10K in");
    expect(summary).toContain("5K out");
    expect(summary).toContain("3K reasoning");
  });

  test("formatSummary omits reasoning when zero", () => {
    const tracker = new CostTracker();
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });

    const summary = tracker.formatSummary();
    expect(summary).not.toContain("reasoning");
  });

  test("formatSummary shows per-provider breakdown when multiple providers", () => {
    const tracker = new CostTracker();
    tracker.record("xai", "grok-3-fast", { inputTokens: 1000, outputTokens: 500 });
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", { inputTokens: 2000, outputTokens: 1000 });

    const summary = tracker.formatSummary();
    expect(summary).toContain("Per provider:");
    expect(summary).toContain("xai:grok-3-fast");
    expect(summary).toContain("anthropic:claude-sonnet-4-6-20250514");
  });

  test("unknown models get default pricing", () => {
    const tracker = new CostTracker();
    tracker.record("custom", "unknown-model-v2", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    // Default: $1/M input, $3/M output = $4 total
    expect(tracker.totalCostUSD).toBeCloseTo(4.0, 2);
  });

  test("partial model name matching works", () => {
    const tracker = new CostTracker();
    // "claude-sonnet-4-6-20250514" should match even with extra suffix
    tracker.record("anthropic", "claude-sonnet-4-6-20250514-latest", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });

    // Should match claude-sonnet-4-6 pricing: $3/M input
    expect(tracker.totalCostUSD).toBeCloseTo(3.0, 2);
  });
});

describe("ProviderRouter", () => {
  test("uses the provider-specific name for OpenAI-compatible configs", () => {
    const router = new ProviderRouter({
      primary: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test",
      },
    });

    expect(router.currentProvider.name).toBe("openai");
  });

  test("getCostSummary delegates to costTracker.formatSummary", () => {
    const router = new ProviderRouter({
      primary: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4o",
      },
    });

    // Both should return the same result
    expect(router.getCostSummary()).toBe(router.costTracker.formatSummary());
  });

  test("legacy costs getter provides backward-compatible shape", () => {
    const router = new ProviderRouter({
      primary: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4o",
      },
    });

    const costs = router.costs;
    expect(costs.totalInputTokens).toBe(0);
    expect(costs.totalOutputTokens).toBe(0);
    expect(costs.totalReasoningTokens).toBe(0);
    expect(costs.totalCostUSD).toBe(0);
    expect(costs.perProvider).toBeInstanceOf(Map);
  });
});
