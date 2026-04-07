import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatLeaderboard,
  getAgentProfile,
  getStrategyLeaderboard,
  loadStrategies,
  recordStrategy,
  suggestStrategy,
  type StrategyRecord,
} from "../genome/strategies.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "ashlrcode-strat-test-"));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeRecord(
  overrides: Partial<Omit<StrategyRecord, "id" | "timestamp">> = {},
): Omit<StrategyRecord, "id" | "timestamp"> {
  return {
    name: "TDD",
    description: "Write tests before implementation",
    agentId: "agent-1",
    generation: 1,
    category: "testing",
    outcome: {
      success: true,
      testsPassedBefore: 10,
      testsPassedAfter: 15,
      filesModified: 3,
      duration: 5000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// recordStrategy + loadStrategies
// ---------------------------------------------------------------------------

describe("Strategy Recording", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("recordStrategy creates file and returns id", async () => {
    const id = await recordStrategy(tmpDir, makeRecord());
    expect(id).toMatch(/^strat-/);

    const strategies = await loadStrategies(tmpDir);
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toBe("TDD");
    expect(strategies[0]!.id).toBe(id);
    expect(strategies[0]!.timestamp).toBeTruthy();
  });

  test("multiple records accumulate", async () => {
    await recordStrategy(tmpDir, makeRecord({ name: "TDD" }));
    await recordStrategy(tmpDir, makeRecord({ name: "Spike" }));
    await recordStrategy(tmpDir, makeRecord({ name: "Refactor First" }));

    const strategies = await loadStrategies(tmpDir);
    expect(strategies).toHaveLength(3);
  });

  test("loadStrategies returns empty for fresh dir", async () => {
    const strategies = await loadStrategies(tmpDir);
    expect(strategies).toEqual([]);
  });

  test("loadStrategies filters by generation", async () => {
    await recordStrategy(tmpDir, makeRecord({ generation: 1 }));
    await recordStrategy(tmpDir, makeRecord({ generation: 2 }));
    await recordStrategy(tmpDir, makeRecord({ generation: 1 }));

    const gen1 = await loadStrategies(tmpDir, { generation: 1 });
    expect(gen1).toHaveLength(2);

    const gen2 = await loadStrategies(tmpDir, { generation: 2 });
    expect(gen2).toHaveLength(1);
  });

  test("loadStrategies filters by category", async () => {
    await recordStrategy(tmpDir, makeRecord({ category: "testing" }));
    await recordStrategy(tmpDir, makeRecord({ category: "debugging" }));
    await recordStrategy(tmpDir, makeRecord({ category: "testing" }));

    const testing = await loadStrategies(tmpDir, { category: "testing" });
    expect(testing).toHaveLength(2);
  });

  test("loadStrategies filters by agentId", async () => {
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-2" }));

    const agent1 = await loadStrategies(tmpDir, { agentId: "agent-1" });
    expect(agent1).toHaveLength(1);
    expect(agent1[0]!.agentId).toBe("agent-1");
  });

  test("loadStrategies combines filters", async () => {
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", category: "testing", generation: 1 }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", category: "debugging", generation: 1 }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-2", category: "testing", generation: 1 }));

    const filtered = await loadStrategies(tmpDir, { agentId: "agent-1", category: "testing" });
    expect(filtered).toHaveLength(1);
  });

  test("recordStrategy preserves outcome metrics", async () => {
    await recordStrategy(
      tmpDir,
      makeRecord({
        outcome: {
          success: false,
          testsPassedBefore: 20,
          testsPassedAfter: 18,
          filesModified: 7,
          duration: 12000,
          costUsd: 0.05,
        },
      }),
    );

    const strategies = await loadStrategies(tmpDir);
    expect(strategies[0]!.outcome.success).toBe(false);
    expect(strategies[0]!.outcome.testsPassedBefore).toBe(20);
    expect(strategies[0]!.outcome.testsPassedAfter).toBe(18);
    expect(strategies[0]!.outcome.filesModified).toBe(7);
    expect(strategies[0]!.outcome.duration).toBe(12000);
    expect(strategies[0]!.outcome.costUsd).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

describe("Strategy Leaderboard", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("empty leaderboard for no strategies", async () => {
    const board = await getStrategyLeaderboard(tmpDir);
    expect(board).toEqual([]);
  });

  test("strategies with <2 uses excluded from leaderboard", async () => {
    await recordStrategy(tmpDir, makeRecord({ name: "OneShot", category: "testing" }));

    const board = await getStrategyLeaderboard(tmpDir);
    expect(board).toEqual([]);
  });

  test("leaderboard ranks by success rate", async () => {
    // "TDD" — 2/3 success
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", outcome: { success: true, testsPassedBefore: 5, testsPassedAfter: 10, filesModified: 2, duration: 3000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", outcome: { success: true, testsPassedBefore: 5, testsPassedAfter: 8, filesModified: 1, duration: 2000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", outcome: { success: false, testsPassedBefore: 5, testsPassedAfter: 5, filesModified: 1, duration: 4000 } }));

    // "Spike" — 2/2 success
    await recordStrategy(tmpDir, makeRecord({ name: "Spike", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 5, filesModified: 4, duration: 6000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "Spike", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 3, filesModified: 3, duration: 5000 } }));

    const board = await getStrategyLeaderboard(tmpDir);
    expect(board).toHaveLength(1); // 1 category: "testing"
    expect(board[0]!.category).toBe("testing");
    expect(board[0]!.entries).toHaveLength(2);

    // Spike (100%) should rank above TDD (66%)
    expect(board[0]!.entries[0]!.name).toBe("Spike");
    expect(board[0]!.entries[0]!.successRate).toBe(1);
    expect(board[0]!.entries[1]!.name).toBe("TDD");
    expect(board[0]!.entries[1]!.successRate).toBeCloseTo(2 / 3);
  });

  test("leaderboard groups by category", async () => {
    // Testing strategies
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", category: "testing", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 5, filesModified: 1, duration: 1000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", category: "testing", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 3, filesModified: 1, duration: 1000 } }));

    // Debugging strategies
    await recordStrategy(tmpDir, makeRecord({ name: "Binary Search", category: "debugging", outcome: { success: true, testsPassedBefore: 8, testsPassedAfter: 10, filesModified: 1, duration: 2000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "Binary Search", category: "debugging", outcome: { success: false, testsPassedBefore: 8, testsPassedAfter: 8, filesModified: 0, duration: 3000 } }));

    const board = await getStrategyLeaderboard(tmpDir);
    expect(board).toHaveLength(2);

    const categories = board.map((b) => b.category);
    expect(categories).toContain("testing");
    expect(categories).toContain("debugging");
  });

  test("leaderboard calculates avg test improvement", async () => {
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", outcome: { success: true, testsPassedBefore: 5, testsPassedAfter: 10, filesModified: 2, duration: 3000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", outcome: { success: true, testsPassedBefore: 5, testsPassedAfter: 8, filesModified: 1, duration: 2000 } }));

    const board = await getStrategyLeaderboard(tmpDir);
    const entry = board[0]!.entries[0]!;
    // avg: ((10-5) + (8-5)) / 2 = 4
    expect(entry.avgTestImprovement).toBeCloseTo(4);
    expect(entry.avgDuration).toBeCloseTo(2500);
  });
});

// ---------------------------------------------------------------------------
// Agent Profile
// ---------------------------------------------------------------------------

describe("Agent Profile", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("empty profile for unknown agent", async () => {
    const profile = await getAgentProfile(tmpDir, "nobody");
    expect(profile.agentId).toBe("nobody");
    expect(profile.totalStrategies).toBe(0);
    expect(profile.successRate).toBe(0);
    expect(profile.topStrategies).toEqual([]);
  });

  test("profile tracks category counts", async () => {
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", category: "testing" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", category: "testing" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", category: "debugging" }));

    const profile = await getAgentProfile(tmpDir, "agent-1");
    expect(profile.totalStrategies).toBe(3);
    expect(profile.categoryCounts["testing"]).toBe(2);
    expect(profile.categoryCounts["debugging"]).toBe(1);
  });

  test("profile calculates success rate", async () => {
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 5, filesModified: 1, duration: 1000 } }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", outcome: { success: false, testsPassedBefore: 0, testsPassedAfter: 0, filesModified: 1, duration: 1000 } }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 3, filesModified: 1, duration: 1000 } }));

    const profile = await getAgentProfile(tmpDir, "agent-1");
    expect(profile.successRate).toBeCloseTo(2 / 3);
  });

  test("profile lists top strategies sorted by usage", async () => {
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", name: "TDD" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", name: "TDD" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", name: "TDD" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1", name: "Spike" }));

    const profile = await getAgentProfile(tmpDir, "agent-1");
    expect(profile.topStrategies[0]!.name).toBe("TDD");
    expect(profile.topStrategies[0]!.uses).toBe(3);
    expect(profile.topStrategies[1]!.name).toBe("Spike");
    expect(profile.topStrategies[1]!.uses).toBe(1);
  });

  test("profile ignores other agents", async () => {
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-1" }));
    await recordStrategy(tmpDir, makeRecord({ agentId: "agent-2" }));

    const profile = await getAgentProfile(tmpDir, "agent-1");
    expect(profile.totalStrategies).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// suggestStrategy
// ---------------------------------------------------------------------------

describe("Suggest Strategy", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("returns null for empty data", async () => {
    const result = await suggestStrategy(tmpDir, "testing");
    expect(result).toBeNull();
  });

  test("returns null when no strategy has 2+ uses", async () => {
    await recordStrategy(tmpDir, makeRecord({ name: "OneShot", category: "testing" }));
    const result = await suggestStrategy(tmpDir, "testing");
    expect(result).toBeNull();
  });

  test("suggests highest success rate strategy", async () => {
    // "TDD" — 1/2 success
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", category: "testing", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 5, filesModified: 1, duration: 1000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", category: "testing", outcome: { success: false, testsPassedBefore: 0, testsPassedAfter: 0, filesModified: 1, duration: 2000 } }));

    // "Property Testing" — 2/2 success
    await recordStrategy(tmpDir, makeRecord({ name: "Property Testing", category: "testing", outcome: { success: true, testsPassedBefore: 5, testsPassedAfter: 12, filesModified: 2, duration: 3000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "Property Testing", category: "testing", outcome: { success: true, testsPassedBefore: 5, testsPassedAfter: 10, filesModified: 2, duration: 4000 } }));

    const result = await suggestStrategy(tmpDir, "testing");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Property Testing");
    expect(result!.successRate).toBe(1);
  });

  test("only considers strategies in the requested category", async () => {
    // Great testing strategy
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", category: "testing", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 5, filesModified: 1, duration: 1000 } }));
    await recordStrategy(tmpDir, makeRecord({ name: "TDD", category: "testing", outcome: { success: true, testsPassedBefore: 0, testsPassedAfter: 3, filesModified: 1, duration: 1000 } }));

    // No debugging strategies with 2+ uses
    const result = await suggestStrategy(tmpDir, "debugging");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatLeaderboard
// ---------------------------------------------------------------------------

describe("Format Leaderboard", () => {
  test("empty message for no data", () => {
    const output = formatLeaderboard([]);
    expect(output).toContain("No strategies");
  });

  test("formats leaderboard with entries", () => {
    const output = formatLeaderboard([
      {
        category: "testing",
        entries: [
          { name: "TDD", uses: 5, successes: 4, successRate: 0.8, avgDuration: 3000, avgTestImprovement: 3.5 },
          { name: "Spike", uses: 3, successes: 2, successRate: 0.667, avgDuration: 5000, avgTestImprovement: 1.2 },
        ],
      },
    ]);

    expect(output).toContain("Strategy Leaderboard");
    expect(output).toContain("TESTING");
    expect(output).toContain("TDD");
    expect(output).toContain("Spike");
    expect(output).toContain("80%");
    expect(output).toContain("+3.5");
  });

  test("formats multiple categories", () => {
    const output = formatLeaderboard([
      {
        category: "debugging",
        entries: [{ name: "Binary Search", uses: 2, successes: 2, successRate: 1, avgDuration: 2000, avgTestImprovement: 2 }],
      },
      {
        category: "testing",
        entries: [{ name: "TDD", uses: 3, successes: 3, successRate: 1, avgDuration: 1000, avgTestImprovement: 5 }],
      },
    ]);

    expect(output).toContain("DEBUGGING");
    expect(output).toContain("TESTING");
  });

  test("truncates long strategy names", () => {
    const output = formatLeaderboard([
      {
        category: "architecture",
        entries: [
          {
            name: "Very Long Strategy Name That Exceeds Column Width",
            uses: 2,
            successes: 2,
            successRate: 1,
            avgDuration: 1000,
            avgTestImprovement: 0,
          },
        ],
      },
    ]);

    expect(output).toContain("...");
  });
});
