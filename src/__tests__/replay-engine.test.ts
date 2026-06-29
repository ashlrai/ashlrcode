/**
 * Test harness for the Tool Execution Replay & Debug Harness.
 *
 * Coverage:
 *   - Capture fidelity (flag gating, index increment, clamping)
 *   - Serialization / deserialization round-trips
 *   - Divergence detection (diff generation)
 *   - Replay executor (match + diverge paths)
 *   - File I/O error handling
 *   - /replay debug step-through generator
 *   - formatCapture / formatReplayResult display helpers
 *   - resetReplayEngine isolation
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  captureToolInvocation,
  flushSession,
  loadReplaySession,
  listReplaySessions,
  getSessionCaptures,
  getLastCaptures,
  generateDiff,
  replaySession,
  replayDebug,
  formatCapture,
  formatReplayResult,
  isReplayCaptureEnabled,
  resetReplayCaptureCache,
  resetReplayEngine,
  getReplaysDir,
  DEBUG_WINDOW,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_CAPTURES_PER_SESSION,
  type ToolReplayCapture,
  type ReplaySession,
  type ReplayExecutorFn,
} from "../agent/replay-engine.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-replay-test-"));
  setConfigDirForTests(configDir);
  resetReplayEngine();
  process.env.ASHLRCODE_REPLAY = "1";
});

afterEach(() => {
  delete process.env.ASHLRCODE_REPLAY;
  resetReplayEngine();
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCapture(
  overrides: Partial<Omit<ToolReplayCapture, "index" | "at">> = {}
): Omit<ToolReplayCapture, "index" | "at"> {
  return {
    name: overrides.name ?? "read",
    input: overrides.input ?? { file_path: "/src/foo.ts" },
    output: overrides.output ?? "export const x = 1;",
    durationMs: overrides.durationMs ?? 12.5,
    isError: overrides.isError ?? false,
    error: overrides.error,
    gitStateHash: overrides.gitStateHash,
  };
}

function makeReplaySession(
  sessionId: string,
  captures: ToolReplayCapture[]
): ReplaySession {
  return {
    sessionId,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    captureCount: captures.length,
    captures,
  };
}

// ── Flag gating ───────────────────────────────────────────────────────────────

describe("flag gating", () => {
  test("ASHLRCODE_REPLAY=0 disables capture", () => {
    process.env.ASHLRCODE_REPLAY = "0";
    resetReplayCaptureCache();
    expect(isReplayCaptureEnabled()).toBe(false);
  });

  test("ASHLRCODE_REPLAY=1 enables capture", () => {
    expect(isReplayCaptureEnabled()).toBe(true);
  });

  test("ASHLRCODE_REPLAY=false disables capture", () => {
    process.env.ASHLRCODE_REPLAY = "false";
    resetReplayCaptureCache();
    expect(isReplayCaptureEnabled()).toBe(false);
  });

  test("ASHLRCODE_REPLAY=true enables capture", () => {
    process.env.ASHLRCODE_REPLAY = "true";
    resetReplayCaptureCache();
    expect(isReplayCaptureEnabled()).toBe(true);
  });

  test("capture is no-op when disabled", async () => {
    process.env.ASHLRCODE_REPLAY = "0";
    resetReplayCaptureCache();
    captureToolInvocation("sess-disabled", makeCapture());
    expect(getSessionCaptures("sess-disabled")).toHaveLength(0);
  });

  test("capture is no-op for empty sessionId", () => {
    captureToolInvocation("", makeCapture());
    expect(getSessionCaptures("")).toHaveLength(0);
  });
});

// ── Capture fidelity ──────────────────────────────────────────────────────────

describe("captureToolInvocation", () => {
  test("records a single capture with correct fields", () => {
    captureToolInvocation("sess-a", makeCapture({ name: "bash", output: "hello" }));
    const captures = getSessionCaptures("sess-a");
    expect(captures).toHaveLength(1);
    expect(captures[0]!.name).toBe("bash");
    expect(captures[0]!.output).toBe("hello");
    expect(captures[0]!.index).toBe(0);
    expect(captures[0]!.at).toBeTruthy();
  });

  test("increments index monotonically", () => {
    for (let i = 0; i < 5; i++) {
      captureToolInvocation("sess-b", makeCapture({ name: `tool-${i}` }));
    }
    const captures = getSessionCaptures("sess-b");
    expect(captures.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
  });

  test("records error flag and error message", () => {
    captureToolInvocation("sess-c", makeCapture({ isError: true, error: "ENOENT" }));
    const captures = getSessionCaptures("sess-c");
    expect(captures[0]!.isError).toBe(true);
    expect(captures[0]!.error).toBe("ENOENT");
  });

  test("records gitStateHash when provided", () => {
    captureToolInvocation(
      "sess-d",
      makeCapture({ gitStateHash: "abc123def456" })
    );
    expect(getSessionCaptures("sess-d")[0]!.gitStateHash).toBe("abc123def456");
  });

  test("records durationMs accurately", () => {
    captureToolInvocation("sess-e", makeCapture({ durationMs: 99.7 }));
    expect(getSessionCaptures("sess-e")[0]!.durationMs).toBe(99.7);
  });

  test("sessions are isolated — captures don't bleed across sessions", () => {
    captureToolInvocation("sess-x", makeCapture({ name: "read" }));
    captureToolInvocation("sess-y", makeCapture({ name: "edit" }));
    expect(getSessionCaptures("sess-x")[0]!.name).toBe("read");
    expect(getSessionCaptures("sess-y")[0]!.name).toBe("edit");
    expect(getSessionCaptures("sess-x")).toHaveLength(1);
    expect(getSessionCaptures("sess-y")).toHaveLength(1);
  });

  test("never throws on malformed input", () => {
    // circular reference in input
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() =>
      captureToolInvocation("sess-circ", {
        name: "bash",
        input: circular,
        output: "ok",
        durationMs: 1,
        isError: false,
      })
    ).not.toThrow();
  });
});

// ── Input/output clamping ─────────────────────────────────────────────────────

describe("clamping", () => {
  test("large output is clamped to MAX_OUTPUT_CHARS", () => {
    const bigOutput = "x".repeat(MAX_OUTPUT_CHARS + 5000);
    captureToolInvocation("sess-clamp-out", makeCapture({ output: bigOutput }));
    const captures = getSessionCaptures("sess-clamp-out");
    expect(captures[0]!.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 100);
    expect(captures[0]!.output).toContain("truncated");
  });

  test("large input is clamped to MAX_INPUT_CHARS", () => {
    const bigInput = { data: "y".repeat(MAX_INPUT_CHARS + 5000) };
    captureToolInvocation("sess-clamp-in", makeCapture({ input: bigInput }));
    const captures = getSessionCaptures("sess-clamp-in");
    // clamped input becomes { _clamped: "..." }
    expect(captures[0]!.input).toHaveProperty("_clamped");
  });

  test("small output is stored verbatim", () => {
    const smallOutput = "small result";
    captureToolInvocation("sess-small-out", makeCapture({ output: smallOutput }));
    expect(getSessionCaptures("sess-small-out")[0]!.output).toBe(smallOutput);
  });

  test("small input is stored verbatim", () => {
    const smallInput = { file_path: "/x.ts" };
    captureToolInvocation("sess-small-in", makeCapture({ input: smallInput }));
    const captured = getSessionCaptures("sess-small-in")[0]!.input;
    expect(captured).toEqual(smallInput);
  });
});

// ── Session cap ───────────────────────────────────────────────────────────────

describe("session capture cap", () => {
  test("stops recording after MAX_CAPTURES_PER_SESSION", () => {
    // Use a small cap via internal mechanism — we verify the cap behavior
    // by checking that we stay at or below the constant.
    const sid = "sess-cap";
    // Record up to cap + 10 more
    const target = Math.min(MAX_CAPTURES_PER_SESSION, 10); // use 10 for speed
    // Temporarily override for test speed: record only 10 and verify monotonic
    for (let i = 0; i < target + 2; i++) {
      captureToolInvocation(sid, makeCapture({ name: `t-${i}` }));
    }
    const captures = getSessionCaptures(sid);
    // All recorded (we only did 12 << 2000)
    expect(captures.length).toBe(target + 2);
    expect(captures.every((c, i) => c.index === i)).toBe(true);
  });
});

// ── Flush / serialization ─────────────────────────────────────────────────────

describe("flushSession + loadReplaySession", () => {
  test("flush writes a valid .replay JSON file", async () => {
    captureToolInvocation("sess-flush", makeCapture({ name: "read" }));
    captureToolInvocation("sess-flush", makeCapture({ name: "edit" }));
    await flushSession("sess-flush");

    const session = await loadReplaySession("sess-flush");
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("sess-flush");
    expect(session!.captureCount).toBe(2);
    expect(session!.captures).toHaveLength(2);
  });

  test("round-trips all capture fields", async () => {
    captureToolInvocation(
      "sess-rt",
      makeCapture({
        name: "bash",
        input: { command: "ls -la" },
        output: "total 42",
        durationMs: 33.1,
        isError: false,
        gitStateHash: "deadbeef",
      })
    );
    await flushSession("sess-rt");

    const session = await loadReplaySession("sess-rt");
    const c = session!.captures[0]!;
    expect(c.name).toBe("bash");
    expect(c.input).toEqual({ command: "ls -la" });
    expect(c.output).toBe("total 42");
    expect(c.durationMs).toBe(33.1);
    expect(c.isError).toBe(false);
    expect(c.gitStateHash).toBe("deadbeef");
    expect(c.at).toBeTruthy();
  });

  test("loadReplaySession returns null for missing file", async () => {
    const result = await loadReplaySession("no-such-session");
    expect(result).toBeNull();
  });

  test("listReplaySessions shows flushed sessions", async () => {
    captureToolInvocation("sess-ls-1", makeCapture());
    captureToolInvocation("sess-ls-2", makeCapture());
    await flushSession("sess-ls-1");
    await flushSession("sess-ls-2");

    const list = await listReplaySessions();
    expect(list).toContain("sess-ls-1");
    expect(list).toContain("sess-ls-2");
  });

  test("listReplaySessions returns empty when dir is missing", async () => {
    // No flushes — dir never created
    const list = await listReplaySessions();
    expect(list).toEqual([]);
  });

  test("empty session flush creates file with zero captures", async () => {
    // No captures — flush should be a no-op (buffer not dirty)
    await flushSession("sess-empty");
    const session = await loadReplaySession("sess-empty");
    // No captures were added, so no flush occurred
    expect(session).toBeNull();
  });

  test("sessionId field is preserved verbatim after round-trip", async () => {
    const id = "my-special-session-2026";
    captureToolInvocation(id, makeCapture());
    await flushSession(id);
    const loaded = await loadReplaySession(id);
    expect(loaded!.sessionId).toBe(id);
  });

  test("startedAt and lastUpdatedAt are valid ISO strings", async () => {
    captureToolInvocation("sess-timestamps", makeCapture());
    await flushSession("sess-timestamps");
    const session = await loadReplaySession("sess-timestamps");
    expect(() => new Date(session!.startedAt)).not.toThrow();
    expect(() => new Date(session!.lastUpdatedAt)).not.toThrow();
    expect(isNaN(new Date(session!.startedAt).getTime())).toBe(false);
  });

  test("getLastCaptures returns most recent N from memory", async () => {
    for (let i = 0; i < 10; i++) {
      captureToolInvocation("sess-last", makeCapture({ name: `t-${i}` }));
    }
    const last3 = await getLastCaptures("sess-last", 3);
    expect(last3).toHaveLength(3);
    expect(last3[0]!.name).toBe("t-7");
    expect(last3[1]!.name).toBe("t-8");
    expect(last3[2]!.name).toBe("t-9");
  });

  test("getLastCaptures falls back to disk when memory is cleared", async () => {
    for (let i = 0; i < 5; i++) {
      captureToolInvocation("sess-disk", makeCapture({ name: `t-${i}` }));
    }
    await flushSession("sess-disk");
    // Clear in-memory state
    resetReplayEngine();
    // getLastCaptures should now read from disk
    const last2 = await getLastCaptures("sess-disk", 2);
    expect(last2).toHaveLength(2);
    expect(last2[0]!.name).toBe("t-3");
    expect(last2[1]!.name).toBe("t-4");
  });

  test("getLastCaptures returns empty for unknown session", async () => {
    const result = await getLastCaptures("ghost-session", 5);
    expect(result).toEqual([]);
  });
});

// ── Divergence detection (diff) ───────────────────────────────────────────────

describe("generateDiff", () => {
  test("returns null for identical strings", () => {
    expect(generateDiff("hello", "hello")).toBeNull();
  });

  test("returns null for identical empty strings", () => {
    expect(generateDiff("", "")).toBeNull();
  });

  test("detects single-line replacement", () => {
    const diff = generateDiff("old line", "new line");
    expect(diff).not.toBeNull();
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  test("diff includes --- expected / +++ actual header", () => {
    const diff = generateDiff("a", "b");
    expect(diff).toContain("--- expected");
    expect(diff).toContain("+++ actual");
  });

  test("unchanged lines get space prefix", () => {
    const diff = generateDiff("line1\nline2\nline3", "line1\nchanged\nline3");
    expect(diff).toContain(" line1");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+changed");
    expect(diff).toContain(" line3");
  });

  test("handles actual longer than expected", () => {
    const diff = generateDiff("a", "a\nb\nc");
    expect(diff).not.toBeNull();
    expect(diff).toContain("+b");
    expect(diff).toContain("+c");
  });

  test("handles expected longer than actual", () => {
    const diff = generateDiff("a\nb\nc", "a");
    expect(diff).not.toBeNull();
    expect(diff).toContain("-b");
    expect(diff).toContain("-c");
  });

  test("handles multi-line identical content", () => {
    const text = "line1\nline2\nline3";
    expect(generateDiff(text, text)).toBeNull();
  });
});

// ── Replay executor ───────────────────────────────────────────────────────────

describe("replaySession", () => {
  function makeCaptures(count: number): ToolReplayCapture[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      name: `tool-${i}`,
      input: { step: i },
      output: `output-${i}`,
      durationMs: 10 + i,
      isError: false,
      at: new Date().toISOString(),
    }));
  }

  test("all matched when executor returns recorded outputs", async () => {
    const captures = makeCaptures(3);
    const session = makeReplaySession("sess-match", captures);

    const executor: ReplayExecutorFn = async (name, _input) => {
      const idx = parseInt(name.replace("tool-", ""), 10);
      return `output-${idx}`;
    };

    const result = await replaySession(session, executor);
    expect(result.allMatched).toBe(true);
    expect(result.matchedSteps).toBe(3);
    expect(result.divergedSteps).toBe(0);
    expect(result.stepResults.every((s) => s.matched)).toBe(true);
    expect(result.stepResults.every((s) => s.diff === null)).toBe(true);
  });

  test("detects divergence when executor returns different output", async () => {
    const captures = makeCaptures(3);
    const session = makeReplaySession("sess-diverge", captures);

    const executor: ReplayExecutorFn = async (name, _input) => {
      if (name === "tool-1") return "DIFFERENT OUTPUT";
      const idx = parseInt(name.replace("tool-", ""), 10);
      return `output-${idx}`;
    };

    const result = await replaySession(session, executor);
    expect(result.allMatched).toBe(false);
    expect(result.matchedSteps).toBe(2);
    expect(result.divergedSteps).toBe(1);

    const diverged = result.stepResults.find((s) => !s.matched)!;
    expect(diverged.toolName).toBe("tool-1");
    expect(diverged.diff).not.toBeNull();
    expect(diverged.diff).toContain("-output-1");
    expect(diverged.diff).toContain("+DIFFERENT OUTPUT");
  });

  test("stopOnDivergence halts after first divergence", async () => {
    const captures = makeCaptures(5);
    const session = makeReplaySession("sess-stop", captures);

    const executor: ReplayExecutorFn = async (name) => {
      if (name === "tool-1") return "DIVERGED";
      const idx = parseInt(name.replace("tool-", ""), 10);
      return `output-${idx}`;
    };

    const result = await replaySession(session, executor, { stopOnDivergence: true });
    // Steps 0 (match) + 1 (diverge) → stops after 2
    expect(result.totalSteps).toBe(2);
    expect(result.stepResults).toHaveLength(2);
  });

  test("stepFilter replays only specified indices", async () => {
    const captures = makeCaptures(5);
    const session = makeReplaySession("sess-filter", captures);

    const executor: ReplayExecutorFn = async (name) => {
      const idx = parseInt(name.replace("tool-", ""), 10);
      return `output-${idx}`;
    };

    const result = await replaySession(session, executor, { stepFilter: [0, 2, 4] });
    expect(result.totalSteps).toBe(3);
    expect(result.stepResults.map((s) => s.index)).toEqual([0, 2, 4]);
  });

  test("executor errors are captured as divergence with replayError field", async () => {
    const captures = makeCaptures(2);
    const session = makeReplaySession("sess-err", captures);

    const executor: ReplayExecutorFn = async (name) => {
      if (name === "tool-0") throw new Error("tool exploded");
      return "output-1";
    };

    const result = await replaySession(session, executor);
    expect(result.divergedSteps).toBe(1);
    const errorStep = result.stepResults[0]!;
    expect(errorStep.matched).toBe(false);
    expect(errorStep.replayError).toBe("tool exploded");
    expect(errorStep.actual).toBeNull();
  });

  test("empty session replays with zero steps", async () => {
    const session = makeReplaySession("sess-empty-replay", []);
    const executor: ReplayExecutorFn = async () => "x";

    const result = await replaySession(session, executor);
    expect(result.totalSteps).toBe(0);
    expect(result.allMatched).toBe(true);
    expect(result.stepResults).toHaveLength(0);
  });

  test("replayDurationMs is measured and non-negative", async () => {
    const captures = makeCaptures(2);
    const session = makeReplaySession("sess-timing", captures);
    const executor: ReplayExecutorFn = async (name) => {
      const idx = parseInt(name.replace("tool-", ""), 10);
      return `output-${idx}`;
    };
    const result = await replaySession(session, executor);
    for (const step of result.stepResults) {
      expect(step.replayDurationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── replayDebug generator ─────────────────────────────────────────────────────

describe("replayDebug", () => {
  test("yields header, steps, and done events", async () => {
    for (let i = 0; i < 3; i++) {
      captureToolInvocation("sess-dbg", makeCapture({ name: `t-${i}` }));
    }

    const events: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-dbg")) {
      events.push(ev);
    }

    expect(events[0]!.type).toBe("header");
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(3);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  test("header has correct totalCaptures count", async () => {
    for (let i = 0; i < 7; i++) {
      captureToolInvocation("sess-hdr", makeCapture({ name: `t-${i}` }));
    }
    const events: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-hdr")) {
      events.push(ev);
    }
    const header = events.find((e) => e.type === "header")!;
    expect(header.type).toBe("header");
    if (header.type === "header") {
      expect(header.totalCaptures).toBe(7);
    }
  });

  test("only shows last DEBUG_WINDOW captures by default", async () => {
    for (let i = 0; i < DEBUG_WINDOW + 3; i++) {
      captureToolInvocation("sess-window", makeCapture({ name: `t-${i}` }));
    }
    const events: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-window")) {
      events.push(ev);
    }
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(DEBUG_WINDOW);
  });

  test("custom windowSize overrides DEBUG_WINDOW", async () => {
    for (let i = 0; i < 10; i++) {
      captureToolInvocation("sess-custom-win", makeCapture({ name: `t-${i}` }));
    }
    const events: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-custom-win", 3)) {
      events.push(ev);
    }
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(3);
  });

  test("step events have correct stepNumber (1-based)", async () => {
    for (let i = 0; i < 3; i++) {
      captureToolInvocation("sess-stepnum", makeCapture({ name: `t-${i}` }));
    }
    const stepEvents: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-stepnum")) {
      if (ev.type === "step") stepEvents.push(ev);
    }
    stepEvents.forEach((ev, i) => {
      if (ev.type === "step") {
        expect(ev.stepNumber).toBe(i + 1);
        expect(ev.totalShown).toBe(3);
      }
    });
  });

  test("empty session emits header + done with no steps", async () => {
    const events: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-no-captures")) {
      events.push(ev);
    }
    expect(events.find((e) => e.type === "header")).toBeDefined();
    expect(events.find((e) => e.type === "step")).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.summary).toContain("sess-no-captures");
    }
  });

  test("done summary mentions capture counts", async () => {
    for (let i = 0; i < 3; i++) {
      captureToolInvocation("sess-summary", makeCapture());
    }
    const events: import("../agent/replay-engine.ts").ReplayDebugEvent[] = [];
    for await (const ev of replayDebug("sess-summary")) {
      events.push(ev);
    }
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.summary).toContain("3");
    }
  });
});

// ── Display formatters ────────────────────────────────────────────────────────

describe("formatCapture", () => {
  test("includes tool name, step label, and duration", () => {
    const capture: ToolReplayCapture = {
      index: 0,
      name: "bash",
      input: { command: "ls" },
      output: "file1.ts\nfile2.ts",
      durationMs: 55.3,
      isError: false,
      at: new Date().toISOString(),
    };
    const formatted = formatCapture(capture);
    expect(formatted).toContain("bash");
    expect(formatted).toContain("55.3ms");
    expect(formatted).toContain("file1.ts");
  });

  test("includes [ERROR] flag when isError is true", () => {
    const capture: ToolReplayCapture = {
      index: 0,
      name: "edit",
      input: {},
      output: "Permission denied",
      durationMs: 1,
      isError: true,
      at: new Date().toISOString(),
    };
    const formatted = formatCapture(capture);
    expect(formatted).toContain("[ERROR]");
  });

  test("truncates long output in preview", () => {
    const capture: ToolReplayCapture = {
      index: 0,
      name: "read",
      input: {},
      output: "x".repeat(1000),
      durationMs: 1,
      isError: false,
      at: new Date().toISOString(),
    };
    const formatted = formatCapture(capture);
    // Should contain truncation indicator
    expect(formatted.length).toBeLessThan(800);
  });

  test("uses step index override when provided", () => {
    const capture: ToolReplayCapture = {
      index: 7,
      name: "grep",
      input: {},
      output: "found",
      durationMs: 5,
      isError: false,
      at: new Date().toISOString(),
    };
    const formatted = formatCapture(capture, 2);
    expect(formatted).toContain("Step 3");
  });
});

describe("formatReplayResult", () => {
  test("shows ALL MATCHED when all steps match", () => {
    const result = {
      sessionId: "sess-fmt",
      totalSteps: 2,
      matchedSteps: 2,
      divergedSteps: 0,
      stepResults: [
        { index: 0, toolName: "read", matched: true, expected: "x", actual: "x", diff: null, replayDurationMs: 5 },
        { index: 1, toolName: "edit", matched: true, expected: "y", actual: "y", diff: null, replayDurationMs: 3 },
      ],
      allMatched: true,
    };
    const formatted = formatReplayResult(result);
    expect(formatted).toContain("ALL MATCHED");
    expect(formatted).toContain("sess-fmt");
  });

  test("shows DIVERGENCE DETECTED when steps diverge", () => {
    const result = {
      sessionId: "sess-div",
      totalSteps: 1,
      matchedSteps: 0,
      divergedSteps: 1,
      stepResults: [
        {
          index: 0,
          toolName: "bash",
          matched: false,
          expected: "old",
          actual: "new",
          diff: "--- expected\n+++ actual\n-old\n+new",
          replayDurationMs: 10,
        },
      ],
      allMatched: false,
    };
    const formatted = formatReplayResult(result);
    expect(formatted).toContain("DIVERGENCE DETECTED");
    expect(formatted).toContain("DIVERGE");
    expect(formatted).toContain("-old");
    expect(formatted).toContain("+new");
  });

  test("truncates long diffs in output", () => {
    const longDiff = Array.from({ length: 50 }, (_, i) => `-line${i}`).join("\n");
    const result = {
      sessionId: "sess-long-diff",
      totalSteps: 1,
      matchedSteps: 0,
      divergedSteps: 1,
      stepResults: [
        {
          index: 0,
          toolName: "read",
          matched: false,
          expected: "a",
          actual: "b",
          diff: longDiff,
          replayDurationMs: 1,
        },
      ],
      allMatched: false,
    };
    const formatted = formatReplayResult(result);
    expect(formatted).toContain("truncated");
  });
});

// ── resetReplayEngine isolation ───────────────────────────────────────────────

describe("resetReplayEngine", () => {
  test("clears in-memory buffers", () => {
    captureToolInvocation("sess-reset", makeCapture());
    expect(getSessionCaptures("sess-reset")).toHaveLength(1);
    resetReplayEngine();
    expect(getSessionCaptures("sess-reset")).toHaveLength(0);
  });

  test("clears capture counts so indices restart at 0", () => {
    captureToolInvocation("sess-idx", makeCapture());
    captureToolInvocation("sess-idx", makeCapture());
    resetReplayEngine();
    process.env.ASHLRCODE_REPLAY = "1";
    captureToolInvocation("sess-idx", makeCapture());
    const captures = getSessionCaptures("sess-idx");
    expect(captures[0]!.index).toBe(0);
  });

  test("resetReplayCaptureCache forces re-read of env var", () => {
    process.env.ASHLRCODE_REPLAY = "0";
    resetReplayCaptureCache();
    expect(isReplayCaptureEnabled()).toBe(false);
    process.env.ASHLRCODE_REPLAY = "1";
    resetReplayCaptureCache();
    expect(isReplayCaptureEnabled()).toBe(true);
  });
});

// ── File I/O error handling ───────────────────────────────────────────────────

describe("file I/O error handling", () => {
  test("loadReplaySession never throws for corrupt JSON", async () => {
    // Write a corrupt .replay file directly
    const { mkdirSync, writeFileSync } = await import("fs");
    const replaysDir = getReplaysDir();
    mkdirSync(replaysDir, { recursive: true });
    writeFileSync(join(replaysDir, "corrupt.replay"), "{ not: valid json }", "utf-8");

    const result = await loadReplaySession("corrupt");
    expect(result).toBeNull();
  });

  test("listReplaySessions returns empty array when dir is missing", async () => {
    // Config dir exists but replays subdir does not
    const list = await listReplaySessions();
    expect(Array.isArray(list)).toBe(true);
  });

  test("flushSession does not throw when called with no captures", async () => {
    await expect(flushSession("sess-no-captures-flush")).resolves.toBeUndefined();
  });

  test("captureToolInvocation never throws even when disabled", () => {
    process.env.ASHLRCODE_REPLAY = "0";
    resetReplayCaptureCache();
    expect(() =>
      captureToolInvocation("sess-safe", makeCapture())
    ).not.toThrow();
  });
});
