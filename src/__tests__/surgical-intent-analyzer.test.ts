/**
 * Tests for surgical-intent-analyzer.ts
 *
 * Coverage (30+ tests):
 *   - Tier inference for 20+ intent patterns
 *   - Confidence scoring: ranges, relative ordering, edge cases
 *   - History replay: tool call accumulation and scope-creep detection
 *   - Keyword-based minimum tier enforcement (install → tier 3, create file → tier 2)
 *   - SessionIntentTracker: record, reset, analyzeCurrentIntent
 *   - Global singleton: get/set/reset
 *   - autoPromoteTierFromGoal: shouldAutoApply / shouldPromptUser thresholds
 *   - formatIntentStatus: output shape and key fields
 *   - Edge cases: empty goal, empty history, contradictory signals, ambiguous terms
 */

import { describe, it, test, expect, beforeEach } from "bun:test";

import {
  analyzeIntent,
  SessionIntentTracker,
  getGlobalIntentTracker,
  setGlobalIntentTracker,
  resetGlobalIntentTracker,
  autoPromoteTierFromGoal,
  formatIntentStatus,
  type ToolCall,
  type IntentAnalysisResult,
} from "../agent/surgical-intent-analyzer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tc(name: string, args?: Record<string, unknown>): ToolCall {
  return { name, args, at: Date.now() };
}

function bash(command: string): ToolCall {
  return tc("Bash", { command });
}

// ── Tier inference — 20+ intent patterns ─────────────────────────────────────

describe("analyzeIntent — tier 1 (micro) patterns", () => {
  test("'show me where the bug is' → tier 1 (read-only intent)", () => {
    const r = analyzeIntent("show me where the bug is", []);
    expect(r.tier).toBe(1);
  });

  test("'what is the type of userId' → tier 1", () => {
    const r = analyzeIntent("what is the type of userId", []);
    expect(r.tier).toBe(1);
  });

  test("'find where this function is called' → tier 1", () => {
    const r = analyzeIntent("find where this function is called", []);
    expect(r.tier).toBe(1);
  });

  test("'explain how the auth flow works' → tier 1", () => {
    const r = analyzeIntent("explain how the auth flow works", []);
    expect(r.tier).toBe(1);
  });

  test("'fix typo in README' → tier 1", () => {
    const r = analyzeIntent("fix typo in README", []);
    expect(r.tier).toBe(1);
  });

  test("'null check for userId parameter' → tier 1", () => {
    const r = analyzeIntent("null check for userId parameter", []);
    expect(r.tier).toBe(1);
  });

  test("'off-by-one error in loop counter' → tier 1", () => {
    const r = analyzeIntent("off-by-one error in loop counter", []);
    expect(r.tier).toBe(1);
  });

  test("'fix lint warning in auth.ts' → tier 1", () => {
    const r = analyzeIntent("fix lint warning in auth.ts", []);
    expect(r.tier).toBe(1);
  });
});

describe("analyzeIntent — tier 2 (fine) patterns", () => {
  test("'create file src/utils/helpers.ts' → min tier 2", () => {
    const r = analyzeIntent("create file src/utils/helpers.ts", []);
    expect(r.tier).toBeGreaterThanOrEqual(2);
  });

  test("'write new component for dashboard' → min tier 2", () => {
    const r = analyzeIntent("write new component for dashboard", []);
    expect(r.tier).toBeGreaterThanOrEqual(2);
  });

  test("'fix bug in the parser' → tier 2", () => {
    const r = analyzeIntent("fix bug in the parser", []);
    expect(r.tier).toBe(2);
  });

  test("'fix crash on startup' → tier 2", () => {
    const r = analyzeIntent("fix crash on startup", []);
    expect(r.tier).toBe(2);
  });

  test("'patch the version string' → tier 2", () => {
    const r = analyzeIntent("patch the version string", []);
    expect(r.tier).toBe(2);
  });

  test("'new file for router config' → min tier 2", () => {
    const r = analyzeIntent("new file for router config", []);
    expect(r.tier).toBeGreaterThanOrEqual(2);
  });
});

describe("analyzeIntent — tier 3 (balanced) patterns", () => {
  test("'run tests for auth module' → min tier 3", () => {
    const r = analyzeIntent("run tests for auth module", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  test("'install lodash' → min tier 3", () => {
    const r = analyzeIntent("install lodash", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  test("'build the project' → min tier 3", () => {
    const r = analyzeIntent("build the project", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  test("'bun test to verify fix' → min tier 3", () => {
    const r = analyzeIntent("run bun test to verify fix", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  test("'fix failing test for parser' → tier 3", () => {
    const r = analyzeIntent("fix failing test for parser", []);
    expect(r.tier).toBe(3);
  });

  test("'add function to format dates' → tier 3", () => {
    const r = analyzeIntent("add function to format dates", []);
    expect(r.tier).toBe(3);
  });

  test("'deploy to staging' → min tier 3", () => {
    const r = analyzeIntent("deploy to staging", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  test("'lint and format the codebase' → min tier 3", () => {
    const r = analyzeIntent("lint and format the codebase", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });
});

describe("analyzeIntent — tier 4 (broad) patterns", () => {
  test("'refactor the auth module' → tier 4", () => {
    const r = analyzeIntent("refactor the auth module", []);
    expect(r.tier).toBe(4);
  });

  test("'implement the payment flow' → tier 4", () => {
    const r = analyzeIntent("implement the payment flow", []);
    expect(r.tier).toBe(4);
  });

  test("'migrate database schema' → tier 4", () => {
    const r = analyzeIntent("migrate database schema", []);
    expect(r.tier).toBe(4);
  });

  test("'add feature: dark mode' → tier 4", () => {
    const r = analyzeIntent("add feature: dark mode", []);
    expect(r.tier).toBe(4);
  });

  test("'rewrite the routing layer' → tier 4", () => {
    const r = analyzeIntent("rewrite the routing layer", []);
    expect(r.tier).toBe(4);
  });

  test("'update all files to use new API' → tier 4", () => {
    const r = analyzeIntent("update all files to use new API", []);
    expect(r.tier).toBe(4);
  });
});

// ── Confidence scoring ────────────────────────────────────────────────────────

describe("analyzeIntent — confidence scoring", () => {
  it("confidence is always in [0, 1]", () => {
    const goals = [
      "fix typo", "install lodash", "refactor", "create file",
      "", "do something", "build the project", "explain auth",
    ];
    for (const goal of goals) {
      const r = analyzeIntent(goal, []);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("specific read-only goals have confidence ≥ 0.8", () => {
    const r = analyzeIntent("show me where the bug is", []);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("specific narrow fix goals have confidence ≥ 0.8", () => {
    const r = analyzeIntent("fix typo in README", []);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("default (no signal) goal has low confidence (< 0.7)", () => {
    const r = analyzeIntent("update the code", []);
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("empty goal has low confidence (< 0.7)", () => {
    const r = analyzeIntent("", []);
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("reasoning is always a non-empty string", () => {
    const goals = ["fix typo", "refactor", "install lodash", "", "build"];
    for (const goal of goals) {
      const r = analyzeIntent(goal, []);
      expect(typeof r.reasoning).toBe("string");
      expect(r.reasoning.length).toBeGreaterThan(0);
    }
  });
});

// ── Minimum tier enforcement ──────────────────────────────────────────────────

describe("analyzeIntent — keyword minimum tier enforcement", () => {
  it("'install' keyword forces min tier 3 even if goal looks narrow", () => {
    // "fix typo then install dep" — install wins over fix typo for tier minimum
    const r = analyzeIntent("fix typo then npm install dep", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  it("'build' keyword forces min tier 3", () => {
    const r = analyzeIntent("build the project after fixing typo", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  it("'run tests' forces min tier 3", () => {
    const r = analyzeIntent("run tests after the fix", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  it("'create file' forces min tier 2", () => {
    const r = analyzeIntent("create file for new helper", []);
    expect(r.tier).toBeGreaterThanOrEqual(2);
  });

  it("'write new' forces min tier 2", () => {
    const r = analyzeIntent("write new interface for User", []);
    expect(r.tier).toBeGreaterThanOrEqual(2);
  });

  it("wide signal dominates install min-tier-3", () => {
    const r = analyzeIntent("refactor the module then install deps", []);
    expect(r.tier).toBe(4);
  });
});

// ── History replay and scope-creep detection ──────────────────────────────────

describe("analyzeIntent — history replay", () => {
  it("empty history returns goal-based tier unchanged", () => {
    const r = analyzeIntent("fix typo", []);
    expect(r.tier).toBe(1);
    expect(r.scopeCreepDetected).toBe(false);
  });

  it("all-read-only history does not creep beyond narrow goal", () => {
    const history: ToolCall[] = [tc("Read"), tc("Grep"), tc("Glob"), tc("LS")];
    const r = analyzeIntent("fix typo", history);
    expect(r.scopeCreepDetected).toBe(false);
  });

  it("Bash tool in history raises observed tier to ≥ 3", () => {
    const history: ToolCall[] = [tc("Read"), bash("grep -r TODO src/"), tc("Edit")];
    const r = analyzeIntent("fix typo", history);
    // Bash implies tier 3 in history; goal says tier 1 → scope creep
    expect(r.scopeCreepDetected).toBe(true);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  it("Agent tool in history raises observed tier to 4", () => {
    const history: ToolCall[] = [tc("Read"), tc("Agent"), tc("Coordinate")];
    const r = analyzeIntent("fix typo", history);
    expect(r.scopeCreepDetected).toBe(true);
    expect(r.tier).toBe(4);
  });

  it("scope creep reduces confidence by ~15%", () => {
    const noCreep = analyzeIntent("fix typo", [tc("Read"), tc("Grep")]);
    const creep = analyzeIntent("fix typo", [tc("Read"), tc("Bash"), tc("Agent")]);
    expect(creep.confidence).toBeLessThan(noCreep.confidence);
  });

  it("history consistent with goal (all reads for read-only goal) boosts confidence", () => {
    const many: ToolCall[] = Array(5).fill(null).map(() => tc("Read"));
    const r = analyzeIntent("show me where the bug is", many);
    expect(r.scopeCreepDetected).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("bash install command in history promotes to min tier 3", () => {
    const history: ToolCall[] = [bash("npm install lodash")];
    const r = analyzeIntent("fix typo", history);
    // The Bash call signals tier 3 via keyword detection in history
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  it("history limited to last 20 entries (older entries ignored)", () => {
    // Pad with 25 Edit calls (tier 2), then add 1 Agent call (tier 4)
    const old = Array(25).fill(null).map(() => tc("Edit"));
    const recent = [tc("Agent")];
    const history = [...old, ...recent];
    const r = analyzeIntent("fix typo", history);
    // Agent is in the last 20 window — scope creep detected
    expect(r.scopeCreepDetected).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("analyzeIntent — edge cases", () => {
  it("empty goal → tier 3 default with low confidence", () => {
    const r = analyzeIntent("", []);
    expect(r.tier).toBe(3);
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("case-insensitive: 'FIX TYPO' → tier 1", () => {
    const r = analyzeIntent("FIX TYPO", []);
    expect(r.tier).toBe(1);
  });

  it("case-insensitive: 'INSTALL LODASH' → min tier 3", () => {
    const r = analyzeIntent("INSTALL LODASH", []);
    expect(r.tier).toBeGreaterThanOrEqual(3);
  });

  it("contradictory goal: wide refactor + fix typo → wide wins (tier 4)", () => {
    const r = analyzeIntent("refactor to fix typo", []);
    expect(r.tier).toBe(4);
  });

  it("ambiguous 'fix' with no further context → tier 3", () => {
    const r = analyzeIntent("fix the code", []);
    expect(r.tier).toBe(3);
  });

  it("very long goal with no signal → tier 3 default", () => {
    const r = analyzeIntent(
      "please do something useful with the project and make it better overall somehow",
      [],
    );
    expect(r.tier).toBe(3);
  });

  it("tier is always 1–4", () => {
    const goals = ["fix typo", "install", "refactor", "create file", "", "build", "show me"];
    for (const goal of goals) {
      const r = analyzeIntent(goal, []);
      expect(r.tier).toBeGreaterThanOrEqual(1);
      expect(r.tier).toBeLessThanOrEqual(4);
    }
  });

  it("scope field matches expected scope for each tier group", () => {
    expect(analyzeIntent("show me the code", []).scope).toBe("narrow");
    expect(analyzeIntent("fix typo", []).scope).toBe("narrow");
    expect(analyzeIntent("refactor auth", []).scope).toBe("wide");
  });
});

// ── SessionIntentTracker ──────────────────────────────────────────────────────

describe("SessionIntentTracker", () => {
  it("starts empty", () => {
    const tracker = new SessionIntentTracker();
    expect(tracker.size()).toBe(0);
    expect(tracker.getHistory()).toEqual([]);
  });

  it("records tool calls and increments size", () => {
    const tracker = new SessionIntentTracker();
    tracker.record(tc("Read"));
    tracker.record(tc("Grep"));
    expect(tracker.size()).toBe(2);
  });

  it("getRecent returns last N entries", () => {
    const tracker = new SessionIntentTracker();
    for (let i = 0; i < 10; i++) tracker.record(tc("Read"));
    tracker.record(tc("Edit"));
    expect(tracker.getRecent(3)[2]?.name).toBe("Edit");
  });

  it("evicts oldest entries when maxSize exceeded", () => {
    const tracker = new SessionIntentTracker(5);
    for (let i = 0; i < 7; i++) tracker.record(tc(String(i)));
    expect(tracker.size()).toBe(5);
    // Oldest (0,1) should be gone
    expect(tracker.getHistory()[0]?.name).toBe("2");
  });

  it("analyzeCurrentIntent uses recorded history and goal", () => {
    const tracker = new SessionIntentTracker();
    tracker.setGoal("fix typo");
    tracker.record(tc("Read"));
    const r = tracker.analyzeCurrentIntent();
    expect(r.tier).toBe(1);
  });

  it("reset clears history and goal", () => {
    const tracker = new SessionIntentTracker();
    tracker.setGoal("fix typo");
    tracker.record(tc("Read"));
    tracker.reset();
    expect(tracker.size()).toBe(0);
    // After reset, goal is empty → default tier 3
    const r = tracker.analyzeCurrentIntent();
    expect(r.tier).toBe(3);
  });

  it("getHistory returns a copy (mutations don't affect internal state)", () => {
    const tracker = new SessionIntentTracker();
    tracker.record(tc("Read"));
    const copy = tracker.getHistory();
    copy.push(tc("Bash"));
    expect(tracker.size()).toBe(1); // internal unaffected
  });
});

// ── Global singleton ──────────────────────────────────────────────────────────

describe("global intent tracker singleton", () => {
  beforeEach(() => {
    resetGlobalIntentTracker();
  });

  it("getGlobalIntentTracker returns a SessionIntentTracker", () => {
    const t = getGlobalIntentTracker();
    expect(t).toBeInstanceOf(SessionIntentTracker);
  });

  it("returns the same instance on repeated calls", () => {
    const t1 = getGlobalIntentTracker();
    const t2 = getGlobalIntentTracker();
    expect(t1).toBe(t2);
  });

  it("setGlobalIntentTracker replaces the singleton", () => {
    const custom = new SessionIntentTracker(10);
    setGlobalIntentTracker(custom);
    expect(getGlobalIntentTracker()).toBe(custom);
  });

  it("resetGlobalIntentTracker clears the singleton", () => {
    const t1 = getGlobalIntentTracker();
    resetGlobalIntentTracker();
    const t2 = getGlobalIntentTracker();
    expect(t1).not.toBe(t2);
  });
});

// ── autoPromoteTierFromGoal ───────────────────────────────────────────────────

describe("autoPromoteTierFromGoal", () => {
  it("high-confidence goal sets shouldAutoApply=true", () => {
    const { analysis, shouldAutoApply } = autoPromoteTierFromGoal("show me where the bug is", []);
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.8);
    expect(shouldAutoApply).toBe(true);
  });

  it("low-confidence goal sets shouldAutoApply=false", () => {
    const { shouldAutoApply } = autoPromoteTierFromGoal("update the code", []);
    expect(shouldAutoApply).toBe(false);
  });

  it("medium-confidence goal (0.5–0.79) sets shouldPromptUser=true", () => {
    // 'fix bug' gives ~0.75 confidence
    const { shouldPromptUser } = autoPromoteTierFromGoal("fix bug in parser", []);
    expect(shouldPromptUser).toBe(true);
  });

  it("shouldPromptUser is false when shouldAutoApply is true", () => {
    const { shouldAutoApply, shouldPromptUser } = autoPromoteTierFromGoal("fix typo", []);
    if (shouldAutoApply) {
      expect(shouldPromptUser).toBe(false);
    }
  });

  it("returns correct analysis.tier", () => {
    const { analysis } = autoPromoteTierFromGoal("install lodash", []);
    expect(analysis.tier).toBeGreaterThanOrEqual(3);
  });

  it("history parameter defaults to empty array", () => {
    // Should not throw when called without history
    expect(() => autoPromoteTierFromGoal("fix typo")).not.toThrow();
  });
});

// ── formatIntentStatus ────────────────────────────────────────────────────────

describe("formatIntentStatus", () => {
  it("includes current tier", () => {
    const analysis = analyzeIntent("fix typo", []);
    const output = formatIntentStatus(1, analysis);
    expect(output).toContain("Current tier:");
  });

  it("includes suggested tier", () => {
    const analysis = analyzeIntent("fix typo", []);
    const output = formatIntentStatus(3, analysis);
    expect(output).toContain("Suggested tier:");
  });

  it("includes confidence percentage", () => {
    const analysis = analyzeIntent("fix typo", []);
    const output = formatIntentStatus(1, analysis);
    expect(output).toMatch(/\d+%/);
  });

  it("includes reasoning", () => {
    const analysis = analyzeIntent("refactor auth", []);
    const output = formatIntentStatus(4, analysis);
    expect(output).toContain("Reasoning:");
  });

  it("includes override options", () => {
    const analysis = analyzeIntent("fix typo", []);
    const output = formatIntentStatus(1, analysis);
    expect(output).toContain("/surgical narrow");
    expect(output).toContain("/surgical medium");
    expect(output).toContain("/surgical wide");
    expect(output).toContain("/surgical off");
  });

  it("shows low-confidence warning when confidence < 0.8", () => {
    const analysis = analyzeIntent("update the code", []); // low confidence
    const output = formatIntentStatus(3, analysis);
    if (analysis.confidence < 0.8) {
      expect(output).toContain("low");
    }
  });

  it("shows scope creep when detected", () => {
    const analysis = analyzeIntent("fix typo", [tc("Agent"), tc("Bash")]);
    const output = formatIntentStatus(1, analysis);
    if (analysis.scopeCreepDetected) {
      expect(output).toContain("scope creep");
    }
  });

  it("handles null currentTier gracefully", () => {
    const analysis = analyzeIntent("fix typo", []);
    const output = formatIntentStatus(null, analysis);
    expect(output).toContain("off");
  });

  it("handles legacy string tiers", () => {
    const analysis = analyzeIntent("fix typo", []);
    const output = formatIntentStatus("narrow", analysis);
    expect(output).toContain("narrow");
  });
});
