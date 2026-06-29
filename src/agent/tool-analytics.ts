/**
 * tool-analytics.ts — Aggregated, queryable tool execution analytics with persistence.
 *
 * Complements ToolMetrics (per-execution stats) with:
 *   - 30-second periodic rollup → ~/.ashlrcode/metrics/<session-id>.jsonl
 *   - rollupByTool()   — aggregated stats across all recorded events
 *   - rollupByGoal()   — stats filtered to a specific goal/conversation ID
 *   - anomalyDetect()  — z-score-based outlier detection on duration
 *
 * Usage:
 *   const analytics = ToolAnalytics.getInstance();
 *   analytics.start(sessionId);                 // begin periodic flush
 *   analytics.recordEvent(event);               // called from tool-executor
 *   const report = analytics.rollupByTool();    // query aggregates
 *   analytics.stop();                           // halt periodic flush
 */

import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Analytics event — one entry per tool execution
// ---------------------------------------------------------------------------

export interface AnalyticsEvent {
  /** Unix epoch ms. */
  timestamp: number;
  /** Session / REPL instance ID. */
  sessionId: string;
  /** Goal or conversation context ID (empty string if not in a goal). */
  goalId: string;
  /** Tool name. */
  toolName: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Output byte count. */
  outputBytes: number;
  /** Whether the execution errored. */
  isError: boolean;
  /** Short error description (empty when isError=false). */
  errorType: string;
}

// ---------------------------------------------------------------------------
// Rollup shapes
// ---------------------------------------------------------------------------

export interface ToolRollup {
  toolName: string;
  calls: number;
  errors: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  avgOutputBytes: number;
  totalOutputBytes: number;
}

export interface GoalRollup {
  goalId: string;
  totalCalls: number;
  totalErrors: number;
  totalDurationMs: number;
  uniqueTools: number;
  byTool: ToolRollup[];
}

export interface AnomalyResult {
  toolName: string;
  /** Detected outlier events (z-score > threshold). */
  outliers: Array<{
    timestamp: number;
    durationMs: number;
    zScore: number;
    isError: boolean;
  }>;
  /** Mean duration (ms) used for baseline. */
  meanMs: number;
  /** Standard deviation (ms) used for baseline. */
  stdMs: number;
}

// ---------------------------------------------------------------------------
// ToolAnalytics singleton
// ---------------------------------------------------------------------------

/** Z-score threshold above which an execution is flagged as anomalous. */
const ANOMALY_Z_THRESHOLD = 2.5;

/** Flush interval in ms (30 seconds). */
const FLUSH_INTERVAL_MS = 30_000;

export class ToolAnalytics {
  private static _instance: ToolAnalytics | null = null;

  static getInstance(): ToolAnalytics {
    if (!ToolAnalytics._instance) {
      ToolAnalytics._instance = new ToolAnalytics();
    }
    return ToolAnalytics._instance;
  }

  static resetInstance(): void {
    ToolAnalytics._instance?.stop();
    ToolAnalytics._instance = null;
  }

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  /** In-memory event buffer — flushed to disk every FLUSH_INTERVAL_MS. */
  private _buffer: AnalyticsEvent[] = [];
  /** Events pending flush (not yet written to disk). */
  private _pending: AnalyticsEvent[] = [];

  private _sessionId = "default";
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _metricsDir = join(homedir(), ".ashlrcode", "metrics");

  private constructor() {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start periodic flush to disk.
   * @param sessionId  — Unique ID for this REPL session (used as filename prefix).
   * @param metricsDir — Override default metrics dir (useful in tests).
   */
  start(sessionId: string, metricsDir?: string): void {
    this._sessionId = sessionId;
    if (metricsDir) this._metricsDir = metricsDir;
    if (this._flushTimer) return; // already running
    this._flushTimer = setInterval(() => {
      void this._flush();
    }, FLUSH_INTERVAL_MS);
    // Allow the process to exit even if the timer is active
    if (typeof this._flushTimer === "object" && "unref" in this._flushTimer) {
      (this._flushTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the periodic flush and perform a final synchronous flush. */
  stop(): void {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    // Best-effort final flush — fire and forget
    void this._flush();
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  /**
   * Record a single tool execution event.
   * The event is appended to the in-memory buffer and to the pending-flush queue.
   */
  recordEvent(event: AnalyticsEvent): void {
    this._buffer.push(event);
    this._pending.push(event);
  }

  // -------------------------------------------------------------------------
  // Disk persistence
  // -------------------------------------------------------------------------

  /** Flush pending events to ~/.ashlrcode/metrics/<sessionId>.jsonl */
  private async _flush(): Promise<void> {
    if (this._pending.length === 0) return;
    const toWrite = this._pending.splice(0);
    try {
      await mkdir(this._metricsDir, { recursive: true });
      const filePath = join(this._metricsDir, `${this._sessionId}.jsonl`);
      const lines = toWrite.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(filePath, lines, "utf8");
    } catch {
      // Non-fatal — metrics persistence is best-effort
      // Re-queue events so they can be retried
      this._pending.unshift(...toWrite);
    }
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Return aggregated rollup stats for every tool seen in this session,
   * sorted by call count descending.
   */
  rollupByTool(): ToolRollup[] {
    const grouped = new Map<string, AnalyticsEvent[]>();
    for (const e of this._buffer) {
      const arr = grouped.get(e.toolName) ?? [];
      arr.push(e);
      grouped.set(e.toolName, arr);
    }
    return Array.from(grouped.entries())
      .map(([toolName, events]) => buildToolRollup(toolName, events))
      .sort((a, b) => b.calls - a.calls);
  }

  /**
   * Return aggregated rollup for all tool calls associated with a specific goal.
   * If goalId is empty or not found, returns a rollup with zero calls.
   */
  rollupByGoal(goalId: string): GoalRollup {
    const events = this._buffer.filter((e) => e.goalId === goalId);
    const grouped = new Map<string, AnalyticsEvent[]>();
    for (const e of events) {
      const arr = grouped.get(e.toolName) ?? [];
      arr.push(e);
      grouped.set(e.toolName, arr);
    }
    const byTool = Array.from(grouped.entries()).map(([toolName, evts]) =>
      buildToolRollup(toolName, evts)
    );
    return {
      goalId,
      totalCalls: events.length,
      totalErrors: events.filter((e) => e.isError).length,
      totalDurationMs: events.reduce((s, e) => s + e.durationMs, 0),
      uniqueTools: grouped.size,
      byTool,
    };
  }

  /**
   * Detect anomalous (unusually slow) executions for a tool using z-scores.
   * Returns an AnomalyResult with the outlier list and baseline stats.
   *
   * A z-score > ANOMALY_Z_THRESHOLD (2.5) is flagged.
   * Requires at least 5 samples; returns empty outliers array otherwise.
   */
  anomalyDetect(toolName: string): AnomalyResult {
    const events = this._buffer.filter((e) => e.toolName === toolName);
    if (events.length < 5) {
      return { toolName, outliers: [], meanMs: 0, stdMs: 0 };
    }

    const durations = events.map((e) => e.durationMs);
    const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
    const variance =
      durations.reduce((s, d) => s + (d - mean) ** 2, 0) / durations.length;
    const std = Math.sqrt(variance);

    if (std === 0) {
      return { toolName, outliers: [], meanMs: mean, stdMs: 0 };
    }

    const outliers = events
      .map((e) => ({
        timestamp: e.timestamp,
        durationMs: e.durationMs,
        zScore: (e.durationMs - mean) / std,
        isError: e.isError,
      }))
      .filter((o) => o.zScore > ANOMALY_Z_THRESHOLD)
      .sort((a, b) => b.zScore - a.zScore);

    return { toolName, outliers, meanMs: mean, stdMs: std };
  }

  /**
   * Return all events in the in-memory buffer (useful for testing / inspection).
   */
  getBuffer(): readonly AnalyticsEvent[] {
    return this._buffer;
  }

  /**
   * Return the number of events pending a flush to disk.
   */
  getPendingCount(): number {
    return this._pending.length;
  }

  /**
   * Force an immediate flush to disk (resolves when done).
   * Exposed primarily for testing.
   */
  async flushNow(): Promise<void> {
    await this._flush();
  }

  /**
   * Clear all in-memory data (for testing).
   */
  reset(): void {
    this._buffer = [];
    this._pending = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolRollup(toolName: string, events: AnalyticsEvent[]): ToolRollup {
  const calls = events.length;
  const errors = events.filter((e) => e.isError).length;
  const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
  const avgDurationMs =
    durations.reduce((s, d) => s + d, 0) / (calls || 1);
  const maxDurationMs = durations[durations.length - 1] ?? 0;
  const p50DurationMs = percentile(durations, 50);
  const p95DurationMs = percentile(durations, 95);
  const totalOutputBytes = events.reduce((s, e) => s + e.outputBytes, 0);
  const avgOutputBytes = totalOutputBytes / (calls || 1);

  return {
    toolName,
    calls,
    errors,
    successRate: calls > 0 ? (calls - errors) / calls : 1,
    avgDurationMs,
    p50DurationMs,
    p95DurationMs,
    maxDurationMs,
    avgOutputBytes,
    totalOutputBytes,
  };
}

/** Return the value at the given percentile (0–100) from a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? 0;
}

// ---------------------------------------------------------------------------
// Module-level accessor
// ---------------------------------------------------------------------------

export function getToolAnalytics(): ToolAnalytics {
  return ToolAnalytics.getInstance();
}
