/**
 * Tests for src/agent/cost-estimator.ts
 *
 * Covers:
 *  - Goal complexity scoring (keyword signals, phrase detection, file heuristics)
 *  - Turn / token estimation
 *  - Budget bounds checking
 *  - Provider recommendation logic (cheapest first)
 *  - Estimate caching (5-min TTL, cache key includes maxCost + provider)
 *  - Edge cases: empty goal, exotic goals, very long goals, no history
 *  - historicalAverageCost from cost-tracker
 *  - formatCostEstimate output shape
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  analyzeGoalComplexity,
  estimateTurnsAndTokens,
  estimateGoalCost,
  formatCostEstimate,
  clearEstimateCache,
  getEstimateCacheSize,
  KEYWORD_MULTIPLIERS,
  PROVIDER_RATE_TABLE,
  BASE_TURNS,
  BASE_TOKENS_PER_TURN,
  TOKENS_PER_FILE,
} from "../agent/cost-estimator.ts";
import { CostTracker, historicalAverageCost } from "../providers/cost-tracker.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshEstimate(goal: string, maxCostUSD?: number, defaultProvider = "xai") {
  clearEstimateCache();
  return estimateGoalCost(goal, { maxCostUSD, defaultProvider });
}

// ---------------------------------------------------------------------------
// analyzeGoalComplexity
// ---------------------------------------------------------------------------

describe("analyzeGoalComplexity — keyword signals", () => {
  test("baseline goal with no keywords returns score ~1.0", () => {
    const { score, signals } = analyzeGoalComplexity("update the readme");
    expect(score).toBeCloseTo(1.0, 1);
    expect(signals).toHaveLength(0);
  });

  test('"refactor" keyword applies 2.5× multiplier', () => {
    const { score, signals } = analyzeGoalComplexity("refactor the router");
    expect(score).toBeCloseTo(2.5, 1);
    expect(signals.some((s) => s.includes("refactor"))).toBe(true);
  });

  test('"rewrite" keyword applies 2.5× multiplier', () => {
    const { score } = analyzeGoalComplexity("rewrite the session layer");
    expect(score).toBeCloseTo(2.5, 1);
  });

  test('"debug" keyword applies 1.6× multiplier', () => {
    const { score } = analyzeGoalComplexity("debug the login flow");
    expect(score).toBeCloseTo(1.6, 1);
  });

  test('"test" keyword applies 1.4× multiplier', () => {
    const { score } = analyzeGoalComplexity("add test coverage");
    expect(score).toBeCloseTo(1.4, 1);
  });

  test('"with tests" phrase takes priority over individual "test" word', () => {
    const { score, signals } = analyzeGoalComplexity("refactor auth module with tests");
    // "refactor" × "with tests" = 2.5 × 1.4 = 3.5
    expect(score).toBeCloseTo(3.5, 1);
    expect(signals.some((s) => s.includes("with tests"))).toBe(true);
  });

  test('"and tests" phrase detected', () => {
    const { score } = analyzeGoalComplexity("rewrite parser and tests");
    expect(score).toBeCloseTo(2.5 * 1.4, 1);
  });

  test('"rename" keyword reduces score below 1.0 (0.6×)', () => {
    const { score } = analyzeGoalComplexity("rename the variable");
    expect(score).toBeCloseTo(0.6, 1);
  });

  test('"typo" keyword applies 0.4× multiplier', () => {
    const { score } = analyzeGoalComplexity("fix typo in docs");
    // "fix" × "typo" = 1.3 × 0.4 = 0.52
    expect(score).toBeCloseTo(0.52, 1);
  });

  test("multiple stacking keywords multiply (not add)", () => {
    const { score } = analyzeGoalComplexity("optimize performance");
    // 1.5 × 1.5 = 2.25
    expect(score).toBeCloseTo(2.25, 1);
  });

  test("score is clamped to max 10.0", () => {
    const { score } = analyzeGoalComplexity(
      "refactor rewrite migrate redesign optimize security debug performance entire every all",
    );
    expect(score).toBeLessThanOrEqual(10.0);
  });

  test("score is clamped to min 0.3", () => {
    const { score } = analyzeGoalComplexity("rename typo format lint comment");
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  test("case-insensitive keyword matching", () => {
    const lower = analyzeGoalComplexity("refactor the code");
    const upper = analyzeGoalComplexity("REFACTOR THE CODE");
    expect(lower.score).toBeCloseTo(upper.score, 3);
  });
});

// ---------------------------------------------------------------------------
// analyzeGoalComplexity — file count heuristics
// ---------------------------------------------------------------------------

describe("analyzeGoalComplexity — file count heuristics", () => {
  test("explicit file count extracted from goal", () => {
    const { estimatedFileCount } = analyzeGoalComplexity("update 5 files in the config directory");
    expect(estimatedFileCount).toBe(5);
  });

  test('"module" keyword sets fileCount to at least 8', () => {
    const { estimatedFileCount } = analyzeGoalComplexity("refactor the auth module");
    expect(estimatedFileCount).toBeGreaterThanOrEqual(8);
  });

  test('"auth" keyword sets fileCount to at least 12', () => {
    const { estimatedFileCount } = analyzeGoalComplexity("fix authentication bug");
    expect(estimatedFileCount).toBeGreaterThanOrEqual(12);
  });

  test('"database" keyword sets fileCount to at least 12', () => {
    const { estimatedFileCount } = analyzeGoalComplexity("migrate database schema");
    expect(estimatedFileCount).toBeGreaterThanOrEqual(12);
  });

  test("no file hints returns 0", () => {
    const { estimatedFileCount } = analyzeGoalComplexity("fix the typo");
    expect(estimatedFileCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateTurnsAndTokens
// ---------------------------------------------------------------------------

describe("estimateTurnsAndTokens", () => {
  test("baseline score=1 with no files returns BASE_TURNS * BASE_TOKENS_PER_TURN", () => {
    const { turns, tokens } = estimateTurnsAndTokens(1.0, 0);
    expect(turns).toBe(BASE_TURNS);
    expect(tokens).toBe(BASE_TOKENS_PER_TURN * 1.0 * BASE_TURNS);
  });

  test("file count contributes TOKENS_PER_FILE per file", () => {
    const noFiles = estimateTurnsAndTokens(1.0, 0);
    const withFiles = estimateTurnsAndTokens(1.0, 10);
    expect(withFiles.tokens - noFiles.tokens).toBe(10 * TOKENS_PER_FILE);
  });

  test("score=2.5 doubles turns relative to baseline", () => {
    const base = estimateTurnsAndTokens(1.0, 0);
    const high = estimateTurnsAndTokens(2.5, 0);
    expect(high.turns).toBeGreaterThan(base.turns);
    expect(high.tokens).toBeGreaterThan(base.tokens);
  });

  test("minimum 1 turn even for very low score", () => {
    const { turns } = estimateTurnsAndTokens(0.01, 0);
    expect(turns).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// estimateGoalCost — main estimator
// ---------------------------------------------------------------------------

describe("estimateGoalCost — basic behavior", () => {
  beforeEach(() => clearEstimateCache());

  test("empty goal returns zero-cost estimate", () => {
    const est = estimateGoalCost("");
    expect(est.estimatedTokens).toBe(0);
    expect(est.costUSD).toBe(0);
    expect(est.turnsNeeded).toBe(0);
    expect(est.budgetOK).toBe(true);
    expect(est.alternativeProviders).toHaveLength(0);
  });

  test("whitespace-only goal returns zero-cost estimate", () => {
    const est = estimateGoalCost("   ");
    expect(est.costUSD).toBe(0);
  });

  test("normal goal returns positive cost and turns", () => {
    const est = freshEstimate("refactor auth module with tests");
    expect(est.estimatedTokens).toBeGreaterThan(0);
    expect(est.costUSD).toBeGreaterThan(0);
    expect(est.turnsNeeded).toBeGreaterThanOrEqual(1);
  });

  test("complexityScore is included in result", () => {
    const est = freshEstimate("refactor auth module with tests");
    expect(est.complexityScore).toBeGreaterThan(1.0);
  });

  test("complexityBreakdown is non-empty for keywords", () => {
    const est = freshEstimate("refactor auth module with tests");
    expect(est.complexityBreakdown.length).toBeGreaterThan(0);
    expect(est.complexityBreakdown.some((s) => s.length > 0)).toBe(true);
  });

  test("alternativeProviders includes all entries from PROVIDER_RATE_TABLE", () => {
    const est = freshEstimate("fix a bug");
    expect(est.alternativeProviders).toHaveLength(PROVIDER_RATE_TABLE.length);
  });

  test("alternativeProviders are sorted cheapest first", () => {
    const est = freshEstimate("fix a bug");
    for (let i = 1; i < est.alternativeProviders.length; i++) {
      expect(est.alternativeProviders[i]!.costUSD).toBeGreaterThanOrEqual(
        est.alternativeProviders[i - 1]!.costUSD,
      );
    }
  });

  test("each provider alternative has required fields", () => {
    const est = freshEstimate("optimize performance");
    for (const p of est.alternativeProviders) {
      expect(typeof p.provider).toBe("string");
      expect(typeof p.model).toBe("string");
      expect(typeof p.costUSD).toBe("number");
      expect(typeof p.turnsNeeded).toBe("number");
      expect(["fast", "balanced", "slow"]).toContain(p.speed);
    }
  });
});

// ---------------------------------------------------------------------------
// estimateGoalCost — budget compliance
// ---------------------------------------------------------------------------

describe("estimateGoalCost — budget compliance", () => {
  beforeEach(() => clearEstimateCache());

  test("budgetOK=true when no maxCostUSD provided", () => {
    const est = freshEstimate("refactor auth module");
    expect(est.budgetOK).toBe(true);
  });

  test("budgetOK=true when cost is under maxCostUSD", () => {
    // Tiny goal should be well under $1000
    const est = freshEstimate("fix typo", 1000);
    expect(est.budgetOK).toBe(true);
  });

  test("budgetOK=false when cost exceeds maxCostUSD", () => {
    // Force violation with essentially zero budget
    const est = freshEstimate("refactor entire architecture", 0.000001);
    expect(est.budgetOK).toBe(false);
  });

  test("different maxCostUSD produces different budgetOK", () => {
    const estTight = freshEstimate("optimize performance security", 0.000001);
    const estLoose = freshEstimate("optimize performance security", 9999);
    expect(estTight.budgetOK).toBe(false);
    expect(estLoose.budgetOK).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimateGoalCost — provider recommendation
// ---------------------------------------------------------------------------

describe("estimateGoalCost — provider recommendations", () => {
  beforeEach(() => clearEstimateCache());

  test("DeepSeek is cheaper than Anthropic Opus for same token count", () => {
    const est = freshEstimate("refactor everything");
    const deepseek = est.alternativeProviders.find((p) => p.provider === "deepseek" && p.model.includes("chat"));
    const opus = est.alternativeProviders.find((p) => p.model.includes("opus"));
    expect(deepseek).toBeDefined();
    expect(opus).toBeDefined();
    expect(deepseek!.costUSD).toBeLessThan(opus!.costUSD);
  });

  test("xAI grok-3-fast appears in provider list", () => {
    const est = freshEstimate("fix a bug");
    const xai = est.alternativeProviders.find((p) => p.provider === "xai" && p.model === "grok-3-fast");
    expect(xai).toBeDefined();
  });

  test("all turns are equal across providers (same turn estimate)", () => {
    const est = freshEstimate("add caching to login flow");
    const turns = est.alternativeProviders.map((p) => p.turnsNeeded);
    expect(new Set(turns).size).toBe(1); // all providers share same turn estimate
  });
});

// ---------------------------------------------------------------------------
// estimateGoalCost — cache behavior
// ---------------------------------------------------------------------------

describe("estimateGoalCost — 5-minute result cache", () => {
  beforeEach(() => clearEstimateCache());

  test("same goal returns cached result (reference equality)", () => {
    const first = estimateGoalCost("fix a bug", { maxCostUSD: 1 });
    const second = estimateGoalCost("fix a bug", { maxCostUSD: 1 });
    // Same object — proves the cache hit returned the exact same reference
    expect(first).toBe(second);
  });

  test("different goal busts the cache key", () => {
    const a = estimateGoalCost("fix a bug");
    const b = estimateGoalCost("add a feature");
    expect(a).not.toBe(b);
  });

  test("different maxCostUSD busts the cache key", () => {
    const a = estimateGoalCost("fix a bug", { maxCostUSD: 1 });
    const b = estimateGoalCost("fix a bug", { maxCostUSD: 2 });
    expect(a).not.toBe(b);
  });

  test("different defaultProvider busts the cache key", () => {
    const a = estimateGoalCost("fix a bug", { defaultProvider: "xai" });
    const b = estimateGoalCost("fix a bug", { defaultProvider: "anthropic" });
    expect(a).not.toBe(b);
  });

  test("clearEstimateCache empties the cache", () => {
    estimateGoalCost("fix a bug");
    expect(getEstimateCacheSize()).toBeGreaterThan(0);
    clearEstimateCache();
    expect(getEstimateCacheSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// historicalAverageCost from cost-tracker
// ---------------------------------------------------------------------------

describe("historicalAverageCost", () => {
  test("returns undefined when tracker has no records", () => {
    const tracker = new CostTracker();
    const result = historicalAverageCost("fix bug", tracker);
    expect(result).toBeUndefined();
  });

  test("returns Cost object when tracker has records", () => {
    const tracker = new CostTracker();
    tracker.record("xai", "grok-3-fast", { inputTokens: 10_000, outputTokens: 5_000 });
    const result = historicalAverageCost("fix bug", tracker);
    expect(result).toBeDefined();
    expect(result!.turns).toBe(1);
    expect(result!.totalCostUSD).toBeGreaterThan(0);
    expect(result!.totalTokens).toBe(15_000);
  });

  test("accumulates across multiple turns", () => {
    const tracker = new CostTracker();
    tracker.record("xai", "grok-3-fast", { inputTokens: 5_000, outputTokens: 2_000 });
    tracker.record("xai", "grok-3-fast", { inputTokens: 5_000, outputTokens: 3_000 });
    const result = historicalAverageCost("any goal", tracker);
    expect(result!.turns).toBe(2);
    expect(result!.totalTokens).toBe(15_000);
  });

  test("goal parameter is accepted without throwing", () => {
    const tracker = new CostTracker();
    tracker.record("anthropic", "claude-sonnet-4-6-20250514", { inputTokens: 1000, outputTokens: 500 });
    expect(() => historicalAverageCost("refactor auth module with tests", tracker)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatCostEstimate — output shape
// ---------------------------------------------------------------------------

describe("formatCostEstimate — output shape", () => {
  beforeEach(() => clearEstimateCache());

  test("output contains the goal text", () => {
    const est = freshEstimate("refactor auth module with tests");
    const out = formatCostEstimate("refactor auth module with tests", est);
    expect(out).toContain("refactor auth module with tests");
  });

  test("output contains provider names from PROVIDER_RATE_TABLE", () => {
    const est = freshEstimate("fix a bug");
    const out = formatCostEstimate("fix a bug", est);
    expect(out).toContain("xai");
    expect(out).toContain("anthropic");
    expect(out).toContain("deepseek");
  });

  test("output contains cost figures", () => {
    const est = freshEstimate("fix a bug");
    const out = formatCostEstimate("fix a bug", est);
    expect(out).toMatch(/\$[\d.]+|<\$0\.001/);
  });

  test("output contains complexity score", () => {
    const est = freshEstimate("refactor auth");
    const out = formatCostEstimate("refactor auth", est);
    expect(out).toContain("Complexity score");
  });

  test("budget exceeded shows warning text", () => {
    const est = freshEstimate("refactor entire architecture", 0.000001);
    const out = formatCostEstimate("refactor entire architecture", est, 0.000001);
    expect(out).toContain("EXCEEDS");
  });

  test("budget OK shows OK text", () => {
    const est = freshEstimate("fix typo", 1000);
    const out = formatCostEstimate("fix typo", est, 1000);
    expect(out).toContain("OK");
  });

  test("no maxCostUSD omits budget section", () => {
    const est = freshEstimate("fix typo");
    const out = formatCostEstimate("fix typo", est);
    expect(out).not.toContain("Budget:");
  });

  test("goal longer than 70 chars is truncated in header", () => {
    const longGoal = "a".repeat(100);
    const est = freshEstimate(longGoal);
    const out = formatCostEstimate(longGoal, est);
    expect(out).toContain("...");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("estimateGoalCost — edge cases", () => {
  beforeEach(() => clearEstimateCache());

  test("very short goal (single word) does not throw", () => {
    expect(() => freshEstimate("fix")).not.toThrow();
  });

  test("goal with only numbers does not throw", () => {
    expect(() => freshEstimate("12345")).not.toThrow();
  });

  test("goal with special characters does not throw", () => {
    expect(() => freshEstimate("fix bug in src/auth/login.ts")).not.toThrow();
  });

  test("extremely long goal does not throw", () => {
    const longGoal = "refactor ".repeat(50);
    expect(() => freshEstimate(longGoal)).not.toThrow();
  });

  test("exotic goal with no signal keywords returns baseline-ish score", () => {
    const est = freshEstimate("xyzzy frobnicate the quux");
    expect(est.complexityScore).toBeGreaterThanOrEqual(0.3);
    expect(est.complexityScore).toBeLessThanOrEqual(2.0);
  });

  test("historicalAvgCostPerTurn provided and does not crash estimator", () => {
    clearEstimateCache();
    const est = estimateGoalCost("add feature", { historicalAvgCostPerTurn: 0.05 });
    expect(est.costUSD).toBeGreaterThan(0);
  });
});
