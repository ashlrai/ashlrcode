/**
 * Tests for surgical-viz system:
 *   - surgical-confidence-analyzer.ts — TierConfidenceAnalyzer + extractGoalPattern
 *   - SurgicalDashboard.tsx — renderTierDistribution, renderConfidenceChart, renderDecisionHistory
 *   - surgical-viz.ts — handleSurgicalViz, handleSurgicalConfidence, handleSurgicalHistory
 *
 * Coverage (40+ tests):
 *   - extractGoalPattern: known keywords map to correct patterns
 *   - TierConfidenceAnalyzer.analyze(): empty feedback, single entry, multi-entry grouping
 *   - TierConfidenceAnalyzer.getTierDistribution(): counts per tier
 *   - TierConfidenceAnalyzer.getRecentDecisions(): newest-first ordering, truncation
 *   - PatternStats shape invariants: successRate in [0,1], sampleSize ≥ 1
 *   - renderTierDistribution: empty state, counts, bar presence
 *   - renderConfidenceChart: empty state, pattern rows, heatmap legend
 *   - renderDecisionHistory: empty state, decision rows, accepted/override coloring
 *   - renderSurgicalDashboard: contains all three sections
 *   - handleSurgicalViz / handleSurgicalConfidence / handleSurgicalHistory: call addOutput
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, writeFile } from "fs/promises";

import {
  TierConfidenceAnalyzer,
  extractGoalPattern,
  type PatternStats,
  type RecentDecision,
} from "../agent/surgical-confidence-analyzer.ts";

import {
  renderTierDistribution,
  renderConfidenceChart,
  renderDecisionHistory,
  renderSurgicalDashboard,
} from "../ui/SurgicalDashboard.tsx";

import {
  handleSurgicalViz,
  handleSurgicalConfidence,
  handleSurgicalHistory,
  surgicalVizCommands,
} from "../commands/surgical-viz.ts";

import { getFeedbackFilePath, type ProposalFeedback } from "../agent/surgical-proposer.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

const feedbackPath = getFeedbackFilePath();
const feedbackDir = feedbackPath.substring(0, feedbackPath.lastIndexOf("/"));

function makeFeedback(
  goal: string,
  suggestedTier: "narrow" | "medium" | "wide",
  chosenTier: "narrow" | "medium" | "wide",
  outcome: "accepted" | "overridden" | "unknown",
  confidence = 0.8,
  timestamp?: string,
): ProposalFeedback {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    goal,
    suggestedTier,
    suggestedConfidence: confidence,
    chosenTier,
    outcome,
  };
}

async function writeFeedback(entries: ProposalFeedback[]): Promise<void> {
  await mkdir(feedbackDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(feedbackPath, lines, { encoding: "utf8" });
}

async function clearFeedback(): Promise<void> {
  try {
    await rm(feedbackPath);
  } catch { /* OK if missing */ }
}

/** Minimal addOutput spy */
function makeOutputSpy(): { addOutput: (t: string) => void; output: string[] } {
  const output: string[] = [];
  return { addOutput: (t) => output.push(t), output };
}

beforeEach(async () => { await clearFeedback(); });
afterEach(async () => { await clearFeedback(); });

// ── extractGoalPattern ─────────────────────────────────────────────────────────

describe("extractGoalPattern", () => {
  test("'fix typo in README' → fix-typo", () => {
    expect(extractGoalPattern("fix typo in README")).toBe("fix-typo");
  });

  test("'refactor auth module' → refactor", () => {
    expect(extractGoalPattern("refactor auth module")).toBe("refactor");
  });

  test("'fix failing test for login' → test", () => {
    expect(extractGoalPattern("fix failing test for login")).toBe("test");
  });

  test("'add test for user service' → test", () => {
    expect(extractGoalPattern("add test for user service")).toBe("test");
  });

  test("'install lodash' → install", () => {
    expect(extractGoalPattern("install lodash")).toBe("install");
  });

  test("'implement dark mode' → feature", () => {
    expect(extractGoalPattern("implement dark mode")).toBe("feature");
  });

  test("'migrate database schema' → migrate", () => {
    expect(extractGoalPattern("migrate database schema")).toBe("migrate");
  });

  test("'fix null check' → fix-typo (longer keyword wins)", () => {
    // "fix typo" is longer and checked first, but "fix null check" doesn't contain "fix typo"
    // so it falls through to "fix"
    expect(extractGoalPattern("fix null check")).toBe("fix");
  });

  test("'update imports across files' → update", () => {
    expect(extractGoalPattern("update imports across files")).toBe("update");
  });

  test("'unrelated prompt xyz' → other", () => {
    expect(extractGoalPattern("unrelated prompt xyz")).toBe("other");
  });

  test("empty string → other", () => {
    expect(extractGoalPattern("")).toBe("other");
  });

  test("case insensitive — 'REFACTOR auth' → refactor", () => {
    expect(extractGoalPattern("REFACTOR auth")).toBe("refactor");
  });
});

// ── TierConfidenceAnalyzer.analyze() ─────────────────────────────────────────

describe("TierConfidenceAnalyzer.analyze()", () => {
  it("returns empty array when no feedback exists", async () => {
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    expect(patterns).toEqual([]);
  });

  it("groups entries by pattern correctly", async () => {
    await writeFeedback([
      makeFeedback("fix typo in auth.ts", "narrow", "narrow", "accepted", 0.9),
      makeFeedback("fix typo in header", "narrow", "narrow", "accepted", 0.85),
      makeFeedback("refactor auth module", "wide", "wide", "accepted", 0.75),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    // Should have 2 groups: fix-typo (2 entries) and refactor (1 entry)
    const fixTypo = patterns.find((p) => p.pattern === "fix-typo");
    const refactor = patterns.find((p) => p.pattern === "refactor");
    expect(fixTypo).toBeDefined();
    expect(fixTypo!.sampleSize).toBe(2);
    expect(refactor).toBeDefined();
    expect(refactor!.sampleSize).toBe(1);
  });

  it("sorts patterns by sampleSize descending", async () => {
    await writeFeedback([
      makeFeedback("refactor auth", "wide", "wide", "accepted"),
      makeFeedback("fix typo a", "narrow", "narrow", "accepted"),
      makeFeedback("fix typo b", "narrow", "narrow", "accepted"),
      makeFeedback("fix typo c", "narrow", "narrow", "accepted"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    expect(patterns[0]!.sampleSize).toBeGreaterThanOrEqual(patterns[1]!.sampleSize);
  });

  it("computes successRate correctly for all-accepted pattern", async () => {
    await writeFeedback([
      makeFeedback("fix typo a", "narrow", "narrow", "accepted"),
      makeFeedback("fix typo b", "narrow", "narrow", "accepted"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    const p = patterns.find((x) => x.pattern === "fix-typo")!;
    expect(p.successRate).toBeCloseTo(1.0);
  });

  it("computes successRate correctly for partially overridden pattern", async () => {
    await writeFeedback([
      makeFeedback("refactor a", "wide", "wide", "accepted"),
      makeFeedback("refactor b", "wide", "medium", "overridden"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    const p = patterns.find((x) => x.pattern === "refactor")!;
    expect(p.successRate).toBeCloseTo(0.5);
  });

  it("computes mean confidence correctly", async () => {
    await writeFeedback([
      makeFeedback("fix typo a", "narrow", "narrow", "accepted", 0.8),
      makeFeedback("fix typo b", "narrow", "narrow", "accepted", 0.6),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    const p = patterns.find((x) => x.pattern === "fix-typo")!;
    expect(p.confidence).toBeCloseTo(0.7);
  });

  it("PatternStats successRate is always in [0, 1]", async () => {
    await writeFeedback([
      makeFeedback("fix typo", "narrow", "narrow", "accepted", 0.9),
      makeFeedback("refactor auth", "wide", "medium", "overridden", 0.55),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    for (const p of patterns) {
      expect(p.successRate).toBeGreaterThanOrEqual(0);
      expect(p.successRate).toBeLessThanOrEqual(1);
    }
  });

  it("recommendedTier is the most frequently suggested tier for the pattern", async () => {
    await writeFeedback([
      makeFeedback("fix typo a", "narrow", "narrow", "accepted"),
      makeFeedback("fix typo b", "narrow", "medium", "overridden"),
      makeFeedback("fix typo c", "narrow", "narrow", "accepted"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const patterns = await analyzer.analyze();
    const p = patterns.find((x) => x.pattern === "fix-typo")!;
    // narrow was suggested 3 times vs medium 0
    expect(p.recommendedTier).toBe("narrow");
  });
});

// ── TierConfidenceAnalyzer.getTierDistribution() ─────────────────────────────

describe("TierConfidenceAnalyzer.getTierDistribution()", () => {
  it("returns all zeros when no feedback", async () => {
    const analyzer = new TierConfidenceAnalyzer();
    const dist = await analyzer.getTierDistribution();
    expect(dist.narrow).toBe(0);
    expect(dist.medium).toBe(0);
    expect(dist.wide).toBe(0);
    expect(dist.total).toBe(0);
  });

  it("counts suggestion tiers correctly", async () => {
    await writeFeedback([
      makeFeedback("a", "narrow", "narrow", "accepted"),
      makeFeedback("b", "narrow", "narrow", "accepted"),
      makeFeedback("c", "medium", "medium", "accepted"),
      makeFeedback("d", "wide", "medium", "overridden"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const dist = await analyzer.getTierDistribution();
    expect(dist.narrow).toBe(2);
    expect(dist.medium).toBe(1);
    expect(dist.wide).toBe(1);
    expect(dist.total).toBe(4);
  });

  it("narrow + medium + wide === total", async () => {
    await writeFeedback([
      makeFeedback("a", "narrow", "narrow", "accepted"),
      makeFeedback("b", "medium", "wide", "overridden"),
      makeFeedback("c", "wide", "wide", "accepted"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const dist = await analyzer.getTierDistribution();
    expect(dist.narrow + dist.medium + dist.wide).toBe(dist.total);
  });
});

// ── TierConfidenceAnalyzer.getRecentDecisions() ───────────────────────────────

describe("TierConfidenceAnalyzer.getRecentDecisions()", () => {
  it("returns empty array when no feedback", async () => {
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions();
    expect(decisions).toEqual([]);
  });

  it("returns decisions newest-first", async () => {
    await writeFeedback([
      makeFeedback("old goal", "narrow", "narrow", "accepted", 0.8, "2026-01-01T10:00:00.000Z"),
      makeFeedback("new goal", "wide", "wide", "accepted", 0.9, "2026-06-29T10:00:00.000Z"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions();
    expect(decisions[0]!.goal).toContain("new goal");
    expect(decisions[1]!.goal).toContain("old goal");
  });

  it("limits output to requested count", async () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeFeedback(`goal ${i}`, "narrow", "narrow", "accepted"),
    );
    await writeFeedback(entries);
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions(5);
    expect(decisions.length).toBe(5);
  });

  it("default limit is 20", async () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeFeedback(`goal ${i}`, "narrow", "narrow", "accepted"),
    );
    await writeFeedback(entries);
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions();
    expect(decisions.length).toBe(20);
  });

  it("truncates goal to 60 chars with ellipsis", async () => {
    const longGoal = "a".repeat(80);
    await writeFeedback([makeFeedback(longGoal, "wide", "wide", "accepted")]);
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions(1);
    expect(decisions[0]!.goal.length).toBeLessThanOrEqual(60);
    expect(decisions[0]!.goal.endsWith("...")).toBe(true);
  });

  it("marks accepted decisions correctly", async () => {
    await writeFeedback([
      makeFeedback("fix typo", "narrow", "narrow", "accepted"),
      makeFeedback("refactor auth", "wide", "medium", "overridden"),
    ]);
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions();
    const accepted = decisions.find((d) => d.goal.includes("fix typo"));
    const overridden = decisions.find((d) => d.goal.includes("refactor"));
    expect(accepted!.accepted).toBe(true);
    expect(overridden!.accepted).toBe(false);
  });

  it("includes pattern extraction for each decision", async () => {
    await writeFeedback([makeFeedback("refactor auth module", "wide", "wide", "accepted")]);
    const analyzer = new TierConfidenceAnalyzer();
    const decisions = await analyzer.getRecentDecisions(1);
    expect(decisions[0]!.pattern).toBe("refactor");
  });
});

// ── renderTierDistribution ────────────────────────────────────────────────────

describe("renderTierDistribution", () => {
  it("contains 'No tier decisions' when total is 0", () => {
    const out = renderTierDistribution({ narrow: 0, medium: 0, wide: 0, total: 0 });
    expect(out).toContain("No tier decisions");
  });

  it("contains all three tier labels", () => {
    const out = renderTierDistribution({ narrow: 3, medium: 2, wide: 1, total: 6 });
    expect(out).toContain("narrow");
    expect(out).toContain("medium");
    expect(out).toContain("wide");
  });

  it("includes total count", () => {
    const out = renderTierDistribution({ narrow: 3, medium: 2, wide: 1, total: 6 });
    expect(out).toContain("6");
  });

  it("contains bar characters", () => {
    const out = renderTierDistribution({ narrow: 5, medium: 3, wide: 2, total: 10 });
    expect(out).toContain("█");
  });

  it("returns a non-empty string for non-zero totals", () => {
    const out = renderTierDistribution({ narrow: 1, medium: 0, wide: 0, total: 1 });
    expect(out.length).toBeGreaterThan(10);
  });
});

// ── renderConfidenceChart ──────────────────────────────────────────────────────

describe("renderConfidenceChart", () => {
  it("contains 'No pattern data' when empty", () => {
    const out = renderConfidenceChart([]);
    expect(out).toContain("No pattern data");
  });

  it("contains pattern names", () => {
    const patterns: PatternStats[] = [
      { pattern: "refactor", recommendedTier: "wide", successRate: 0.8, confidence: 0.75, sampleSize: 5 },
      { pattern: "fix-typo", recommendedTier: "narrow", successRate: 0.95, confidence: 0.9, sampleSize: 3 },
    ];
    const out = renderConfidenceChart(patterns);
    expect(out).toContain("refactor");
    expect(out).toContain("fix-typo");
  });

  it("contains confidence heatmap legend", () => {
    const patterns: PatternStats[] = [
      { pattern: "fix", recommendedTier: "narrow", successRate: 0.7, confidence: 0.85, sampleSize: 2 },
    ];
    const out = renderConfidenceChart(patterns);
    // Should contain the legend indicators
    expect(out).toContain("low");
    expect(out).toContain("med");
    expect(out).toContain("high");
  });

  it("shows at most 5 patterns", () => {
    const patterns: PatternStats[] = Array.from({ length: 10 }, (_, i) => ({
      pattern: `pattern-${i}`,
      recommendedTier: "narrow" as const,
      successRate: 0.8,
      confidence: 0.7,
      sampleSize: 10 - i,
    }));
    const out = renderConfidenceChart(patterns);
    expect(out).toContain("5 more patterns");
  });

  it("shows sample size for each pattern", () => {
    const patterns: PatternStats[] = [
      { pattern: "test", recommendedTier: "medium", successRate: 0.6, confidence: 0.65, sampleSize: 12 },
    ];
    const out = renderConfidenceChart(patterns);
    expect(out).toContain("12");
  });
});

// ── renderDecisionHistory ─────────────────────────────────────────────────────

describe("renderDecisionHistory", () => {
  it("contains 'No decisions' when empty", () => {
    const out = renderDecisionHistory([]);
    expect(out).toContain("No decisions");
  });

  it("contains goal text for each decision", () => {
    const decisions: RecentDecision[] = [
      {
        timestamp: "2026-06-29T12:00:00.000Z",
        goal: "fix typo in login",
        pattern: "fix-typo",
        suggestedTier: "narrow",
        chosenTier: "narrow",
        confidence: 0.88,
        accepted: true,
        outcome: "accepted",
      },
    ];
    const out = renderDecisionHistory(decisions);
    expect(out).toContain("fix typo in login");
  });

  it("shows at most 10 decisions", () => {
    const decisions: RecentDecision[] = Array.from({ length: 15 }, (_, i) => ({
      timestamp: "2026-06-29T12:00:00.000Z",
      goal: `goal ${i}`,
      pattern: "fix",
      suggestedTier: "narrow" as const,
      chosenTier: "narrow" as const,
      confidence: 0.8,
      accepted: true,
      outcome: "accepted" as const,
    }));
    const out = renderDecisionHistory(decisions);
    // Count occurrences of "goal" — should see at most 10 data rows
    const count = (out.match(/goal \d+/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(10);
  });

  it("contains timestamp for each decision", () => {
    const decisions: RecentDecision[] = [
      {
        timestamp: "2026-06-29T12:34:00.000Z",
        goal: "refactor auth",
        pattern: "refactor",
        suggestedTier: "wide",
        chosenTier: "wide",
        confidence: 0.75,
        accepted: true,
        outcome: "accepted",
      },
    ];
    const out = renderDecisionHistory(decisions);
    expect(out).toContain("2026-06-29");
  });
});

// ── renderSurgicalDashboard ────────────────────────────────────────────────────

describe("renderSurgicalDashboard", () => {
  it("contains all three sections", () => {
    const dist = { narrow: 2, medium: 1, wide: 1, total: 4 };
    const patterns: PatternStats[] = [
      { pattern: "refactor", recommendedTier: "wide", successRate: 0.8, confidence: 0.75, sampleSize: 2 },
    ];
    const decisions: RecentDecision[] = [
      {
        timestamp: "2026-06-29T12:00:00.000Z",
        goal: "refactor auth",
        pattern: "refactor",
        suggestedTier: "wide",
        chosenTier: "wide",
        confidence: 0.75,
        accepted: true,
        outcome: "accepted",
      },
    ];
    const out = renderSurgicalDashboard(dist, patterns, decisions);
    expect(out).toContain("Tier Distribution");
    expect(out).toContain("Goal Pattern Confidence");
    expect(out).toContain("Recent Tier Decisions");
  });

  it("shows the dashboard title", () => {
    const out = renderSurgicalDashboard(
      { narrow: 0, medium: 0, wide: 0, total: 0 },
      [],
      [],
    );
    expect(out).toContain("Surgical Mode");
    expect(out).toContain("Dashboard");
  });
});

// ── surgicalVizCommands() ─────────────────────────────────────────────────────

describe("surgicalVizCommands()", () => {
  it("returns an array of 3 Command objects", () => {
    const cmds = surgicalVizCommands();
    expect(Array.isArray(cmds)).toBe(true);
    expect(cmds.length).toBe(3);
  });

  it("includes /surgical viz, /surgical confidence, /surgical history", () => {
    const cmds = surgicalVizCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toContain("/surgical viz");
    expect(names).toContain("/surgical confidence");
    expect(names).toContain("/surgical history");
  });

  it("all commands have category 'agent'", () => {
    const cmds = surgicalVizCommands();
    for (const cmd of cmds) {
      expect(cmd.category).toBe("agent");
    }
  });
});

// ── handleSurgicalViz ─────────────────────────────────────────────────────────

describe("handleSurgicalViz", () => {
  it("calls addOutput with dashboard content", async () => {
    const spy = makeOutputSpy();
    await handleSurgicalViz("", spy);
    expect(spy.output.length).toBeGreaterThan(0);
    const combined = spy.output.join("");
    expect(combined).toContain("Surgical Mode");
  });

  it("returns true", async () => {
    const spy = makeOutputSpy();
    const result = await handleSurgicalViz("", spy);
    expect(result).toBe(true);
  });

  it("works when feedback file has data", async () => {
    await writeFeedback([
      makeFeedback("fix typo", "narrow", "narrow", "accepted", 0.9),
      makeFeedback("refactor auth", "wide", "wide", "accepted", 0.75),
    ]);
    const spy = makeOutputSpy();
    await handleSurgicalViz("", spy);
    expect(spy.output.join("")).toContain("narrow");
  });
});

// ── handleSurgicalConfidence ──────────────────────────────────────────────────

describe("handleSurgicalConfidence", () => {
  it("calls addOutput with confidence content", async () => {
    const spy = makeOutputSpy();
    await handleSurgicalConfidence("", spy);
    expect(spy.output.length).toBeGreaterThan(0);
    const combined = spy.output.join("");
    expect(combined).toContain("Confidence");
  });

  it("returns true", async () => {
    const spy = makeOutputSpy();
    const result = await handleSurgicalConfidence("", spy);
    expect(result).toBe(true);
  });
});

// ── handleSurgicalHistory ─────────────────────────────────────────────────────

describe("handleSurgicalHistory", () => {
  it("calls addOutput with history content", async () => {
    const spy = makeOutputSpy();
    await handleSurgicalHistory("", spy);
    expect(spy.output.length).toBeGreaterThan(0);
    const combined = spy.output.join("");
    expect(combined).toContain("History");
  });

  it("returns true", async () => {
    const spy = makeOutputSpy();
    const result = await handleSurgicalHistory("", spy);
    expect(result).toBe(true);
  });

  it("shows recent decisions from feedback file", async () => {
    await writeFeedback([
      makeFeedback("fix typo in header", "narrow", "narrow", "accepted", 0.92),
    ]);
    const spy = makeOutputSpy();
    await handleSurgicalHistory("", spy);
    expect(spy.output.join("")).toContain("fix typo in header");
  });
});
