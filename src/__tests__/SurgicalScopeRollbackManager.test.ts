/**
 * Tests for SurgicalScopeRollbackManager
 *
 * Covers:
 *   1.  No proposal when only 1 tool blocked
 *   2.  Proposal triggered at blockThreshold=2 distinct tools
 *   3.  Duplicate tool blocks don't count twice
 *   4.  Tier 1 (narrow) with Read + Bash blocked → propose Tier 3
 *   5.  Tier 2 (fine) with Bash + LSP blocked → propose Tier 4
 *   6.  Tier 3 (balanced) with Agent blocked (only 1 tool) → no proposal
 *   7.  acceptWiden() advances to proposed tier
 *   8.  rejectWiden() keeps session at current tier
 *   9.  acceptWiden() with no pending proposal returns null
 *   10. rejectWiden() with no pending proposal returns false
 *   11. beginTurn() resets per-turn blocks so stale blocks don't carry over
 *   12. capabilityAnalysis() maps exploration goal → Tier 1
 *   13. capabilityAnalysis() maps test-fix goal → Tier 3
 *   14. capabilityAnalysis() maps refactor goal → Tier 4
 *   15. costDeltaForWiden() wider tier costs more than narrow tier
 *   16. formatProposal() includes tier names and /surgical widen hint
 *   17. formatCapabilityAnalysis() includes recommended tier and tools
 *   18. proposalHistory() accumulates across turns
 *   19. Custom blockThreshold=3 does not fire at 2 distinct blocks
 *   20. reset() clears all state
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  SurgicalScopeRollbackManager,
  resetGlobalRollbackManager,
  getGlobalRollbackManager,
  setGlobalRollbackManager,
} from "../agent/surgical-scope-rollback.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(options?: ConstructorParameters<typeof SurgicalScopeRollbackManager>[1]) {
  return new SurgicalScopeRollbackManager("test-session", {
    logToDisk: false,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// 1. No proposal when only 1 tool blocked
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — single blocked tool", () => {
  test("shouldProposeWiden() is false after 1 unique block", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked by Tier 1", 1);
    expect(mgr.shouldProposeWiden()).toBe(false);
  });

  test("trackBlockedTool() returns false for single unique block", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    const fired = mgr.trackBlockedTool("Bash", "blocked", 1);
    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Proposal triggered at blockThreshold=2 distinct tools
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — two distinct tools blocked", () => {
  test("shouldProposeWiden() is true after 2 unique blocks", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("LSP", "blocked", 1);
    expect(mgr.shouldProposeWiden()).toBe(true);
  });

  test("trackBlockedTool() returns true on the second distinct block", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    const fired = mgr.trackBlockedTool("Edit", "blocked", 1);
    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate tool blocks don't count twice
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — duplicate tool", () => {
  test("blocking the same tool twice does not fire proposal", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    const fired = mgr.trackBlockedTool("Bash", "blocked again", 1);
    expect(fired).toBe(false);
    expect(mgr.shouldProposeWiden()).toBe(false);
  });

  test("same tool 3 times + 1 different tool does fire proposal", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    const fired = mgr.trackBlockedTool("Edit", "blocked", 1);
    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Tier 1 with Bash + Edit blocked → propose at least Tier 2+
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — Tier 1 (micro) dead-end", () => {
  test("Bash + Edit blocked at Tier 1 produces a proposal to widen", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked by Tier 1 (micro)", 1);
    mgr.trackBlockedTool("Edit", "blocked by Tier 1 (micro)", 1);

    const proposal = await mgr.proposeWiden(1);
    expect(proposal.fromTier).toBe(1);
    expect(proposal.toTier).toBeGreaterThan(1);
    expect(proposal.status).toBe("pending");
    expect(proposal.blockedTools).toContain("Bash");
    expect(proposal.blockedTools).toContain("Edit");
  });

  test("Bash + Edit at Tier 1 proposes Tier 3 (Bash requires Tier 3)", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);

    const proposal = await mgr.proposeWiden(1);
    // Bash is first available at Tier 3; Edit at Tier 2 — max is Tier 3
    expect(proposal.toTier).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Tier 2 (fine) with Bash + LSP blocked → propose Tier 4
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — Tier 2 (fine) dead-end", () => {
  test("Bash + LSP blocked at Tier 2 proposes Tier 4 (LSP is Tier 4 only)", async () => {
    const mgr = makeManager();
    mgr.beginTurn(2);
    mgr.trackBlockedTool("Bash", "blocked by Tier 2", 2);
    mgr.trackBlockedTool("LSP", "blocked by Tier 2", 2);

    const proposal = await mgr.proposeWiden(2);
    expect(proposal.fromTier).toBe(2);
    expect(proposal.toTier).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 6. Tier 3 with only Agent blocked (1 tool) — no proposal
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — Tier 3 single block", () => {
  test("Agent blocked alone at Tier 3 does not fire proposal", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    const fired = mgr.trackBlockedTool("Agent", "blocked by Tier 3", 3);
    expect(fired).toBe(false);
    expect(mgr.shouldProposeWiden()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. acceptWiden() advances to proposed tier
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — acceptWiden()", () => {
  test("returns proposed toTier after accept", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    const proposal = await mgr.proposeWiden(1);
    const expectedTier = proposal.toTier;

    const accepted = await mgr.acceptWiden();
    expect(accepted).toBe(expectedTier);
  });

  test("pendingProposal is null after accept", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);
    await mgr.acceptWiden();
    expect(mgr.getPendingProposal()).toBeNull();
  });

  test("accepted proposal has status 'accepted' in history", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);
    await mgr.acceptWiden();
    const history = mgr.getProposalHistory();
    expect(history[0]?.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// 8. rejectWiden() keeps session at current tier
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — rejectWiden()", () => {
  test("returns true when a proposal exists", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);
    const rejected = await mgr.rejectWiden();
    expect(rejected).toBe(true);
  });

  test("pendingProposal is null after reject", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);
    await mgr.rejectWiden();
    expect(mgr.getPendingProposal()).toBeNull();
  });

  test("rejected proposal has status 'rejected' in history", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);
    await mgr.rejectWiden();
    const history = mgr.getProposalHistory();
    expect(history[0]?.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 9. acceptWiden() with no pending proposal returns null
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — acceptWiden() no proposal", () => {
  test("returns null when no pending proposal", async () => {
    const mgr = makeManager();
    const result = await mgr.acceptWiden();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. rejectWiden() with no pending proposal returns false
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — rejectWiden() no proposal", () => {
  test("returns false when no pending proposal", async () => {
    const mgr = makeManager();
    const result = await mgr.rejectWiden();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. beginTurn() resets per-turn blocks so stale blocks don't carry over
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — turn isolation", () => {
  test("blocks from turn N do not affect turn N+1", () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    expect(mgr.shouldProposeWiden()).toBe(true);

    // Start new turn — blocks should reset
    mgr.beginTurn(2);
    expect(mgr.shouldProposeWiden()).toBe(false);
    expect(mgr.blockedToolsThisTurn().size).toBe(0);
  });

  test("turn number is updated by beginTurn()", () => {
    const mgr = makeManager();
    mgr.beginTurn(5);
    expect(mgr.turn()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 12. capabilityAnalysis() maps exploration goal → Tier 1
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — capabilityAnalysis()", () => {
  test("exploration goal suggests read-only tools (Tier 1 sufficient)", () => {
    const mgr = makeManager();
    const result = mgr.capabilityAnalysis("show me what is in the config file");
    // Should contain only read-type tools (Read, Grep, Glob, LS)
    const hasWriteTools = result.requiredTools.some((t) => ["Edit", "Write", "Bash"].includes(t));
    expect(hasWriteTools).toBe(false);
    expect(result.recommendedTier).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 13. capabilityAnalysis() maps test-fix goal → Tier 3
  // ---------------------------------------------------------------------------

  test("fix failing test goal requires Bash/Test (Tier 3)", () => {
    const mgr = makeManager();
    const result = mgr.capabilityAnalysis("fix the failing test in auth module");
    expect(result.requiredTools).toContain("Bash");
    expect(result.recommendedTier).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // 14. capabilityAnalysis() maps refactor goal → Tier 4
  // ---------------------------------------------------------------------------

  test("refactor goal requires Agent (Tier 4)", () => {
    const mgr = makeManager();
    const result = mgr.capabilityAnalysis("refactor everything across all files");
    expect(result.requiredTools).toContain("Agent");
    expect(result.recommendedTier).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 15. costDeltaForWiden() wider tier costs more than narrow tier
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — costDeltaForWiden()", () => {
  test("widening from Tier 1 to Tier 3 increases cost", () => {
    const mgr = makeManager();
    const delta = mgr.costDeltaForWiden("fix failing auth test", 1, 3);
    expect(delta.fromTier).toBe(1);
    expect(delta.toTier).toBe(3);
    expect(delta.deltaUSD).toBeGreaterThan(0);
    expect(delta.costAtWidenedTier.costUSD).toBeGreaterThan(delta.costAtCurrentTier.costUSD);
  });

  test("costDeltaForWiden() formatted string includes both tier names", () => {
    const mgr = makeManager();
    const delta = mgr.costDeltaForWiden("fix typo", 1, 3);
    expect(delta.formatted).toContain("Tier 1");
    expect(delta.formatted).toContain("Tier 3");
  });
});

// ---------------------------------------------------------------------------
// 16. formatProposal() includes tier names and /surgical widen hint
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — formatProposal()", () => {
  test("formatProposal() includes from/to tier labels and command hint", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    const proposal = await mgr.proposeWiden(1);
    const text = mgr.formatProposal(proposal);
    expect(text).toContain("Tier 1");
    expect(text).toContain("/surgical widen");
    expect(text).toContain("/surgical stay");
  });

  test("formatProposal() with goal shows cost delta", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    const proposal = await mgr.proposeWiden(1);
    const text = mgr.formatProposal(proposal, "fix the failing test");
    expect(text).toContain("Cost:");
  });
});

// ---------------------------------------------------------------------------
// 17. formatCapabilityAnalysis() includes recommended tier and tools
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — formatCapabilityAnalysis()", () => {
  test("includes recommended tier and list of tools", () => {
    const mgr = makeManager();
    const result = mgr.capabilityAnalysis("run the test suite");
    const text = mgr.formatCapabilityAnalysis(result);
    expect(text).toContain("Recommended minimum tier");
    expect(text).toContain("Required tools");
  });
});

// ---------------------------------------------------------------------------
// 18. proposalHistory() accumulates across turns
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — proposal history", () => {
  test("multiple proposals across turns are all recorded", async () => {
    const mgr = makeManager();

    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);
    await mgr.acceptWiden();

    mgr.beginTurn(2);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("LSP", "blocked", 1);
    await mgr.proposeWiden(1);
    await mgr.rejectWiden();

    const history = mgr.getProposalHistory();
    expect(history.length).toBe(2);
    expect(history[0]?.status).toBe("accepted");
    expect(history[1]?.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 19. Custom blockThreshold=3 does not fire at 2 distinct blocks
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — custom blockThreshold", () => {
  test("blockThreshold=3 does not fire at exactly 2 distinct blocks", () => {
    const mgr = makeManager({ blockThreshold: 3, logToDisk: false });
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    const fired = mgr.trackBlockedTool("Edit", "blocked", 1);
    expect(fired).toBe(false);
    expect(mgr.shouldProposeWiden()).toBe(false);
  });

  test("blockThreshold=3 fires at exactly 3 distinct blocks", () => {
    const mgr = makeManager({ blockThreshold: 3, logToDisk: false });
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    const fired = mgr.trackBlockedTool("LSP", "blocked", 1);
    expect(fired).toBe(true);
    expect(mgr.shouldProposeWiden()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 20. reset() clears all state
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — reset()", () => {
  test("reset() clears blocked tools, pending proposal and history", async () => {
    const mgr = makeManager();
    mgr.beginTurn(1);
    mgr.trackBlockedTool("Bash", "blocked", 1);
    mgr.trackBlockedTool("Edit", "blocked", 1);
    await mgr.proposeWiden(1);

    mgr.reset();

    expect(mgr.shouldProposeWiden()).toBe(false);
    expect(mgr.getPendingProposal()).toBeNull();
    expect(mgr.getProposalHistory()).toHaveLength(0);
    expect(mgr.blockedToolsThisTurn().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Module-level singleton helpers
// ---------------------------------------------------------------------------

describe("SurgicalScopeRollbackManager — module singletons", () => {
  beforeEach(() => {
    resetGlobalRollbackManager();
  });

  test("getGlobalRollbackManager() returns same instance on repeated calls", () => {
    const a = getGlobalRollbackManager("session-x", { logToDisk: false });
    const b = getGlobalRollbackManager("session-x", { logToDisk: false });
    expect(a).toBe(b);
  });

  test("setGlobalRollbackManager() replaces the singleton", () => {
    const custom = new SurgicalScopeRollbackManager("custom", { logToDisk: false });
    setGlobalRollbackManager(custom);
    const got = getGlobalRollbackManager();
    expect(got).toBe(custom);
  });

  test("resetGlobalRollbackManager() causes next get to create a new instance", () => {
    const first = getGlobalRollbackManager("s", { logToDisk: false });
    resetGlobalRollbackManager();
    const second = getGlobalRollbackManager("s", { logToDisk: false });
    expect(first).not.toBe(second);
  });
});
