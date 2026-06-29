import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  recordStep,
  loadTimeline,
  listTimelines,
  forkFrom,
  isTimeTravelEnabled,
  resetTimeTravelCache,
} from "../agent/time-travel.ts";
import {
  recordGoalNormalization,
  recordToolSelection,
  recordSpeculationHit,
  recordSpeculationMiss,
  recordContextCompression,
  recordTurnBoundary,
  loadTrace,
  listTraces,
  buildDecisionTree,
  renderDecisionTree,
  replayTrace,
  isIntentTraceEnabled,
  resetIntentTraceCache,
  resetTurnCounter,
  approxTokens,
  TARGET_BYTES_PER_EVENT,
} from "../agent/intent-trace.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-tt-test-"));
  setConfigDirForTests(configDir);
  resetTimeTravelCache();
  resetIntentTraceCache();
  // Force-enable via env so we don't depend on a settings.json file.
  process.env.ASHLRCODE_TIME_TRAVEL = "1";
  process.env.ASHLRCODE_INTENT_TRACE = "1";
});

afterEach(() => {
  delete process.env.ASHLRCODE_TIME_TRAVEL;
  delete process.env.ASHLRCODE_INTENT_TRACE;
  resetTimeTravelCache();
  resetIntentTraceCache();
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

function step(index: number, over: Partial<{ toolName: string; result: string }> = {}) {
  return {
    index,
    toolName: over.toolName ?? "read",
    args: { file_path: `/x/${index}.ts` },
    result: over.result ?? `result-${index}`,
    // Skip git capture for determinism — pass a fake treeSha.
    treeSha: `sha-${index}`,
  };
}

describe("flag gating", () => {
  test("env=0 disables recording", async () => {
    process.env.ASHLRCODE_TIME_TRAVEL = "0";
    resetTimeTravelCache();
    expect(isTimeTravelEnabled()).toBe(false);
    await recordStep("s-disabled", step(0));
    expect(await loadTimeline("s-disabled")).toEqual([]);
  });

  test("env=1 enables recording", () => {
    expect(isTimeTravelEnabled()).toBe(true);
  });
});

describe("recordStep + loadTimeline", () => {
  test("appends steps in order", async () => {
    await recordStep("sess-a", step(0));
    await recordStep("sess-a", step(1, { toolName: "edit" }));
    await recordStep("sess-a", step(2));

    const tl = await loadTimeline("sess-a");
    expect(tl.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(tl[1]!.toolName).toBe("edit");
    expect(tl[0]!.tree.sha).toBe("sha-0");
    expect(tl[0]!.at).toBeTruthy();
  });

  test("clamps oversized results", async () => {
    await recordStep("sess-big", step(0, { result: "x".repeat(20_000) }));
    const tl = await loadTimeline("sess-big");
    expect(tl[0]!.result.length).toBeLessThan(20_000);
    expect(tl[0]!.result).toContain("chars]");
  });

  test("never throws on empty sessionId", async () => {
    await expect(recordStep("", step(0))).resolves.toBeUndefined();
  });

  test("missing timeline loads as empty", async () => {
    expect(await loadTimeline("nope")).toEqual([]);
  });

  test("listTimelines reports recorded sessions", async () => {
    await recordStep("sess-1", step(0));
    await recordStep("sess-2", step(0));
    const list = await listTimelines();
    expect(list.sort()).toEqual(["sess-1", "sess-2"]);
  });
});

describe("forkFrom", () => {
  test("seeds a new session from a prefix of the parent", async () => {
    for (let i = 0; i < 5; i++) await recordStep("parent", step(i));

    const fork = await forkFrom("parent", 2);
    expect(fork).not.toBeNull();
    expect(fork!.fromIndex).toBe(2);
    expect(fork!.steps).toBe(3);
    expect(fork!.tree.sha).toBe("sha-2");

    const forked = await loadTimeline(fork!.sessionId);
    expect(forked.map((s) => s.index)).toEqual([0, 1, 2]);

    // Parent is untouched — branchable.
    expect((await loadTimeline("parent")).length).toBe(5);
  });

  test("forking the same point twice yields independent branches", async () => {
    for (let i = 0; i < 3; i++) await recordStep("p", step(i));
    const a = await forkFrom("p", 1);
    const b = await forkFrom("p", 1);
    expect(a!.sessionId).not.toBe(b!.sessionId);
    expect((await loadTimeline(a!.sessionId)).length).toBe(2);
    expect((await loadTimeline(b!.sessionId)).length).toBe(2);
  });

  test("returns null for missing source or out-of-range index", async () => {
    expect(await forkFrom("ghost", 0)).toBeNull();
    await recordStep("only0", step(0));
    expect(await forkFrom("only0", -1)).toBeNull();
  });
});

// ── Intent Trace tests ────────────────────────────────────────────────────────

describe("intent-trace flag gating", () => {
  test("env=0 disables intent trace recording", async () => {
    process.env.ASHLRCODE_INTENT_TRACE = "0";
    resetIntentTraceCache();
    expect(isIntentTraceEnabled()).toBe(false);
    await recordGoalNormalization("it-disabled", 0, "hello", "hello");
    expect(await loadTrace("it-disabled")).toEqual([]);
  });

  test("env=1 enables intent trace recording", () => {
    expect(isIntentTraceEnabled()).toBe(true);
  });
});

describe("intent-trace event recording", () => {
  test("records goal normalization event", async () => {
    await recordGoalNormalization("it-sess1", 0, "Fix the bug", "fix bug in auth");
    const events = await loadTrace("it-sess1");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("goal_normalization");
    if (ev.kind === "goal_normalization") {
      expect(ev.rawInput).toBe("Fix the bug");
      expect(ev.normalizedGoal).toBe("fix bug in auth");
      expect(ev.approxTokens).toBeGreaterThan(0);
    }
    expect(ev.turn).toBe(0);
    expect(ev.sessionId).toBe("it-sess1");
    expect(ev.at).toBeTruthy();
  });

  test("records tool selection event", async () => {
    await recordToolSelection("it-sess2", 0, "bash", { command: "ls" }, "listing files", 3);
    const events = await loadTrace("it-sess2");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("tool_selection");
    if (ev.kind === "tool_selection") {
      expect(ev.toolName).toBe("bash");
      expect(ev.stepIndex).toBe(3);
      expect(ev.reasoningContext).toBe("listing files");
    }
  });

  test("records speculation hit (memory)", async () => {
    await recordSpeculationHit("it-sess3", 1, "read", "memory", 12);
    const events = await loadTrace("it-sess3");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("speculation_hit");
    if (ev.kind === "speculation_hit") {
      expect(ev.cacheType).toBe("memory");
      expect(ev.savedMs).toBe(12);
    }
  });

  test("records speculation hit (persistent)", async () => {
    await recordSpeculationHit("it-sess3b", 0, "glob", "persistent");
    const events = await loadTrace("it-sess3b");
    const ev = events[0]!;
    expect(ev.kind).toBe("speculation_hit");
    if (ev.kind === "speculation_hit") {
      expect(ev.cacheType).toBe("persistent");
    }
  });

  test("records speculation miss", async () => {
    await recordSpeculationMiss("it-sess4", 0, "bash", 150);
    const events = await loadTrace("it-sess4");
    const ev = events[0]!;
    expect(ev.kind).toBe("speculation_miss");
    if (ev.kind === "speculation_miss") {
      expect(ev.executionMs).toBe(150);
    }
  });

  test("records context compression", async () => {
    await recordContextCompression("it-sess5", 2, 8000, 3000, 5);
    const events = await loadTrace("it-sess5");
    const ev = events[0]!;
    expect(ev.kind).toBe("context_compression");
    if (ev.kind === "context_compression") {
      expect(ev.tokensBefore).toBe(8000);
      expect(ev.tokensAfter).toBe(3000);
      expect(ev.blocksDropped).toBe(5);
    }
  });

  test("records turn boundary start and end", async () => {
    await recordTurnBoundary("it-sess6", 0, "start");
    await recordTurnBoundary("it-sess6", 0, "end", 3, "done");
    const events = await loadTrace("it-sess6");
    expect(events).toHaveLength(2);
    const [start, end] = events;
    expect(start!.kind).toBe("turn_boundary");
    expect(end!.kind).toBe("turn_boundary");
    if (start!.kind === "turn_boundary") expect(start.phase).toBe("start");
    if (end!.kind === "turn_boundary") {
      expect(end.phase).toBe("end");
      expect(end.toolCallCount).toBe(3);
    }
  });

  test("events are ordered by seq", async () => {
    const sid = "it-order";
    await recordGoalNormalization(sid, 0, "a", "a");
    await recordToolSelection(sid, 0, "read", {}, "ctx", 0);
    await recordSpeculationMiss(sid, 0, "read", 50);
    await recordTurnBoundary(sid, 0, "end", 1, "ok");
    const events = await loadTrace(sid);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  test("listTraces reports recorded sessions", async () => {
    await recordGoalNormalization("it-list1", 0, "x", "x");
    await recordGoalNormalization("it-list2", 0, "y", "y");
    const list = await listTraces();
    expect(list).toContain("it-list1");
    expect(list).toContain("it-list2");
  });

  test("missing trace loads as empty array", async () => {
    expect(await loadTrace("no-such-session")).toEqual([]);
  });

  test("never throws on empty sessionId", async () => {
    await expect(recordGoalNormalization("", 0, "x", "x")).resolves.toBeUndefined();
    await expect(recordToolSelection("", 0, "t", {}, "", 0)).resolves.toBeUndefined();
  });
});

describe("intent-trace JSONL size budget", () => {
  test("each event serializes to less than TARGET_BYTES_PER_EVENT bytes", async () => {
    const sid = "it-size";
    // Record a full 5-turn session (5 turns × multiple events)
    for (let t = 0; t < 5; t++) {
      await recordGoalNormalization(sid, t, `Turn ${t} user request`, `normalized goal ${t}`);
      await recordTurnBoundary(sid, t, "start");
      await recordToolSelection(sid, t, "bash", { command: `echo ${t}` }, `reasoning for turn ${t}`, t);
      await recordSpeculationMiss(sid, t, "bash", 100 + t);
      await recordTurnBoundary(sid, t, "end", 1, `result ${t}`);
    }

    const events = await loadTrace(sid);
    expect(events.length).toBe(25); // 5 events × 5 turns

    for (const ev of events) {
      const serialized = JSON.stringify(ev);
      expect(serialized.length).toBeLessThan(TARGET_BYTES_PER_EVENT);
    }
  });

  test("JSONL grows less than 5 KB per turn for typical events", async () => {
    const { statSync } = await import("fs");
    const { join: pathJoin } = await import("path");
    const sid = "it-budget";

    for (let t = 0; t < 5; t++) {
      await recordGoalNormalization(sid, t, `request ${t}`, `goal ${t}`);
      await recordTurnBoundary(sid, t, "start");
      await recordToolSelection(sid, t, "read", { file_path: `/src/file${t}.ts` }, `context ${t}`, t);
      await recordSpeculationMiss(sid, t, "read", 80);
      await recordTurnBoundary(sid, t, "end", 1, `text ${t}`);
    }

    const tracePath = pathJoin(configDir, "traces", `${sid}.jsonl`);
    const { size } = statSync(tracePath);
    // 5 turns × 5 events, budget = 5 KB per turn = 25 KB total
    expect(size).toBeLessThan(25 * 1024);
  });
});

describe("intent-trace decision tree", () => {
  test("buildDecisionTree groups events by turn", async () => {
    const sid = "it-tree";
    await recordGoalNormalization(sid, 0, "fix bug", "fix bug");
    await recordToolSelection(sid, 0, "read", { file_path: "/a.ts" }, "need to read", 0);
    await recordSpeculationHit(sid, 0, "read", "memory", 5);
    await recordTurnBoundary(sid, 0, "end", 1, "done");
    await recordGoalNormalization(sid, 1, "verify", "verify fix");
    await recordToolSelection(sid, 1, "bash", { command: "bun test" }, "run tests", 1);
    await recordTurnBoundary(sid, 1, "end", 1, "ok");

    const events = await loadTrace(sid);
    const tree = buildDecisionTree(events);

    expect(tree.label).toContain("Session");
    expect(tree.children).toHaveLength(2); // turn 0 and turn 1

    const turn0 = tree.children[0]!;
    expect(turn0.label).toBe("Turn 0");
    // Should have: goal, tool_selection, speculation_hit (as child of selection), turn_end
    const goalNode = turn0.children.find((n) => n.kind === "goal_normalization");
    expect(goalNode).toBeDefined();
    expect(goalNode!.label).toContain("fix bug");

    const toolNode = turn0.children.find((n) => n.kind === "tool_selection");
    expect(toolNode).toBeDefined();
    expect(toolNode!.label).toContain("read");
    // speculation_hit is a child of the tool selection node
    const hitNode = toolNode!.children.find((n) => n.kind === "speculation_hit");
    expect(hitNode).toBeDefined();
    expect(hitNode!.label).toContain("memory");
  });

  test("renderDecisionTree produces non-empty string with tree characters", async () => {
    const sid = "it-render";
    await recordGoalNormalization(sid, 0, "task", "task");
    await recordToolSelection(sid, 0, "grep", { pattern: "foo" }, "search", 0);

    const events = await loadTrace(sid);
    const tree = buildDecisionTree(events);
    const rendered = renderDecisionTree(tree);

    expect(rendered).toBeTruthy();
    expect(rendered).toContain("Session");
    expect(rendered).toContain("Turn 0");
    expect(rendered).toContain("task");
    expect(rendered).toContain("grep");
    // Children of root use box-drawing connectors
    expect(rendered).toMatch(/[└├]/);
    expect(rendered.split("\n").length).toBeGreaterThan(2);
  });
});

describe("intent-trace replay", () => {
  test("replay of empty session yields commentary and done", async () => {
    const events: import("../agent/intent-trace.ts").ReplayEvent[] = [];
    for await (const ev of replayTrace("no-such-session-xyz")) {
      events.push(ev);
    }
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const commentary = events.find((e) => e.type === "commentary");
    expect(commentary).toBeDefined();
    expect(commentary!.text).toContain("no-such-session-xyz");
  });

  test("5-turn session replay yields tool_replay events matching original steps", async () => {
    const sid = "it-replay-src";
    resetTurnCounter(sid);

    for (let t = 0; t < 5; t++) {
      await recordGoalNormalization(sid, t, `turn ${t} input`, `goal ${t}`);
      await recordTurnBoundary(sid, t, "start");
      await recordToolSelection(sid, t, t % 2 === 0 ? "read" : "bash", { step: t }, `reason ${t}`, t);
      await recordSpeculationMiss(sid, t, t % 2 === 0 ? "read" : "bash", 50 + t * 10);
      await recordTurnBoundary(sid, t, "end", 1, `final ${t}`);
    }

    const replayEvents: import("../agent/intent-trace.ts").ReplayEvent[] = [];
    for await (const ev of replayTrace(sid)) {
      replayEvents.push(ev);
    }

    // Should have 5 tool_replay events (one per turn)
    const toolReplays = replayEvents.filter((e) => e.type === "tool_replay");
    expect(toolReplays).toHaveLength(5);

    // All replayed tool results should match (deterministic replay)
    for (const tr of toolReplays) {
      expect(tr.resultMatched).toBe(true);
    }

    // Should end with done
    const lastEvent = replayEvents[replayEvents.length - 1]!;
    expect(lastEvent.type).toBe("done");

    // Verify commentary mentions correct session id
    const firstCommentary = replayEvents.find((e) => e.type === "commentary");
    expect(firstCommentary!.text).toContain(sid);
  });

  test("replay output is identical across two runs (deterministic)", async () => {
    const sid = "it-det";
    await recordGoalNormalization(sid, 0, "x", "x");
    await recordToolSelection(sid, 0, "read", { file_path: "/f.ts" }, "r", 0);
    await recordTurnBoundary(sid, 0, "end", 1, "ok");

    async function collectReplay() {
      const out: string[] = [];
      for await (const ev of replayTrace(sid)) {
        if (ev.type === "commentary" && ev.text) out.push(ev.text);
        if (ev.type === "tool_replay") out.push(`${ev.toolName}:${ev.stepIndex}`);
      }
      return out;
    }

    const run1 = await collectReplay();
    const run2 = await collectReplay();
    expect(run1).toEqual(run2);
  });
});

describe("approxTokens helper", () => {
  test("returns positive count for non-empty string", () => {
    expect(approxTokens("hello world")).toBeGreaterThan(0);
  });
  test("returns 0 for empty string", () => {
    expect(approxTokens("")).toBe(0);
  });
  test("longer text yields higher count", () => {
    expect(approxTokens("a".repeat(400))).toBeGreaterThan(approxTokens("a".repeat(40)));
  });
});
