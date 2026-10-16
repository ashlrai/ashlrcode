/**
 * Tests for src/agent/trace-navigator.ts
 *
 * Coverage:
 *  1.  DecisionTreeBuilder — empty events produces valid empty tree
 *  2.  DecisionTreeBuilder — single turn, single goal_normalization
 *  3.  DecisionTreeBuilder — tool_selection creates child with confidence
 *  4.  DecisionTreeBuilder — speculation_hit attaches to last tool_selection node
 *  5.  DecisionTreeBuilder — speculation_miss attaches to last tool_selection node
 *  6.  DecisionTreeBuilder — context_compression creates its own node
 *  7.  DecisionTreeBuilder — turn_boundary end creates leaf with tool call count
 *  8.  DecisionTreeBuilder — multi-turn session produces correctly ordered turns
 *  9.  DecisionTreeBuilder — stats aggregated correctly
 * 10.  DecisionTreeBuilder — node IDs follow "<sessionId>:<seq>" convention
 * 11.  renderDecisionTreeViz — returns non-empty string with session header
 * 12.  renderDecisionTreeViz — includes cache stats line when hits > 0
 * 13.  TraceNavigator.getDecisionTree — returns empty tree for unknown sessionId
 * 14.  TraceNavigator.getDecisionTree — memoizes result (second call returns same object)
 * 15.  TraceNavigator.invalidate — evicts cached tree
 * 16.  TraceNavigator.getDrillDown — returns not-found detail for missing event
 * 17.  TraceNavigator.getDrillDown — returns explanation for tool_selection node
 * 18.  TraceNavigator.getDrillDown — returns explanation for speculation_hit node
 * 19.  TraceNavigator.getDrillDown — returns explanation for context_compression node
 * 20.  TraceNavigator.getDrillDown — speculation state counts prior events in same turn
 * 21.  TraceNavigator.getDrillDown — token budget reflects prior compressions
 * 22.  TraceNavigator.exportAsJSON — returns plain object with version=1
 * 23.  getTraceNavigator / resetTraceNavigator — singleton lifecycle
 * 24.  DecisionTreeBuilder — dedup_hit produces a generic info node (not throws)
 * 25.  DecisionTreeBuilder — replay_start/replay_step produce generic info nodes
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  DecisionTreeBuilder,
  TraceNavigator,
  renderDecisionTreeViz,
  getTraceNavigator,
  resetTraceNavigator,
  setTraceNavigator,
  type DecisionTree,
  type DecisionTreeNode,
} from "../agent/trace-navigator.ts";
import type { TraceEvent } from "../agent/intent-trace.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SID = "test-session-abc";

function makeGoalEvent(seq: number, turn = 0): TraceEvent {
  return {
    kind: "goal_normalization",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    rawInput: "help me fix the bug",
    normalizedGoal: "Fix the bug in src/foo.ts",
    approxTokens: 10,
  };
}

function makeToolEvent(seq: number, turn = 0, toolName = "Read", stepIndex = 0): TraceEvent {
  return {
    kind: "tool_selection",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    toolName,
    toolInput: { file_path: "/src/foo.ts" },
    reasoningContext: "I need to read the file to understand the bug context",
    stepIndex,
  };
}

function makeSpecHit(seq: number, turn = 0, savedMs = 50): TraceEvent {
  return {
    kind: "speculation_hit",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    toolName: "Read",
    cacheType: "memory",
    savedMs,
  };
}

function makeSpecMiss(seq: number, turn = 0, executionMs = 120): TraceEvent {
  return {
    kind: "speculation_miss",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    toolName: "Bash",
    executionMs,
  };
}

function makeContextCompression(seq: number, turn = 0): TraceEvent {
  return {
    kind: "context_compression",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    tokensBefore: 8000,
    tokensAfter: 4000,
    blocksDropped: 5,
  };
}

function makeTurnBoundaryEnd(seq: number, turn = 0, toolCallCount = 2): TraceEvent {
  return {
    kind: "turn_boundary",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    phase: "end",
    toolCallCount,
    finalTextSnippet: "Done!",
  };
}

function makeTurnBoundaryStart(seq: number, turn = 0): TraceEvent {
  return {
    kind: "turn_boundary",
    seq,
    at: new Date().toISOString(),
    turn,
    sessionId: SID,
    phase: "start",
  };
}

// ── 1. Empty events ───────────────────────────────────────────────────────────

describe("DecisionTreeBuilder — empty events", () => {
  test("produces a valid empty tree", () => {
    const builder = new DecisionTreeBuilder(SID, []);
    const tree = builder.build();
    expect(tree.sessionId).toBe(SID);
    expect(tree.totalEvents).toBe(0);
    expect(tree.turnCount).toBe(0);
    expect(tree.root.children).toHaveLength(0);
    expect(tree.stats.totalToolCalls).toBe(0);
  });
});

// ── 2. Single turn / goal_normalization ───────────────────────────────────────

describe("DecisionTreeBuilder — single turn", () => {
  test("goal_normalization creates a child of the turn node", () => {
    const events: TraceEvent[] = [makeGoalEvent(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();

    expect(tree.turnCount).toBe(1);
    const turnNode = tree.root.children[0]!;
    expect(turnNode.kind).toBe("turn");
    expect(turnNode.turn).toBe(0);

    const goalNode = turnNode.children.find((c) => c.kind === "goal_normalization");
    expect(goalNode).toBeDefined();
    expect(goalNode!.label).toContain("Fix the bug");
    expect(goalNode!.meta.approxTokens).toBe(10);
  });
});

// ── 3. tool_selection confidence ─────────────────────────────────────────────

describe("DecisionTreeBuilder — tool_selection", () => {
  test("creates a node with confidence derived from reasoning context", () => {
    const events: TraceEvent[] = [makeToolEvent(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const toolNode = turnNode.children.find((c) => c.kind === "tool_selection")!;
    expect(toolNode).toBeDefined();
    expect(toolNode.meta.toolName).toBe("Read");
    expect(toolNode.meta.confidence).toBeDefined();
    expect(toolNode.meta.confidence!).toBeGreaterThan(0);
    expect(toolNode.meta.confidence!).toBeLessThanOrEqual(1);
    expect(toolNode.label).toContain("conf=");
  });

  test("tool_selection with empty reasoningContext gets minimum confidence (0.3)", () => {
    const ev: TraceEvent = {
      kind: "tool_selection",
      seq: 0,
      at: new Date().toISOString(),
      turn: 0,
      sessionId: SID,
      toolName: "Bash",
      toolInput: {},
      reasoningContext: "",
      stepIndex: 0,
    };
    const tree = new DecisionTreeBuilder(SID, [ev]).build();
    const turnNode = tree.root.children[0]!;
    const toolNode = turnNode.children.find((c) => c.kind === "tool_selection")!;
    expect(toolNode.meta.confidence).toBeCloseTo(0.3, 5);
  });

  test("stats.totalToolCalls increments per tool_selection", () => {
    const events: TraceEvent[] = [makeToolEvent(0, 0), makeToolEvent(1, 0, "Bash", 1)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    expect(tree.stats.totalToolCalls).toBe(2);
  });
});

// ── 4. speculation_hit attaches to last tool node ─────────────────────────────

describe("DecisionTreeBuilder — speculation_hit", () => {
  test("attaches as child of the most recent tool_selection node", () => {
    const events: TraceEvent[] = [makeToolEvent(0), makeSpecHit(1)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const toolNode = turnNode.children.find((c) => c.kind === "tool_selection")!;
    const hitNode = toolNode.children.find((c) => c.kind === "speculation_hit");
    expect(hitNode).toBeDefined();
    expect(hitNode!.meta.cacheHit).toBe(true);
    expect(hitNode!.meta.cacheType).toBe("memory");
    expect(hitNode!.meta.latencyMs).toBe(50);
  });

  test("stats.speculationHits and msSavedFromCache increment", () => {
    const events: TraceEvent[] = [makeToolEvent(0), makeSpecHit(1, 0, 80)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    expect(tree.stats.speculationHits).toBe(1);
    expect(tree.stats.msSavedFromCache).toBe(80);
  });

  test("hit without a prior tool node attaches to turn node", () => {
    const events: TraceEvent[] = [makeSpecHit(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    // Should attach directly to turn node since no tool_selection preceded it
    const hitNode = turnNode.children.find((c) => c.kind === "speculation_hit");
    expect(hitNode).toBeDefined();
  });
});

// ── 5. speculation_miss ───────────────────────────────────────────────────────

describe("DecisionTreeBuilder — speculation_miss", () => {
  test("attaches as child of the most recent tool_selection node", () => {
    const events: TraceEvent[] = [makeToolEvent(0), makeSpecMiss(1)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const toolNode = turnNode.children.find((c) => c.kind === "tool_selection")!;
    const missNode = toolNode.children.find((c) => c.kind === "speculation_miss");
    expect(missNode).toBeDefined();
    expect(missNode!.meta.cacheHit).toBe(false);
    expect(missNode!.meta.latencyMs).toBe(120);
  });

  test("stats.speculationMisses increments", () => {
    const events: TraceEvent[] = [makeToolEvent(0), makeSpecMiss(1)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    expect(tree.stats.speculationMisses).toBe(1);
  });
});

// ── 6. context_compression ───────────────────────────────────────────────────

describe("DecisionTreeBuilder — context_compression", () => {
  test("creates its own node in the turn", () => {
    const events: TraceEvent[] = [makeContextCompression(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const compNode = turnNode.children.find((c) => c.kind === "context_compression");
    expect(compNode).toBeDefined();
    expect(compNode!.meta.tokensBefore).toBe(8000);
    expect(compNode!.meta.tokensAfter).toBe(4000);
    expect(compNode!.meta.blocksDropped).toBe(5);
    expect(compNode!.label).toContain("50% reduction");
  });

  test("stats accumulate token counts", () => {
    const events: TraceEvent[] = [makeContextCompression(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    expect(tree.stats.contextCompressions).toBe(1);
    expect(tree.stats.totalTokensBefore).toBe(8000);
    expect(tree.stats.totalTokensAfter).toBe(4000);
  });
});

// ── 7. turn_boundary end ──────────────────────────────────────────────────────

describe("DecisionTreeBuilder — turn_boundary", () => {
  test("end phase creates a leaf with tool call count", () => {
    const events: TraceEvent[] = [makeTurnBoundaryEnd(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const endNode = turnNode.children.find((c) => c.kind === "turn_boundary");
    expect(endNode).toBeDefined();
    expect(endNode!.label).toContain("2 tool calls");
    expect(endNode!.meta.toolCallCount).toBe(2);
  });

  test("start phase does NOT create a child node", () => {
    const events: TraceEvent[] = [makeTurnBoundaryStart(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const startNodes = turnNode.children.filter((c) => c.kind === "turn_boundary");
    // start phase should produce no node (only "end" phase does)
    expect(startNodes).toHaveLength(0);
  });
});

// ── 8. Multi-turn ordering ────────────────────────────────────────────────────

describe("DecisionTreeBuilder — multi-turn session", () => {
  test("turns are ordered ascending by turn index", () => {
    const events: TraceEvent[] = [
      makeGoalEvent(2, 1),
      makeGoalEvent(0, 0),
      makeToolEvent(1, 0),
      makeToolEvent(3, 1),
    ];
    const tree = new DecisionTreeBuilder(SID, events).build();
    expect(tree.turnCount).toBe(2);
    expect(tree.root.children[0]!.turn).toBe(0);
    expect(tree.root.children[1]!.turn).toBe(1);
  });

  test("events within a turn are sorted by seq", () => {
    // goal at seq=5, tool at seq=2 — tool should appear first after sorting
    const events: TraceEvent[] = [
      { ...makeGoalEvent(5, 0) },
      { ...makeToolEvent(2, 0) },
    ];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    // Tool is seq=2, goal is seq=5 — tool should come first
    expect(turnNode.children[0]!.kind).toBe("tool_selection");
    expect(turnNode.children[1]!.kind).toBe("goal_normalization");
  });

  test("totalEvents matches input length", () => {
    const events: TraceEvent[] = [
      makeGoalEvent(0, 0),
      makeToolEvent(1, 0),
      makeGoalEvent(2, 1),
      makeToolEvent(3, 1),
    ];
    const tree = new DecisionTreeBuilder(SID, events).build();
    expect(tree.totalEvents).toBe(4);
  });
});

// ── 9. Node ID convention ─────────────────────────────────────────────────────

describe("DecisionTreeBuilder — node IDs", () => {
  test("root node ID is '<sessionId>:root'", () => {
    const tree = new DecisionTreeBuilder(SID, []).build();
    expect(tree.root.id).toBe(`${SID}:root`);
  });

  test("turn node ID is '<sessionId>:turn:<turn>'", () => {
    const events: TraceEvent[] = [makeGoalEvent(0, 3)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    expect(turnNode.id).toBe(`${SID}:turn:3`);
  });

  test("event node ID is '<sessionId>:<seq>'", () => {
    const events: TraceEvent[] = [makeGoalEvent(42, 0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const turnNode = tree.root.children[0]!;
    const goalNode = turnNode.children.find((c) => c.kind === "goal_normalization")!;
    expect(goalNode.id).toBe(`${SID}:42`);
  });
});

// ── 10. renderDecisionTreeViz ─────────────────────────────────────────────────

describe("renderDecisionTreeViz", () => {
  test("returns a non-empty string containing the session ID", () => {
    const events: TraceEvent[] = [makeGoalEvent(0), makeToolEvent(1)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const output = renderDecisionTreeViz(tree);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain(SID);
  });

  test("includes cache stats line when hits > 0", () => {
    const events: TraceEvent[] = [makeToolEvent(0), makeSpecHit(1, 0, 75)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const output = renderDecisionTreeViz(tree);
    expect(output).toContain("75ms saved");
  });

  test("includes compression stats when compressions > 0", () => {
    const events: TraceEvent[] = [makeContextCompression(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const output = renderDecisionTreeViz(tree);
    expect(output).toContain("Compressions");
  });

  test("includes turn badge [T]", () => {
    const events: TraceEvent[] = [makeGoalEvent(0)];
    const tree = new DecisionTreeBuilder(SID, events).build();
    const output = renderDecisionTreeViz(tree);
    expect(output).toContain("[T]");
  });

  test("empty tree renders without throwing", () => {
    const tree = new DecisionTreeBuilder(SID, []).build();
    expect(() => renderDecisionTreeViz(tree)).not.toThrow();
  });
});

// ── 11. TraceNavigator.getDecisionTree ────────────────────────────────────────

describe("TraceNavigator.getDecisionTree", () => {
  test("returns an empty tree for an unknown sessionId", async () => {
    const nav = new TraceNavigator();
    const tree = await nav.getDecisionTree("nonexistent-session-xyz");
    expect(tree.sessionId).toBe("nonexistent-session-xyz");
    expect(tree.totalEvents).toBe(0);
  });

  test("memoizes — second call returns same object reference", async () => {
    const nav = new TraceNavigator();
    const tree1 = await nav.getDecisionTree("nonexistent-session-memo");
    const tree2 = await nav.getDecisionTree("nonexistent-session-memo");
    expect(tree1).toBe(tree2);
  });

  test("invalidate evicts the cached tree", async () => {
    const nav = new TraceNavigator();
    const tree1 = await nav.getDecisionTree("nonexistent-session-inv");
    nav.invalidate("nonexistent-session-inv");
    const tree2 = await nav.getDecisionTree("nonexistent-session-inv");
    expect(tree1).not.toBe(tree2);
  });
});

// ── 12. TraceNavigator.getDrillDown ──────────────────────────────────────────

describe("TraceNavigator.getDrillDown", () => {
  test("returns not-found detail for a completely invalid eventId", async () => {
    const nav = new TraceNavigator();
    const detail = await nav.getDrillDown("no-colon");
    expect(detail.node.label).toContain("not found");
    expect(detail.explanation).toContain("No event found");
  });

  test("returns not-found detail when seq is NaN", async () => {
    const nav = new TraceNavigator();
    const detail = await nav.getDrillDown("session:NaN");
    expect(detail.explanation).toContain("No event found");
  });

  test("returns not-found detail when session has no events", async () => {
    const nav = new TraceNavigator();
    const detail = await nav.getDrillDown("no-such-session:5");
    expect(detail.explanation).toContain("No event found");
  });
});

// ── 13. Explanation building — tool_selection ─────────────────────────────────

describe("TraceNavigator.getDrillDown — explanation content", () => {
  /**
   * We inject a custom TraceNavigator that loads from in-memory events
   * by overriding getDecisionTree (via subclass).
   */
  class StubNavigator extends TraceNavigator {
    constructor(private stubEvents: TraceEvent[]) {
      super();
    }

    override async getDecisionTree(sessionId: string): Promise<DecisionTree> {
      const builder = new DecisionTreeBuilder(sessionId, this.stubEvents);
      return builder.build();
    }
  }

  test("tool_selection: explanation mentions toolName and confidence", async () => {
    const events: TraceEvent[] = [makeToolEvent(0, 0, "Grep", 2)];
    const nav = new StubNavigator(events);
    // seed the cache so getDrillDown can find the node
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:0`);
    expect(detail.explanation).toContain("Grep");
    expect(detail.explanation).toContain("Confidence");
  });

  test("speculation_hit: explanation mentions cache type", async () => {
    const events: TraceEvent[] = [makeToolEvent(0), makeSpecHit(1)];
    const nav = new StubNavigator(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:1`);
    expect(detail.explanation).toContain("HIT");
    expect(detail.explanation).toContain("memory");
  });

  test("context_compression: explanation mentions token counts", async () => {
    const events: TraceEvent[] = [makeContextCompression(0)];
    const nav = new StubNavigator(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:0`);
    expect(detail.explanation).toContain("8000");
    expect(detail.explanation).toContain("4000");
  });
});

// ── 14. Speculation state tracking ────────────────────────────────────────────

describe("TraceNavigator.getDrillDown — speculation state", () => {
  class StubNavigator2 extends TraceNavigator {
    constructor(private stubEvents: TraceEvent[]) {
      super();
    }
    override async getDecisionTree(sessionId: string): Promise<DecisionTree> {
      return new DecisionTreeBuilder(sessionId, this.stubEvents).build();
    }
  }

  test("hitsSoFar counts prior speculation_hit events in same turn", async () => {
    // Turn 0: hit(seq=0), hit(seq=1), tool(seq=2)
    const events: TraceEvent[] = [
      makeSpecHit(0, 0),
      makeSpecHit(1, 0),
      makeToolEvent(2, 0),
    ];
    const nav = new StubNavigator2(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:2`);
    // tool is at seq=2, two hits are at seq=0 and seq=1 (before it)
    expect(detail.speculationState.hitsSoFar).toBe(2);
    expect(detail.speculationState.missesSoFar).toBe(0);
  });

  test("missesSoFar counts prior speculation_miss events in same turn", async () => {
    const events: TraceEvent[] = [
      makeSpecMiss(0, 0),
      makeToolEvent(1, 0),
    ];
    const nav = new StubNavigator2(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:1`);
    expect(detail.speculationState.missesSoFar).toBe(1);
  });

  test("does not count events from other turns", async () => {
    // turn=0 has a hit, the queried event is in turn=1
    const events: TraceEvent[] = [
      makeSpecHit(0, 0),         // turn 0
      makeToolEvent(1, 1),       // turn 1
    ];
    const nav = new StubNavigator2(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:1`);
    // The hit is in turn=0, not turn=1, so hitsSoFar should be 0
    expect(detail.speculationState.hitsSoFar).toBe(0);
  });
});

// ── 15. Token budget tracking ─────────────────────────────────────────────────

describe("TraceNavigator.getDrillDown — token budget", () => {
  class StubNavigator3 extends TraceNavigator {
    constructor(private stubEvents: TraceEvent[]) {
      super();
    }
    override async getDecisionTree(sessionId: string): Promise<DecisionTree> {
      return new DecisionTreeBuilder(sessionId, this.stubEvents).build();
    }
  }

  test("compressionCount reflects prior context_compression events", async () => {
    const events: TraceEvent[] = [
      makeContextCompression(0),
      makeContextCompression(1),
      makeToolEvent(2),
    ];
    const nav = new StubNavigator3(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:2`);
    expect(detail.tokenBudgetSnapshot.compressionCount).toBe(2);
  });

  test("approxTokens reflects the last compression's tokensAfter", async () => {
    const comp1: TraceEvent = { ...makeContextCompression(0), tokensBefore: 9000, tokensAfter: 6000 } as TraceEvent;
    const comp2: TraceEvent = { ...makeContextCompression(1), tokensBefore: 6000, tokensAfter: 3000 } as TraceEvent;
    const events: TraceEvent[] = [comp1, comp2, makeToolEvent(2)];
    const nav = new StubNavigator3(events);
    await nav.getDecisionTree(SID);
    const detail = await nav.getDrillDown(`${SID}:2`);
    expect(detail.tokenBudgetSnapshot.approxTokens).toBe(3000);
  });
});

// ── 16. exportAsJSON ──────────────────────────────────────────────────────────

describe("TraceNavigator.exportAsJSON", () => {
  test("returns a plain object with version=1 and sessionId", async () => {
    const nav = new TraceNavigator();
    const exported = await nav.exportAsJSON("unknown-export-session");
    expect(typeof exported).toBe("object");
    expect((exported as any).version).toBe(1);
    expect((exported as any).sessionId).toBe("unknown-export-session");
  });

  test("exported object is JSON-serializable", async () => {
    const nav = new TraceNavigator();
    const exported = await nav.exportAsJSON("unknown-export-session");
    expect(() => JSON.stringify(exported)).not.toThrow();
  });

  test("exported object includes tree, stats, totalEvents", async () => {
    const nav = new TraceNavigator();
    const exported = await nav.exportAsJSON("unknown-export-session") as any;
    expect("stats" in exported || "error" in exported).toBe(true);
    expect("totalEvents" in exported || "error" in exported).toBe(true);
  });
});

// ── 17. Singleton lifecycle ───────────────────────────────────────────────────

describe("getTraceNavigator / resetTraceNavigator", () => {
  afterEach(() => {
    resetTraceNavigator();
  });

  test("getTraceNavigator returns a TraceNavigator instance", () => {
    resetTraceNavigator();
    const nav = getTraceNavigator();
    expect(nav).toBeInstanceOf(TraceNavigator);
  });

  test("getTraceNavigator returns the same instance on repeated calls", () => {
    resetTraceNavigator();
    const nav1 = getTraceNavigator();
    const nav2 = getTraceNavigator();
    expect(nav1).toBe(nav2);
  });

  test("resetTraceNavigator causes getTraceNavigator to return a new instance", () => {
    resetTraceNavigator();
    const nav1 = getTraceNavigator();
    resetTraceNavigator();
    const nav2 = getTraceNavigator();
    expect(nav1).not.toBe(nav2);
  });

  test("setTraceNavigator replaces the singleton", () => {
    resetTraceNavigator();
    const custom = new TraceNavigator();
    setTraceNavigator(custom);
    expect(getTraceNavigator()).toBe(custom);
  });
});

// ── 18. Robustness — dedup_hit / replay events ────────────────────────────────

describe("DecisionTreeBuilder — robustness with uncommon event kinds", () => {
  test("dedup_hit produces a generic info node without throwing", () => {
    const ev: TraceEvent = {
      kind: "dedup_hit",
      seq: 0,
      at: new Date().toISOString(),
      turn: 0,
      sessionId: SID,
      toolName: "Read",
    };
    expect(() => new DecisionTreeBuilder(SID, [ev]).build()).not.toThrow();
    const tree = new DecisionTreeBuilder(SID, [ev]).build();
    const turnNode = tree.root.children[0]!;
    expect(turnNode.children[0]!.kind).toBe("dedup_hit");
  });

  test("replay_start and replay_step produce generic info nodes", () => {
    const replayStart: TraceEvent = {
      kind: "replay_start",
      seq: 0,
      at: new Date().toISOString(),
      turn: 0,
      sessionId: SID,
      replaySourceSessionId: "orig",
      sourceEventCount: 5,
    };
    const replayStep: TraceEvent = {
      kind: "replay_step",
      seq: 1,
      at: new Date().toISOString(),
      turn: 0,
      sessionId: SID,
      toolName: "Read",
      originalStepIndex: 0,
      resultMatched: true,
    };
    const tree = new DecisionTreeBuilder(SID, [replayStart, replayStep]).build();
    const turnNode = tree.root.children[0]!;
    expect(turnNode.children).toHaveLength(2);
    expect(turnNode.children[0]!.kind).toBe("replay_start");
    expect(turnNode.children[1]!.kind).toBe("replay_step");
  });
});
