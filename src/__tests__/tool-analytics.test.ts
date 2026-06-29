/**
 * tool-analytics.test.ts — Tests for ToolAnalytics aggregation, rollup, and anomaly detection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ToolAnalytics,
  getToolAnalytics,
  type AnalyticsEvent,
} from "../agent/tool-analytics.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    timestamp: Date.now(),
    sessionId: "test-session",
    goalId: "goal-1",
    toolName: "Bash",
    durationMs: 100,
    outputBytes: 1024,
    isError: false,
    errorType: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("ToolAnalytics — singleton", () => {
  beforeEach(() => ToolAnalytics.resetInstance());
  afterEach(() => ToolAnalytics.resetInstance());

  test("getInstance returns the same instance", () => {
    const a = ToolAnalytics.getInstance();
    const b = ToolAnalytics.getInstance();
    expect(a).toBe(b);
  });

  test("getToolAnalytics() convenience accessor returns singleton", () => {
    const a = getToolAnalytics();
    const b = ToolAnalytics.getInstance();
    expect(a).toBe(b);
  });

  test("resetInstance creates a fresh instance", () => {
    const a = ToolAnalytics.getInstance();
    ToolAnalytics.resetInstance();
    const b = ToolAnalytics.getInstance();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Event ingestion
// ---------------------------------------------------------------------------

describe("ToolAnalytics — recordEvent", () => {
  let analytics: ToolAnalytics;

  beforeEach(() => {
    ToolAnalytics.resetInstance();
    analytics = ToolAnalytics.getInstance();
  });

  afterEach(() => ToolAnalytics.resetInstance());

  test("buffer is empty initially", () => {
    expect(analytics.getBuffer()).toHaveLength(0);
  });

  test("recordEvent appends to buffer", () => {
    analytics.recordEvent(makeEvent());
    expect(analytics.getBuffer()).toHaveLength(1);
  });

  test("recordEvent increments pending count", () => {
    analytics.recordEvent(makeEvent());
    analytics.recordEvent(makeEvent());
    expect(analytics.getPendingCount()).toBe(2);
  });

  test("reset clears buffer and pending", () => {
    analytics.recordEvent(makeEvent());
    analytics.reset();
    expect(analytics.getBuffer()).toHaveLength(0);
    expect(analytics.getPendingCount()).toBe(0);
  });

  test("multiple events accumulate", () => {
    for (let i = 0; i < 10; i++) analytics.recordEvent(makeEvent({ toolName: "Read" }));
    expect(analytics.getBuffer()).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// rollupByTool
// ---------------------------------------------------------------------------

describe("ToolAnalytics — rollupByTool", () => {
  let analytics: ToolAnalytics;

  beforeEach(() => {
    ToolAnalytics.resetInstance();
    analytics = ToolAnalytics.getInstance();
  });

  afterEach(() => ToolAnalytics.resetInstance());

  test("returns empty array when no events", () => {
    expect(analytics.rollupByTool()).toEqual([]);
  });

  test("counts calls per tool", () => {
    analytics.recordEvent(makeEvent({ toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ toolName: "Read" }));
    const rollup = analytics.rollupByTool();
    const bash = rollup.find((r) => r.toolName === "Bash");
    const read = rollup.find((r) => r.toolName === "Read");
    expect(bash?.calls).toBe(2);
    expect(read?.calls).toBe(1);
  });

  test("sorted by call count descending", () => {
    analytics.recordEvent(makeEvent({ toolName: "Read" }));
    analytics.recordEvent(makeEvent({ toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ toolName: "Bash" }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.toolName).toBe("Bash");
  });

  test("computes avgDurationMs correctly", () => {
    analytics.recordEvent(makeEvent({ toolName: "Bash", durationMs: 100 }));
    analytics.recordEvent(makeEvent({ toolName: "Bash", durationMs: 300 }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.avgDurationMs).toBe(200);
  });

  test("computes error count", () => {
    analytics.recordEvent(makeEvent({ toolName: "Bash", isError: false }));
    analytics.recordEvent(makeEvent({ toolName: "Bash", isError: true }));
    analytics.recordEvent(makeEvent({ toolName: "Bash", isError: true }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.errors).toBe(2);
  });

  test("computes successRate = (calls - errors) / calls", () => {
    analytics.recordEvent(makeEvent({ toolName: "Bash", isError: false }));
    analytics.recordEvent(makeEvent({ toolName: "Bash", isError: false }));
    analytics.recordEvent(makeEvent({ toolName: "Bash", isError: true }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.successRate).toBeCloseTo(2 / 3, 5);
  });

  test("successRate is 1 when no errors", () => {
    analytics.recordEvent(makeEvent({ toolName: "Read" }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.successRate).toBe(1);
  });

  test("p50 and p95 are computed from sorted durations", () => {
    // 10 events: 10,20,30,...,100
    for (let i = 1; i <= 10; i++) {
      analytics.recordEvent(makeEvent({ toolName: "T", durationMs: i * 10 }));
    }
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.p50DurationMs).toBe(50);
    expect(rollup[0]!.p95DurationMs).toBe(100);
  });

  test("totalOutputBytes sums all bytes", () => {
    analytics.recordEvent(makeEvent({ toolName: "Write", outputBytes: 500 }));
    analytics.recordEvent(makeEvent({ toolName: "Write", outputBytes: 1500 }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.totalOutputBytes).toBe(2000);
  });

  test("avgOutputBytes is mean of output bytes", () => {
    analytics.recordEvent(makeEvent({ toolName: "Read", outputBytes: 200 }));
    analytics.recordEvent(makeEvent({ toolName: "Read", outputBytes: 600 }));
    const rollup = analytics.rollupByTool();
    expect(rollup[0]!.avgOutputBytes).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// rollupByGoal
// ---------------------------------------------------------------------------

describe("ToolAnalytics — rollupByGoal", () => {
  let analytics: ToolAnalytics;

  beforeEach(() => {
    ToolAnalytics.resetInstance();
    analytics = ToolAnalytics.getInstance();
  });

  afterEach(() => ToolAnalytics.resetInstance());

  test("returns zero-call rollup for unknown goal", () => {
    const r = analytics.rollupByGoal("nonexistent");
    expect(r.totalCalls).toBe(0);
    expect(r.byTool).toHaveLength(0);
  });

  test("filters events by goalId", () => {
    analytics.recordEvent(makeEvent({ goalId: "goal-A", toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ goalId: "goal-B", toolName: "Read" }));
    analytics.recordEvent(makeEvent({ goalId: "goal-A", toolName: "Edit" }));
    const r = analytics.rollupByGoal("goal-A");
    expect(r.totalCalls).toBe(2);
    expect(r.goalId).toBe("goal-A");
  });

  test("counts unique tools", () => {
    analytics.recordEvent(makeEvent({ goalId: "g1", toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ goalId: "g1", toolName: "Bash" }));
    analytics.recordEvent(makeEvent({ goalId: "g1", toolName: "Read" }));
    const r = analytics.rollupByGoal("g1");
    expect(r.uniqueTools).toBe(2);
  });

  test("sums totalDurationMs for goal", () => {
    analytics.recordEvent(makeEvent({ goalId: "g2", durationMs: 200 }));
    analytics.recordEvent(makeEvent({ goalId: "g2", durationMs: 300 }));
    analytics.recordEvent(makeEvent({ goalId: "other", durationMs: 999 }));
    const r = analytics.rollupByGoal("g2");
    expect(r.totalDurationMs).toBe(500);
  });

  test("counts errors within goal", () => {
    analytics.recordEvent(makeEvent({ goalId: "g3", isError: true }));
    analytics.recordEvent(makeEvent({ goalId: "g3", isError: false }));
    analytics.recordEvent(makeEvent({ goalId: "g3", isError: true }));
    const r = analytics.rollupByGoal("g3");
    expect(r.totalErrors).toBe(2);
  });

  test("byTool contains tool-level rollups", () => {
    analytics.recordEvent(makeEvent({ goalId: "g4", toolName: "Bash", durationMs: 50 }));
    analytics.recordEvent(makeEvent({ goalId: "g4", toolName: "Bash", durationMs: 150 }));
    const r = analytics.rollupByGoal("g4");
    expect(r.byTool).toHaveLength(1);
    expect(r.byTool[0]!.avgDurationMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// anomalyDetect
// ---------------------------------------------------------------------------

describe("ToolAnalytics — anomalyDetect", () => {
  let analytics: ToolAnalytics;

  beforeEach(() => {
    ToolAnalytics.resetInstance();
    analytics = ToolAnalytics.getInstance();
  });

  afterEach(() => ToolAnalytics.resetInstance());

  test("returns empty outliers for unknown tool", () => {
    const r = analytics.anomalyDetect("Unknown");
    expect(r.outliers).toHaveLength(0);
    expect(r.meanMs).toBe(0);
    expect(r.stdMs).toBe(0);
  });

  test("returns empty outliers when fewer than 5 samples", () => {
    for (let i = 0; i < 4; i++) analytics.recordEvent(makeEvent({ toolName: "T" }));
    expect(analytics.anomalyDetect("T").outliers).toHaveLength(0);
  });

  test("detects slow outlier with z > 2.5", () => {
    // 9 events at 100ms, 1 at 1000ms → clear outlier
    for (let i = 0; i < 9; i++) {
      analytics.recordEvent(makeEvent({ toolName: "Bash", durationMs: 100 }));
    }
    analytics.recordEvent(makeEvent({ toolName: "Bash", durationMs: 1000 }));
    const r = analytics.anomalyDetect("Bash");
    expect(r.outliers.length).toBeGreaterThan(0);
    expect(r.outliers[0]!.zScore).toBeGreaterThan(2.5);
  });

  test("no outliers when all durations are the same", () => {
    for (let i = 0; i < 10; i++) {
      analytics.recordEvent(makeEvent({ toolName: "Read", durationMs: 50 }));
    }
    const r = analytics.anomalyDetect("Read");
    expect(r.outliers).toHaveLength(0);
    expect(r.stdMs).toBe(0);
  });

  test("outliers are sorted by zScore descending", () => {
    // Use clearly separated outliers: 8x 100ms baseline, then 5000ms and 10000ms
    for (let i = 0; i < 8; i++) {
      analytics.recordEvent(makeEvent({ toolName: "Edit", durationMs: 100 }));
    }
    analytics.recordEvent(makeEvent({ toolName: "Edit", durationMs: 5000 }));
    analytics.recordEvent(makeEvent({ toolName: "Edit", durationMs: 10000 }));
    const r = analytics.anomalyDetect("Edit");
    expect(r.outliers.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < r.outliers.length; i++) {
      expect(r.outliers[i - 1]!.zScore).toBeGreaterThanOrEqual(r.outliers[i]!.zScore);
    }
  });

  test("meanMs and stdMs are populated", () => {
    for (let i = 0; i < 5; i++) {
      analytics.recordEvent(makeEvent({ toolName: "T2", durationMs: 100 }));
    }
    const r = analytics.anomalyDetect("T2");
    expect(r.meanMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

describe("ToolAnalytics — persistence", () => {
  let analytics: ToolAnalytics;
  let tmpDir: string;

  beforeEach(async () => {
    ToolAnalytics.resetInstance();
    analytics = ToolAnalytics.getInstance();
    tmpDir = await mkdtemp(join(tmpdir(), "tool-analytics-test-"));
    analytics.start("test-session-persist", tmpDir);
  });

  afterEach(async () => {
    analytics.stop();
    ToolAnalytics.resetInstance();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("flushNow writes pending events to disk", async () => {
    analytics.recordEvent(makeEvent({ sessionId: "test-session-persist" }));
    analytics.recordEvent(makeEvent({ sessionId: "test-session-persist", toolName: "Read" }));
    await analytics.flushNow();
    const filePath = join(tmpDir, "test-session-persist.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.toolName).toBe("Bash");
  });

  test("pending count is zero after flush", async () => {
    analytics.recordEvent(makeEvent());
    await analytics.flushNow();
    expect(analytics.getPendingCount()).toBe(0);
  });

  test("each event is valid JSON on its own line", async () => {
    analytics.recordEvent(makeEvent({ toolName: "Edit" }));
    await analytics.flushNow();
    const filePath = join(tmpDir, "test-session-persist.jsonl");
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("subsequent flushes append to same file", async () => {
    analytics.recordEvent(makeEvent({ toolName: "Bash" }));
    await analytics.flushNow();
    analytics.recordEvent(makeEvent({ toolName: "Read" }));
    await analytics.flushNow();
    const filePath = join(tmpDir, "test-session-persist.jsonl");
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("no file created when no events", async () => {
    await analytics.flushNow();
    const filePath = join(tmpDir, "test-session-persist.jsonl");
    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolMetrics extensions — successRate, getTimeSeriesWindow, getCorrelations
// ---------------------------------------------------------------------------

import {
  ToolMetrics,
  type ToolSizeStats,
} from "../agent/tool-metrics.ts";

describe("ToolMetrics — failureCount & lastErrorType", () => {
  let metrics: ToolMetrics;

  beforeEach(() => {
    ToolMetrics.resetInstance();
    metrics = ToolMetrics.getInstance();
  });

  afterEach(() => ToolMetrics.resetInstance());

  test("failureCount starts at 0 for successful calls", () => {
    metrics.record("Bash", 1024, 100);
    const stats = metrics.getStats("Bash") as ToolSizeStats;
    expect(stats.failureCount).toBe(0);
  });

  test("failureCount increments on error", () => {
    metrics.record("Bash", 0, 10, "text", true, "ENOENT");
    metrics.record("Bash", 0, 10, "text", true, "EPERM");
    const stats = metrics.getStats("Bash") as ToolSizeStats;
    expect(stats.failureCount).toBe(2);
  });

  test("lastErrorType captures most recent error", () => {
    metrics.record("Bash", 0, 10, "text", true, "TimeoutError");
    const stats = metrics.getStats("Bash") as ToolSizeStats;
    expect(stats.lastErrorType).toBe("TimeoutError");
  });

  test("lastErrorType is empty when no error", () => {
    metrics.record("Read", 500, 50);
    const stats = metrics.getStats("Read") as ToolSizeStats;
    expect(stats.lastErrorType).toBe("");
  });
});

describe("ToolMetrics — successRate", () => {
  let metrics: ToolMetrics;

  beforeEach(() => {
    ToolMetrics.resetInstance();
    metrics = ToolMetrics.getInstance();
  });

  afterEach(() => ToolMetrics.resetInstance());

  test("returns 1.0 for unknown tool", () => {
    expect(metrics.successRate("NoSuchTool")).toBe(1.0);
  });

  test("returns 1.0 when no errors", () => {
    metrics.record("Read", 100, 50);
    metrics.record("Read", 200, 60);
    expect(metrics.successRate("Read")).toBe(1.0);
  });

  test("computes correct success rate", () => {
    metrics.record("Bash", 0, 10, "text", true);
    metrics.record("Bash", 100, 20);
    metrics.record("Bash", 100, 20);
    expect(metrics.successRate("Bash")).toBeCloseTo(2 / 3, 5);
  });
});

describe("ToolMetrics — getTimeSeriesWindow", () => {
  let metrics: ToolMetrics;

  beforeEach(() => {
    ToolMetrics.resetInstance();
    metrics = ToolMetrics.getInstance();
  });

  afterEach(() => ToolMetrics.resetInstance());

  test("returns empty array for unknown tool", () => {
    expect(metrics.getTimeSeriesWindow("NoTool", 5)).toEqual([]);
  });

  test("returns all entries within window", () => {
    metrics.record("Bash", 100, 50);
    metrics.record("Bash", 200, 60);
    const entries = metrics.getTimeSeriesWindow("Bash", 60);
    expect(entries).toHaveLength(2);
  });

  test("entries have required fields", () => {
    metrics.record("Read", 512, 80);
    const entries = metrics.getTimeSeriesWindow("Read", 1);
    expect(entries[0]).toMatchObject({
      bytes: 512,
      durationMs: 80,
      isError: false,
    });
    expect(typeof entries[0]!.timestamp).toBe("number");
  });
});

describe("ToolMetrics — getCorrelations", () => {
  let metrics: ToolMetrics;

  beforeEach(() => {
    ToolMetrics.resetInstance();
    metrics = ToolMetrics.getInstance();
  });

  afterEach(() => ToolMetrics.resetInstance());

  test("returns empty array for unknown tool", () => {
    expect(metrics.getCorrelations("NoTool")).toEqual([]);
  });

  test("tracks co-execution within a turn", () => {
    metrics.notifyTurnStart();
    metrics.record("Bash", 100, 50);
    metrics.record("Read", 200, 30);
    const corr = metrics.getCorrelations("Bash");
    expect(corr.find((c) => c.coTool === "Read")?.count).toBe(1);
  });

  test("does not correlate tools across separate turns", () => {
    metrics.notifyTurnStart();
    metrics.record("Bash", 100, 50);
    metrics.notifyTurnStart();
    metrics.record("Read", 200, 30);
    const corr = metrics.getCorrelations("Bash");
    expect(corr.find((c) => c.coTool === "Read")).toBeUndefined();
  });

  test("correlations are sorted by count descending", () => {
    // Turn 1: Bash + Read + Edit
    metrics.notifyTurnStart();
    metrics.record("Bash", 100, 50);
    metrics.record("Read", 100, 30);
    metrics.record("Edit", 100, 20);
    // Turn 2: Bash + Read
    metrics.notifyTurnStart();
    metrics.record("Bash", 100, 50);
    metrics.record("Read", 100, 30);
    const corr = metrics.getCorrelations("Bash");
    // Read should appear first (count=2), Edit second (count=1)
    expect(corr[0]!.coTool).toBe("Read");
    expect(corr[0]!.count).toBe(2);
  });

  test("reset clears correlations", () => {
    metrics.notifyTurnStart();
    metrics.record("Bash", 100, 50);
    metrics.record("Read", 100, 30);
    metrics.reset();
    expect(metrics.getCorrelations("Bash")).toEqual([]);
  });
});
