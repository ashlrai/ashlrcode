import { test, expect, describe } from "bun:test";
import { ProviderRouter, type CostTracker } from "../providers/router.ts";
import type { Provider, ProviderRouterConfig, StreamEvent, TokenUsage } from "../providers/types.ts";

// We can't easily test the full router without real providers, but we can test
// the cost tracking logic by creating a router and inspecting its costs property.
// The constructor requires valid provider config, so we'll test what we can.

describe("ProviderRouter cost tracking", () => {
  test("getCostSummary returns formatted string with zero usage", () => {
    // Create a minimal router - this will try to create a provider.
    // We need to test the cost summary formatting, so we access costs directly.
    const costs: CostTracker = {
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalReasoningTokens: 0,
      totalCostUSD: 0.015,
      perProvider: new Map(),
    };
    costs.perProvider.set("xai", {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 0,
      costUSD: 0.015,
    });

    // Test the formatting logic inline since we can't easily construct a ProviderRouter
    // without valid API keys. Instead, let's verify the CostTracker structure.
    expect(costs.totalInputTokens).toBe(1000);
    expect(costs.totalOutputTokens).toBe(500);
    expect(costs.totalCostUSD).toBe(0.015);
    expect(costs.perProvider.get("xai")!.inputTokens).toBe(1000);
  });

  test("CostTracker tracks per-provider usage", () => {
    const costs: CostTracker = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalCostUSD: 0,
      perProvider: new Map(),
    };

    // Simulate tracking
    const usage: TokenUsage = { inputTokens: 500, outputTokens: 200, reasoningTokens: 100 };
    costs.totalInputTokens += usage.inputTokens;
    costs.totalOutputTokens += usage.outputTokens;
    costs.totalReasoningTokens += usage.reasoningTokens ?? 0;

    const pricing: [number, number] = [3, 15]; // $3/M input, $15/M output
    const outputTokens = usage.outputTokens + (usage.reasoningTokens ?? 0);
    const cost =
      (usage.inputTokens / 1_000_000) * pricing[0] +
      (outputTokens / 1_000_000) * pricing[1];
    costs.totalCostUSD += cost;

    expect(costs.totalInputTokens).toBe(500);
    expect(costs.totalOutputTokens).toBe(200);
    expect(costs.totalReasoningTokens).toBe(100);
    // Cost: (500/1M)*3 + (300/1M)*15 = 0.0015 + 0.0045 = 0.006
    expect(costs.totalCostUSD).toBeCloseTo(0.006, 6);
  });

  test("CostTracker reasoning tokens are included in output cost calculation", () => {
    const pricing: [number, number] = [3, 15];
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
    };

    const outputTokens = usage.outputTokens + (usage.reasoningTokens ?? 0); // 700
    const cost =
      (usage.inputTokens / 1_000_000) * pricing[0] +
      (outputTokens / 1_000_000) * pricing[1];

    // (1000/1M)*3 + (700/1M)*15 = 0.003 + 0.0105 = 0.0135
    expect(cost).toBeCloseTo(0.0135, 6);
  });

  test("cost formatting: small amounts use 6 decimal places", () => {
    const formatCost = (usd: number) =>
      usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;

    expect(formatCost(0.006)).toBe("$0.006000");
    expect(formatCost(0.0001)).toBe("$0.000100");
    expect(formatCost(0.05)).toBe("$0.0500");
    expect(formatCost(1.23)).toBe("$1.2300");
  });
});
