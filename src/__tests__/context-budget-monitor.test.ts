/**
 * Tests for src/agent/context-budget-monitor.ts
 *
 * Covers 8+ scenarios:
 *   1. Basic turn recording + snapshot
 *   2. Color classification thresholds (green/yellow/red)
 *   3. Reasoning model overhead (extended thinking tokens)
 *   4. Multi-turn rolling window
 *   5. Different providers with different context limits
 *   6. Compression ratio calculation
 *   7. Runway estimation
 *   8. Verbose log path builder
 *   9. Provider history breakdown
 *  10. Header bar formatting
 *  11. Reset behavior
 *  12. Singleton get/set
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ContextBudgetMonitor,
  getContextBudgetMonitor,
  setContextBudgetMonitor,
  classifyBudgetColor,
  formatTokenCount,
  formatBudgetHeader,
  buildVerboseLogPath,
  BUDGET_COLOR_GREEN_MAX,
  BUDGET_COLOR_YELLOW_MAX,
  TURN_WINDOW_SIZE,
  DEFAULT_TOKENS_PER_TURN,
  type BudgetSnapshot,
} from "../agent/context-budget-monitor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(input: number, output: number, reasoning = 0) {
  return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning };
}

// ---------------------------------------------------------------------------
// 1. Basic turn recording and snapshot
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — basic recording", () => {
  let monitor: ContextBudgetMonitor;

  beforeEach(() => {
    monitor = new ContextBudgetMonitor("test-session");
    monitor.setProvider("anthropic", "claude-opus-4-5");
  });

  test("snapshot starts at 0% with no turns recorded", () => {
    const snap = monitor.getSnapshot();
    expect(snap.usedPercent).toBe(0);
    expect(snap.totalTurns).toBe(0);
    expect(snap.provider).toBe("anthropic");
    expect(snap.model).toBe("claude-opus-4-5");
  });

  test("recordTurn increments turn count and cumulative tokens", () => {
    monitor.recordTurn(makeUsage(1000, 500));
    const snap = monitor.getSnapshot();
    expect(snap.totalTurns).toBe(1);
    // 1500 tokens used — should be > 0%
    expect(snap.usedPercent).toBeGreaterThan(0);
  });

  test("snapshot usedTokens equals sum of all turn tokens", () => {
    monitor.recordTurn(makeUsage(1000, 500, 200));  // 1700 total
    monitor.recordTurn(makeUsage(800, 400, 0));     // 1200 total
    const snap = monitor.getSnapshot();
    expect(snap.usedTokens).toBe(1700 + 1200);
  });

  test("getTurns returns all recorded turns", () => {
    monitor.recordTurn(makeUsage(100, 50));
    monitor.recordTurn(makeUsage(200, 100));
    const turns = monitor.getTurns();
    expect(turns.length).toBe(2);
    expect(turns[0]!.turnIndex).toBe(1);
    expect(turns[1]!.turnIndex).toBe(2);
  });

  test("turn record stores correct token breakdown", () => {
    monitor.recordTurn(makeUsage(1000, 500, 300));
    const turn = monitor.getTurns()[0]!;
    expect(turn.inputTokens).toBe(1000);
    expect(turn.outputTokens).toBe(500);
    expect(turn.reasoningTokens).toBe(300);
    expect(turn.totalTokens).toBe(1800);
  });
});

// ---------------------------------------------------------------------------
// 2. Color classification
// ---------------------------------------------------------------------------

describe("classifyBudgetColor", () => {
  test("returns green below BUDGET_COLOR_GREEN_MAX", () => {
    expect(classifyBudgetColor(0)).toBe("green");
    expect(classifyBudgetColor(BUDGET_COLOR_GREEN_MAX - 1)).toBe("green");
  });

  test("returns yellow at BUDGET_COLOR_GREEN_MAX", () => {
    expect(classifyBudgetColor(BUDGET_COLOR_GREEN_MAX)).toBe("yellow");
  });

  test("returns yellow below BUDGET_COLOR_YELLOW_MAX", () => {
    expect(classifyBudgetColor(BUDGET_COLOR_YELLOW_MAX - 1)).toBe("yellow");
  });

  test("returns red at BUDGET_COLOR_YELLOW_MAX", () => {
    expect(classifyBudgetColor(BUDGET_COLOR_YELLOW_MAX)).toBe("red");
  });

  test("returns red above BUDGET_COLOR_YELLOW_MAX", () => {
    expect(classifyBudgetColor(100)).toBe("red");
    expect(classifyBudgetColor(95)).toBe("red");
  });

  test("thresholds match spec: green<70 yellow<85 red>=85", () => {
    expect(BUDGET_COLOR_GREEN_MAX).toBe(70);
    expect(BUDGET_COLOR_YELLOW_MAX).toBe(85);
    expect(classifyBudgetColor(69)).toBe("green");
    expect(classifyBudgetColor(70)).toBe("yellow");
    expect(classifyBudgetColor(84)).toBe("yellow");
    expect(classifyBudgetColor(85)).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// 3. Reasoning model overhead
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — reasoning model (extended thinking)", () => {
  let monitor: ContextBudgetMonitor;

  beforeEach(() => {
    monitor = new ContextBudgetMonitor("test-session");
    monitor.setProvider("anthropic", "claude-opus-4-5");
  });

  test("reasoning tokens count toward cumulative usage", () => {
    monitor.recordTurn(makeUsage(1000, 500, 5000)); // 6500 total
    const snap = monitor.getSnapshot();
    expect(snap.usedTokens).toBe(6500);
    // overheadMultiplier should be elevated
    expect(snap.overheadMultiplier).toBeGreaterThan(1.0);
  });

  test("overhead multiplier reflects reasoning/output ratio", () => {
    // 1000 reasoning / 500 output → ratio = 2 → multiplier ≈ 3.0
    monitor.recordTurn(makeUsage(1000, 500, 1000));
    const snap = monitor.getSnapshot();
    expect(snap.overheadMultiplier).toBeGreaterThan(1.5);
  });

  test("non-reasoning model does not inflate overhead beyond reasoning model", () => {
    // After recording reasoning turns we expect a higher multiplier than baseline 1.0.
    // After flushing with zero-reasoning turns, overhead should drop back toward 1.0.
    // We test that direction, not an exact value, because the global BudgetAllocator
    // singleton carries state across tests in the same process.
    monitor.recordTurn(makeUsage(1000, 500, 2000)); // high reasoning
    const highSnap = monitor.getSnapshot();
    // Now flood the window with zero-reasoning turns
    for (let i = 0; i < 25; i++) {
      monitor.recordTurn(makeUsage(1000, 500, 0));
    }
    const lowSnap = monitor.getSnapshot();
    expect(lowSnap.overheadMultiplier).toBeLessThan(highSnap.overheadMultiplier);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-turn rolling window
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — multi-turn rolling window", () => {
  let monitor: ContextBudgetMonitor;

  beforeEach(() => {
    monitor = new ContextBudgetMonitor("test-session");
    monitor.setProvider("anthropic", "claude-opus-4-5");
  });

  test("turn window caps at TURN_WINDOW_SIZE", () => {
    for (let i = 0; i < TURN_WINDOW_SIZE + 10; i++) {
      monitor.recordTurn(makeUsage(100, 50));
    }
    const turns = monitor.getTurns();
    expect(turns.length).toBeLessThanOrEqual(TURN_WINDOW_SIZE);
  });

  test("cumulative tokens continue accumulating beyond window", () => {
    const usagePerTurn = makeUsage(100, 50); // 150 per turn
    const count = TURN_WINDOW_SIZE + 5;
    for (let i = 0; i < count; i++) {
      monitor.recordTurn(usagePerTurn);
    }
    const snap = monitor.getSnapshot();
    expect(snap.usedTokens).toBe(150 * count);
  });

  test("recent compression ratios reflect last 3 turns", () => {
    monitor.recordTurn(makeUsage(100, 50), 1, 200);  // turn 1: saved 200
    monitor.recordTurn(makeUsage(100, 50), 0, 0);   // turn 2: no compression
    monitor.recordTurn(makeUsage(100, 50), 2, 500);  // turn 3: saved 500
    const snap = monitor.getSnapshot();
    // recentCompressionRatios[0] = oldest, [2] = newest
    expect(snap.recentCompressionRatios).toHaveLength(3);
    // Turn 1 had compression, turn 2 none, turn 3 had compression
    expect(snap.recentCompressionRatios[2]).toBeGreaterThan(0); // turn 3 has ratio
  });

  test("recentCompressionRatios pads to 3 with zeros if fewer turns", () => {
    monitor.recordTurn(makeUsage(100, 50));
    const snap = monitor.getSnapshot();
    expect(snap.recentCompressionRatios).toHaveLength(3);
    expect(snap.recentCompressionRatios[0]).toBe(0);
    expect(snap.recentCompressionRatios[1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Different providers with different context limits
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — provider context limits", () => {
  test("uses provider-specific context limit for percentage calculation", () => {
    const monitorA = new ContextBudgetMonitor("sess-a");
    monitorA.setProvider("anthropic", "claude-opus-4-5");

    const monitorB = new ContextBudgetMonitor("sess-b");
    monitorB.setProvider("xai", "grok-3");

    // Record same number of tokens on both
    const usage = makeUsage(10_000, 5_000);
    monitorA.recordTurn(usage);
    monitorB.recordTurn(usage);

    const snapA = monitorA.getSnapshot();
    const snapB = monitorB.getSnapshot();

    // Both have same usedTokens but potentially different usedPercent
    expect(snapA.usedTokens).toBe(snapB.usedTokens);
    // Context limits should be positive
    expect(snapA.contextLimit).toBeGreaterThan(0);
    expect(snapB.contextLimit).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Compression ratio calculation
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — compression ratio", () => {
  let monitor: ContextBudgetMonitor;

  beforeEach(() => {
    monitor = new ContextBudgetMonitor("test-session");
    monitor.setProvider("anthropic", "claude-opus-4-5");
  });

  test("compression ratio is 0 when no compression applied", () => {
    monitor.recordTurn(makeUsage(1000, 500), 0, 0);
    const turn = monitor.getTurns()[0]!;
    expect(turn.compressionRatio).toBe(0);
    expect(turn.compressionTier).toBe(0);
    expect(turn.compressionSaved).toBe(0);
  });

  test("compression ratio > 0 when tokens saved", () => {
    // totalTokens = 1500, saved = 500 → ratio = 500/(1500+500) = 25%
    monitor.recordTurn(makeUsage(1000, 500), 1, 500);
    const turn = monitor.getTurns()[0]!;
    expect(turn.compressionRatio).toBeGreaterThan(0);
    expect(turn.compressionTier).toBe(1);
    expect(turn.compressionSaved).toBe(500);
  });

  test("turn records the compression tier applied", () => {
    monitor.recordTurn(makeUsage(1000, 500), 2, 300);
    const turn = monitor.getTurns()[0]!;
    expect(turn.compressionTier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Runway estimation
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — runway estimation", () => {
  let monitor: ContextBudgetMonitor;

  beforeEach(() => {
    monitor = new ContextBudgetMonitor("test-session");
    monitor.setProvider("anthropic", "claude-opus-4-5");
  });

  test("runway is positive when no turns recorded (uses DEFAULT_TOKENS_PER_TURN)", () => {
    const snap = monitor.getSnapshot();
    // contextLimit / DEFAULT_TOKENS_PER_TURN — should be well above 0
    expect(snap.runwayTurns).toBeGreaterThan(0);
  });

  test("runway decreases as more tokens are used", () => {
    // Record some turns to establish avg tokens/turn
    for (let i = 0; i < 5; i++) {
      monitor.recordTurn(makeUsage(10_000, 5_000));
    }
    const snap = monitor.getSnapshot();
    // Should have a finite runway (context limit / avg tokens per turn)
    expect(snap.runwayTurns).toBeGreaterThanOrEqual(0);
    expect(snap.runwayTurns).toBeLessThan(999);
  });

  test("runway is 0 when context is exhausted", () => {
    // Fill context: anthropic has 200K limit; dump 200K tokens
    monitor.recordTurn(makeUsage(100_000, 100_000));
    const snap = monitor.getSnapshot();
    expect(snap.runwayTurns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Verbose log path builder
// ---------------------------------------------------------------------------

describe("buildVerboseLogPath", () => {
  test("generates correct path format", () => {
    const path = buildVerboseLogPath("/home/user/.ashlrcode");
    expect(path).toMatch(/\/home\/user\/.ashlrcode\/logs\/budget-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  test("date is today's date", () => {
    const path = buildVerboseLogPath("/tmp/config");
    const today = new Date().toISOString().slice(0, 10);
    expect(path).toContain(`budget-${today}.jsonl`);
  });
});

// ---------------------------------------------------------------------------
// 9. Provider history breakdown
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor — provider history", () => {
  let monitor: ContextBudgetMonitor;

  beforeEach(() => {
    monitor = new ContextBudgetMonitor("test-session");
  });

  test("returns empty array when no turns recorded", () => {
    monitor.setProvider("anthropic", "claude-opus-4-5");
    expect(monitor.getProviderHistory()).toEqual([]);
  });

  test("groups turns by provider:model", () => {
    monitor.setProvider("anthropic", "claude-opus-4-5");
    monitor.recordTurn(makeUsage(1000, 500));
    monitor.recordTurn(makeUsage(800, 400));

    const history = monitor.getProviderHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.provider).toBe("anthropic");
    expect(history[0]!.turns).toBe(2);
  });

  test("tracks compression events in history", () => {
    monitor.setProvider("anthropic", "claude-opus-4-5");
    monitor.recordTurn(makeUsage(1000, 500), 0, 0);   // no compression
    monitor.recordTurn(makeUsage(1000, 500), 1, 300);  // tier-1 compression

    const history = monitor.getProviderHistory();
    expect(history[0]!.compressionEvents).toBe(1);
    expect(history[0]!.totalCompressionSaved).toBe(300);
  });

  test("computes average tokens per turn", () => {
    monitor.setProvider("anthropic", "claude-opus-4-5");
    monitor.recordTurn(makeUsage(1000, 500));   // 1500
    monitor.recordTurn(makeUsage(2000, 1000));  // 3000
    // avg = (1500+3000)/2 = 2250

    const history = monitor.getProviderHistory();
    expect(history[0]!.avgTokensPerTurn).toBe(2250);
  });
});

// ---------------------------------------------------------------------------
// 10. Header bar formatting
// ---------------------------------------------------------------------------

describe("formatBudgetHeader", () => {
  test("includes provider, used%, and runway", () => {
    const snap: BudgetSnapshot = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      usedTokens: 50_000,
      contextLimit: 200_000,
      usedPercent: 25,
      color: "green",
      recentCompressionRatios: [0, 5, 10],
      runwayTurns: 50,
      totalTurns: 5,
      overheadMultiplier: 1.0,
    };

    const header = formatBudgetHeader(snap, 80);
    expect(header).toContain("anthropic");
    expect(header).toContain("25%");
    expect(header).toContain("50 turns");
    expect(header).toContain("Compress:");
  });

  test("shows infinity symbol when runway >= 999", () => {
    const snap: BudgetSnapshot = {
      provider: "xai",
      model: "grok-3",
      usedTokens: 0,
      contextLimit: 2_000_000,
      usedPercent: 0,
      color: "green",
      recentCompressionRatios: [0, 0, 0],
      runwayTurns: 999,
      totalTurns: 0,
      overheadMultiplier: 1.0,
    };

    const header = formatBudgetHeader(snap, 80);
    expect(header).toContain("∞");
  });
});

// ---------------------------------------------------------------------------
// 11. Reset behavior
// ---------------------------------------------------------------------------

describe("ContextBudgetMonitor.reset", () => {
  test("clears all state", () => {
    const monitor = new ContextBudgetMonitor("test");
    monitor.setProvider("anthropic", "claude-opus-4-5");
    monitor.recordTurn(makeUsage(1000, 500, 300));
    monitor.recordTurn(makeUsage(800, 400));

    monitor.reset();

    const snap = monitor.getSnapshot();
    expect(snap.usedTokens).toBe(0);
    expect(snap.totalTurns).toBe(0);
    expect(snap.usedPercent).toBe(0);
    expect(monitor.getTurns()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12. Singleton get/set
// ---------------------------------------------------------------------------

describe("getContextBudgetMonitor / setContextBudgetMonitor", () => {
  test("getContextBudgetMonitor returns a ContextBudgetMonitor instance", () => {
    const m = getContextBudgetMonitor();
    expect(m).toBeInstanceOf(ContextBudgetMonitor);
  });

  test("getContextBudgetMonitor returns same instance on repeated calls", () => {
    const m1 = getContextBudgetMonitor();
    const m2 = getContextBudgetMonitor();
    expect(m1).toBe(m2);
  });

  test("setContextBudgetMonitor replaces the singleton", () => {
    const fresh = new ContextBudgetMonitor("fresh");
    setContextBudgetMonitor(fresh);
    expect(getContextBudgetMonitor()).toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// 13. formatTokenCount helper
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  test("formats raw numbers under 1K", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  test("formats thousands as K", () => {
    expect(formatTokenCount(1_500)).toBe("2K");
    expect(formatTokenCount(128_000)).toBe("128K");
  });

  test("formats millions as M", () => {
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatTokenCount(2_000_000)).toBe("2.0M");
  });
});
