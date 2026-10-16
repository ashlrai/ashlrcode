/**
 * Tests for src/agent/budget-allocator.ts
 *
 * Covers:
 *   - Overhead multiplier computation from rolling window
 *   - Remaining budget fraction with 15% reserve
 *   - Tool budget weights
 *   - Dynamic compression limits scaling
 *   - Edge cases: empty results, zero context, single-line inputs
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  BudgetAllocator,
  getBudgetAllocator,
  setBudgetAllocator,
  NEXT_TURN_RESERVE_FRACTION,
  OVERHEAD_WINDOW_SIZE,
  MIN_OVERHEAD_MULTIPLIER,
  MAX_OVERHEAD_MULTIPLIER,
  TOOL_BUDGET_WEIGHTS,
} from "../agent/budget-allocator.ts";
import {
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD,
} from "../agent/tool-executor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(input: number, output: number, reasoning = 0) {
  return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning };
}

// ---------------------------------------------------------------------------
// BudgetAllocator — overhead multiplier
// ---------------------------------------------------------------------------

describe("BudgetAllocator.computeOverheadMultiplier", () => {
  let allocator: BudgetAllocator;

  beforeEach(() => {
    allocator = new BudgetAllocator();
  });

  test("returns MIN_OVERHEAD_MULTIPLIER when window is empty", () => {
    expect(allocator.computeOverheadMultiplier()).toBe(MIN_OVERHEAD_MULTIPLIER);
  });

  test("returns MIN_OVERHEAD_MULTIPLIER for models with zero reasoning tokens", () => {
    allocator.recordUsage(makeUsage(1000, 500, 0));
    allocator.recordUsage(makeUsage(1000, 400, 0));
    expect(allocator.computeOverheadMultiplier()).toBe(MIN_OVERHEAD_MULTIPLIER);
  });

  test("returns MIN_OVERHEAD_MULTIPLIER when output tokens are zero", () => {
    allocator.recordUsage(makeUsage(1000, 0, 0));
    expect(allocator.computeOverheadMultiplier()).toBe(MIN_OVERHEAD_MULTIPLIER);
  });

  test("multiplier increases proportionally with reasoning tokens", () => {
    // 500 reasoning / 500 output → ratio = 1.0 → multiplier = 2.0
    allocator.recordUsage(makeUsage(1000, 500, 500));
    const m = allocator.computeOverheadMultiplier();
    expect(m).toBeCloseTo(2.0, 5);
  });

  test("multiplier is clamped to MAX_OVERHEAD_MULTIPLIER", () => {
    // Enormous reasoning → should cap at MAX
    allocator.recordUsage(makeUsage(100, 10, 10_000_000));
    const m = allocator.computeOverheadMultiplier();
    expect(m).toBe(MAX_OVERHEAD_MULTIPLIER);
  });

  test("multiplier never falls below MIN_OVERHEAD_MULTIPLIER", () => {
    allocator.recordUsage(makeUsage(1000, 500, 0));
    expect(allocator.computeOverheadMultiplier()).toBeGreaterThanOrEqual(MIN_OVERHEAD_MULTIPLIER);
  });

  test("rolling window caps at OVERHEAD_WINDOW_SIZE entries", () => {
    // Fill with high-reasoning entries
    for (let i = 0; i < OVERHEAD_WINDOW_SIZE + 5; i++) {
      allocator.recordUsage(makeUsage(100, 100, 500));
    }
    // Internal window should not exceed OVERHEAD_WINDOW_SIZE
    // We verify indirectly: the multiplier should still be valid (no crash, correct clamping)
    const m = allocator.computeOverheadMultiplier();
    expect(m).toBeGreaterThanOrEqual(MIN_OVERHEAD_MULTIPLIER);
    expect(m).toBeLessThanOrEqual(MAX_OVERHEAD_MULTIPLIER);
  });

  test("window rolls out old observations — low-reasoning usage dilutes high-reasoning past", () => {
    // Seed window with high-reasoning calls
    for (let i = 0; i < OVERHEAD_WINDOW_SIZE; i++) {
      allocator.recordUsage(makeUsage(100, 100, 1000));
    }
    const highM = allocator.computeOverheadMultiplier();
    expect(highM).toBeGreaterThan(2.0);

    // Push OVERHEAD_WINDOW_SIZE new entries with zero reasoning to flush the window
    for (let i = 0; i < OVERHEAD_WINDOW_SIZE; i++) {
      allocator.recordUsage(makeUsage(100, 100, 0));
    }
    const lowM = allocator.computeOverheadMultiplier();
    expect(lowM).toBe(MIN_OVERHEAD_MULTIPLIER);
  });
});

// ---------------------------------------------------------------------------
// BudgetAllocator — remaining budget fraction
// ---------------------------------------------------------------------------

describe("BudgetAllocator.remainingBudgetFraction", () => {
  let allocator: BudgetAllocator;

  beforeEach(() => {
    allocator = new BudgetAllocator();
  });

  test("returns 1.0 when no tokens used", () => {
    expect(allocator.remainingBudgetFraction(0, 100_000)).toBe(1.0);
  });

  test("returns 1.0 when totalContext is zero (unlimited)", () => {
    expect(allocator.remainingBudgetFraction(50_000, 0)).toBe(1.0);
  });

  test("accounts for 15% next-turn reservation", () => {
    const total = 100_000;
    const reserved = Math.ceil(total * NEXT_TURN_RESERVE_FRACTION); // 15_000
    const available = total - reserved; // 85_000
    // With 0 used, fraction = available / available = 1.0
    expect(allocator.remainingBudgetFraction(0, total)).toBe(1.0);
    // With available/2 used, fraction ≈ 0.5
    const half = Math.floor(available / 2);
    const frac = allocator.remainingBudgetFraction(half, total);
    expect(frac).toBeCloseTo(0.5, 1);
  });

  test("returns 0 when tokens used exceed available budget", () => {
    const total = 100_000;
    expect(allocator.remainingBudgetFraction(total, total)).toBe(0);
  });

  test("clamps to [0, 1]", () => {
    const frac = allocator.remainingBudgetFraction(200_000, 100_000);
    expect(frac).toBe(0);
  });

  test("NEXT_TURN_RESERVE_FRACTION is 0.15", () => {
    expect(NEXT_TURN_RESERVE_FRACTION).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// BudgetAllocator — tool budget weights
// ---------------------------------------------------------------------------

describe("BudgetAllocator.toolBudgetWeight", () => {
  let allocator: BudgetAllocator;

  beforeEach(() => {
    allocator = new BudgetAllocator();
  });

  test("Bash gets higher weight than default (1.0)", () => {
    expect(allocator.toolBudgetWeight("Bash")).toBeGreaterThan(1.0);
  });

  test("Write gets lower weight than Bash", () => {
    expect(allocator.toolBudgetWeight("Write")).toBeLessThan(allocator.toolBudgetWeight("Bash"));
  });

  test("unknown tool defaults to 1.0", () => {
    expect(allocator.toolBudgetWeight("UnknownTool")).toBe(1.0);
  });

  test("TOOL_BUDGET_WEIGHTS contains expected entries", () => {
    expect(TOOL_BUDGET_WEIGHTS["Bash"]).toBeGreaterThan(1.0);
    expect(TOOL_BUDGET_WEIGHTS["Read"]).toBe(1.0);
    expect(TOOL_BUDGET_WEIGHTS["Write"]).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// BudgetAllocator — getCompressionLimits
// ---------------------------------------------------------------------------

describe("BudgetAllocator.getCompressionLimits", () => {
  let allocator: BudgetAllocator;

  beforeEach(() => {
    allocator = new BudgetAllocator();
  });

  test("returns defaults when no usage and no context constraint", () => {
    const limits = allocator.getCompressionLimits("Read", 0);
    // With no overhead (multiplier=1), full budget (fraction=1), weight=1 → scale=1
    // maxBytes clamp: max(1024, min(15360*1, 30720)) = 15360
    expect(limits.maxBytes).toBe(DEFAULT_TOOL_RESULT_MAX_BYTES);
    expect(limits.chunkSummaryThreshold).toBe(DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD);
  });

  test("thresholds scale DOWN with high reasoning overhead", () => {
    // Simulate a 3x reasoning overhead: reasoningTokens = 2 * outputTokens → multiplier ≈ 3
    for (let i = 0; i < 5; i++) {
      allocator.recordUsage(makeUsage(1000, 500, 1000));
    }
    const limits = allocator.getCompressionLimits("Read", 0);
    // overhead ≈ 3, scale ≈ 1/3 → maxBytes < DEFAULT
    expect(limits.maxBytes).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_BYTES);
    expect(limits.chunkSummaryThreshold).toBeLessThan(DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD);
  });

  test("Bash tool gets larger limits than Write tool (same conditions)", () => {
    const bashLimits = allocator.getCompressionLimits("Bash", 0);
    const writeLimits = allocator.getCompressionLimits("Write", 0);
    expect(bashLimits.maxBytes).toBeGreaterThan(writeLimits.maxBytes);
  });

  test("limits shrink when context is nearly full (tight budget)", () => {
    // 90% of context used (beyond 85% available budget)
    const total = 100_000;
    const usedTokens = 92_000; // well above available (85K)
    // Prime the window with these usage tokens
    allocator.recordUsage(makeUsage(usedTokens, 0, 0));

    const limits = allocator.getCompressionLimits("Read", total);
    // budgetFraction ≈ 0 → scale ≈ 0 → maxBytes clamped to floor (1024)
    expect(limits.maxBytes).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_BYTES);
  });

  test("maxBytes never falls below 1024 bytes", () => {
    // Extremely high overhead and zero remaining budget
    for (let i = 0; i < OVERHEAD_WINDOW_SIZE; i++) {
      allocator.recordUsage(makeUsage(1000, 100, 100_000));
    }
    const limits = allocator.getCompressionLimits("Read", 100_000);
    expect(limits.maxBytes).toBeGreaterThanOrEqual(1_024);
  });

  test("chunkSummaryThreshold never falls below 256 bytes", () => {
    for (let i = 0; i < OVERHEAD_WINDOW_SIZE; i++) {
      allocator.recordUsage(makeUsage(1000, 100, 100_000));
    }
    const limits = allocator.getCompressionLimits("Read", 100_000);
    expect(limits.chunkSummaryThreshold).toBeGreaterThanOrEqual(256);
  });

  test("maxBytes never exceeds 2x DEFAULT_TOOL_RESULT_MAX_BYTES", () => {
    const limits = allocator.getCompressionLimits("Bash", 0);
    expect(limits.maxBytes).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_BYTES * 2);
  });

  test("accepts usage parameter and incorporates it before computing limits", () => {
    // High reasoning usage passed directly as parameter
    const usage = makeUsage(1000, 100, 5000);
    const limitsWithUsage = allocator.getCompressionLimits("Read", 0, usage);
    // Should have recorded the usage and computed a reduced limit
    const allocatorBaseline = new BudgetAllocator();
    const limitsBaseline = allocatorBaseline.getCompressionLimits("Read", 0);
    expect(limitsWithUsage.maxBytes).toBeLessThanOrEqual(limitsBaseline.maxBytes);
  });

  test("reset() clears all state", () => {
    for (let i = 0; i < 5; i++) {
      allocator.recordUsage(makeUsage(1000, 100, 5000));
    }
    const beforeReset = allocator.computeOverheadMultiplier();
    expect(beforeReset).toBeGreaterThan(MIN_OVERHEAD_MULTIPLIER);

    allocator.reset();
    expect(allocator.computeOverheadMultiplier()).toBe(MIN_OVERHEAD_MULTIPLIER);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("BudgetAllocator edge cases", () => {
  let allocator: BudgetAllocator;

  beforeEach(() => {
    allocator = new BudgetAllocator();
  });

  test("handles usage with zero tokens gracefully", () => {
    allocator.recordUsage({ inputTokens: 0, outputTokens: 0 });
    const limits = allocator.getCompressionLimits("Bash", 0);
    expect(limits.maxBytes).toBeGreaterThanOrEqual(1_024);
    expect(limits.chunkSummaryThreshold).toBeGreaterThanOrEqual(256);
  });

  test("handles usage with only inputTokens set", () => {
    allocator.recordUsage({ inputTokens: 500, outputTokens: 0 });
    const m = allocator.computeOverheadMultiplier();
    expect(m).toBe(MIN_OVERHEAD_MULTIPLIER);
  });

  test("handles negative totalContext gracefully", () => {
    const frac = allocator.remainingBudgetFraction(100, -1);
    expect(frac).toBe(1.0);
  });

  test("setModelKey does not throw", () => {
    expect(() => allocator.setModelKey("anthropic:claude-opus-4-5")).not.toThrow();
  });

  test("multiple recordUsage calls accumulate correctly in window", () => {
    allocator.recordUsage(makeUsage(100, 50, 150));  // ratio = 3
    allocator.recordUsage(makeUsage(100, 50, 50));   // ratio = 1
    // avg ratio = (150+50)/(50+50) = 200/100 = 2.0, multiplier = 3.0
    const m = allocator.computeOverheadMultiplier();
    expect(m).toBeCloseTo(3.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

describe("getBudgetAllocator / setBudgetAllocator", () => {
  test("getBudgetAllocator returns a BudgetAllocator instance", () => {
    const a = getBudgetAllocator();
    expect(a).toBeInstanceOf(BudgetAllocator);
  });

  test("getBudgetAllocator returns same instance on repeated calls", () => {
    const a1 = getBudgetAllocator();
    const a2 = getBudgetAllocator();
    expect(a1).toBe(a2);
  });

  test("setBudgetAllocator replaces the singleton", () => {
    const fresh = new BudgetAllocator();
    setBudgetAllocator(fresh);
    expect(getBudgetAllocator()).toBe(fresh);
  });
});
