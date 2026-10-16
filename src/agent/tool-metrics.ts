/**
 * tool-metrics.ts — ToolMetrics Singleton + Size Predictor
 *
 * Maintains per-tool execution statistics (avg bytes, max bytes, patterns) and
 * exposes predictOutputSize() so streamResultCompressor() can proactively tune
 * its thresholds before a tool even executes.
 *
 * Lifecycle:
 *   1. Before execution: call predictOutputSize(toolName, input) → estimated bytes
 *   2. After execution:  call record(toolName, inputShape, bytes, durationMs)
 *
 * Prediction strategy (in priority order):
 *   a. Historical mean from recorded executions (if ≥ 3 samples)
 *   b. Static heuristics keyed on tool name + input shape keywords
 *   c. Conservative default (10 KB)
 */

// ---------------------------------------------------------------------------
// Static heuristic table
// ---------------------------------------------------------------------------

/**
 * Heuristic entries: first match wins (checked in order).
 * Each entry describes a pattern that typically produces large output.
 */
interface HeuristicEntry {
  /** Tool name substring match (case-insensitive). */
  toolPattern: RegExp;
  /** Optional: input key+value substring match (any input value as string). */
  inputPattern?: RegExp;
  /** Estimated output bytes for this pattern. */
  estimatedBytes: number;
}

const HEURISTICS: HeuristicEntry[] = [
  // find / ls -R — typically very large listings
  { toolPattern: /bash/i, inputPattern: /\bfind\b/, estimatedBytes: 60_000 },
  // grep over large trees
  { toolPattern: /bash/i, inputPattern: /\bgrep\b.*-r|\bgrep\b.*--recursive/, estimatedBytes: 40_000 },
  // git log with no limit
  { toolPattern: /bash/i, inputPattern: /\bgit\s+log\b/, estimatedBytes: 30_000 },
  // cat of large files
  { toolPattern: /bash/i, inputPattern: /\bcat\b/, estimatedBytes: 20_000 },
  // npm/bun install — moderate output
  { toolPattern: /bash/i, inputPattern: /\b(npm|bun|yarn|pnpm)\s+(install|ci|add)\b/, estimatedBytes: 15_000 },
  // generic Bash — moderate
  { toolPattern: /bash/i, estimatedBytes: 12_000 },
  // Grep tool (dedicated tool, not bash)
  { toolPattern: /grep/i, estimatedBytes: 25_000 },
  // Read on known small files
  { toolPattern: /read/i, inputPattern: /package\.json|tsconfig|\.env/, estimatedBytes: 4_000 },
  // Read on source/test files — moderate
  { toolPattern: /read/i, inputPattern: /\.(ts|tsx|js|jsx|py|go|rs|md)$/, estimatedBytes: 8_000 },
  // Read — fallback
  { toolPattern: /read/i, estimatedBytes: 10_000 },
  // Write/Edit — confirmation messages are tiny
  { toolPattern: /write|edit/i, estimatedBytes: 500 },
];

/** Conservative default when no heuristic matches. */
const DEFAULT_ESTIMATED_BYTES = 10_000;

// ---------------------------------------------------------------------------
// Per-tool stats stored in the singleton
// ---------------------------------------------------------------------------

export interface ToolSizeStats {
  /** Tool name. */
  name: string;
  /** Number of recorded executions. */
  samples: number;
  /** Average output bytes across all samples. */
  avgBytes: number;
  /** Maximum output bytes seen. */
  maxBytes: number;
  /** Minimum output bytes seen. */
  minBytes: number;
  /** Average execution time in ms. */
  avgDurationMs: number;
  /** Pattern tag most commonly seen in outputs: "text" | "stack trace" | "grep matches" | "file listing" | "list items" */
  dominantPattern: string;
  /** Number of failed executions (isError = true). */
  failureCount: number;
  /** Last error type/message seen (empty string if none). */
  lastErrorType: string;
}

// ---------------------------------------------------------------------------
// Time-series entry for temporal rollups
// ---------------------------------------------------------------------------

export interface TimeSeriesEntry {
  /** Unix epoch ms when the execution was recorded. */
  timestamp: number;
  /** Output bytes of that execution. */
  bytes: number;
  /** Execution duration in ms. */
  durationMs: number;
  /** Whether the execution resulted in an error. */
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Co-execution correlation record
// ---------------------------------------------------------------------------

export interface ToolCorrelation {
  /** The co-executed tool name. */
  coTool: string;
  /** Number of times these two tools were called together (same turn). */
  count: number;
}

// ---------------------------------------------------------------------------
// ToolMetrics singleton
// ---------------------------------------------------------------------------

/** Minimum samples required before we trust the historical mean. */
const MIN_SAMPLES_FOR_HISTORY = 3;

export class ToolMetrics {
  private static _instance: ToolMetrics | null = null;

  /** Returns the process-wide singleton instance. */
  static getInstance(): ToolMetrics {
    if (!ToolMetrics._instance) {
      ToolMetrics._instance = new ToolMetrics();
    }
    return ToolMetrics._instance;
  }

  /** Replace the singleton (useful in tests). */
  static resetInstance(): void {
    ToolMetrics._instance = null;
  }

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  private readonly _stats = new Map<string, ToolSizeStats>();

  /**
   * Ring-buffer of recent executions per tool for time-series queries.
   * Capped at MAX_TIME_SERIES_ENTRIES per tool to bound memory.
   */
  private readonly _timeSeries = new Map<string, TimeSeriesEntry[]>();
  private static readonly MAX_TIME_SERIES_ENTRIES = 500;

  /**
   * Co-execution counts: outer key = tool A, inner key = tool B.
   * Incremented when two different tools are recorded in the same "turn"
   * (tracked via notifyTurnStart / the current-turn token).
   */
  private readonly _correlations = new Map<string, Map<string, number>>();

  /**
   * Tools seen in the current turn — used to update correlations on record().
   * Reset via notifyTurnStart().
   */
  private _currentTurnTools: Set<string> = new Set();

  // Private constructor — use getInstance().
  private constructor() {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record the result of a completed tool execution.
   *
   * @param toolName    - Canonical tool name (e.g. "Bash", "Read").
   * @param outputBytes - UTF-8 byte length of the result string.
   * @param durationMs  - Wall-clock execution time in milliseconds.
   * @param pattern     - Pattern tag detected by summariseChunk() (optional).
   * @param isError     - Whether the execution resulted in an error.
   * @param errorType   - Short description of the error type (optional).
   */
  record(
    toolName: string,
    outputBytes: number,
    durationMs: number,
    pattern = "text",
    isError = false,
    errorType = ""
  ): void {
    const existing = this._stats.get(toolName);
    if (!existing) {
      this._stats.set(toolName, {
        name: toolName,
        samples: 1,
        avgBytes: outputBytes,
        maxBytes: outputBytes,
        minBytes: outputBytes,
        avgDurationMs: durationMs,
        dominantPattern: pattern,
        failureCount: isError ? 1 : 0,
        lastErrorType: isError ? errorType : "",
      });
    } else {
      const n = existing.samples + 1;
      // Incremental mean update
      existing.avgBytes = (existing.avgBytes * existing.samples + outputBytes) / n;
      existing.avgDurationMs = (existing.avgDurationMs * existing.samples + durationMs) / n;
      existing.maxBytes = Math.max(existing.maxBytes, outputBytes);
      existing.minBytes = Math.min(existing.minBytes, outputBytes);
      existing.samples = n;
      if (isError) {
        existing.failureCount++;
        if (errorType) existing.lastErrorType = errorType;
      }
      // Keep dominant pattern as the most recently detected (simple heuristic)
      if (pattern !== "text") existing.dominantPattern = pattern;
      this._stats.set(toolName, existing);
    }

    // Append to time-series ring buffer
    const tsBuf = this._timeSeries.get(toolName) ?? [];
    tsBuf.push({ timestamp: Date.now(), bytes: outputBytes, durationMs, isError });
    if (tsBuf.length > ToolMetrics.MAX_TIME_SERIES_ENTRIES) tsBuf.shift();
    this._timeSeries.set(toolName, tsBuf);

    // Update co-execution correlations for tools in the current turn
    for (const other of this._currentTurnTools) {
      if (other === toolName) continue;
      // toolName → other
      const fromA = this._correlations.get(toolName) ?? new Map<string, number>();
      fromA.set(other, (fromA.get(other) ?? 0) + 1);
      this._correlations.set(toolName, fromA);
      // other → toolName (symmetric)
      const fromB = this._correlations.get(other) ?? new Map<string, number>();
      fromB.set(toolName, (fromB.get(toolName) ?? 0) + 1);
      this._correlations.set(other, fromB);
    }
    this._currentTurnTools.add(toolName);
  }

  /**
   * Notify the metrics tracker that a new agent turn has started.
   * Resets the current-turn tool set so correlation tracking is per-turn.
   */
  notifyTurnStart(): void {
    this._currentTurnTools = new Set();
  }

  /**
   * Return the success rate (0–1) for a tool, or 1.0 if no data.
   */
  successRate(toolName: string): number {
    const stats = this._stats.get(toolName);
    if (!stats || stats.samples === 0) return 1.0;
    return (stats.samples - stats.failureCount) / stats.samples;
  }

  /**
   * Return time-series entries for a tool within the last `minutes` minutes.
   * Returns an empty array if no data or the tool has never been recorded.
   */
  getTimeSeriesWindow(toolName: string, minutes: number): TimeSeriesEntry[] {
    const buf = this._timeSeries.get(toolName);
    if (!buf) return [];
    const cutoff = Date.now() - minutes * 60 * 1000;
    return buf.filter((e) => e.timestamp >= cutoff);
  }

  /**
   * Return co-execution correlations for a tool, sorted by count descending.
   * These describe which other tools tend to be called in the same turn.
   */
  getCorrelations(toolName: string): ToolCorrelation[] {
    const map = this._correlations.get(toolName);
    if (!map) return [];
    return Array.from(map.entries())
      .map(([coTool, count]) => ({ coTool, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Predict the likely output size (in bytes) for a tool call before executing.
   *
   * Priority:
   *   1. Historical mean (if ≥ MIN_SAMPLES_FOR_HISTORY samples exist)
   *   2. Static heuristics (tool name + input shape)
   *   3. DEFAULT_ESTIMATED_BYTES
   *
   * @param toolName - Tool name.
   * @param input    - Tool input record (values are stringified for heuristic matching).
   * @returns Predicted byte count.
   */
  predictOutputSize(toolName: string, input: Record<string, unknown>): number {
    // 1. Trust history if we have enough data
    const stats = this._stats.get(toolName);
    if (stats && stats.samples >= MIN_SAMPLES_FOR_HISTORY) {
      // Use a blend: 70% mean, 30% max to be conservative
      return Math.round(stats.avgBytes * 0.7 + stats.maxBytes * 0.3);
    }

    // 2. Static heuristics — flatten input values to a single string for matching
    const inputText = Object.values(input)
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ");

    for (const h of HEURISTICS) {
      if (!h.toolPattern.test(toolName)) continue;
      if (h.inputPattern && !h.inputPattern.test(inputText)) continue;
      return h.estimatedBytes;
    }

    // 3. Fallback
    return DEFAULT_ESTIMATED_BYTES;
  }

  /**
   * Return stats for a specific tool, or undefined if no data recorded.
   */
  getStats(toolName: string): ToolSizeStats | undefined {
    return this._stats.get(toolName);
  }

  /**
   * Return all recorded stats, sorted by sample count descending.
   */
  getAllStats(): ToolSizeStats[] {
    return Array.from(this._stats.values()).sort((a, b) => b.samples - a.samples);
  }

  /**
   * Reset all recorded statistics (for testing).
   */
  reset(): void {
    this._stats.clear();
    this._timeSeries.clear();
    this._correlations.clear();
    this._currentTurnTools = new Set();
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

/** Module-level singleton accessor. */
export function getToolMetrics(): ToolMetrics {
  return ToolMetrics.getInstance();
}

// ---------------------------------------------------------------------------
// Adaptive compression config
// ---------------------------------------------------------------------------

/**
 * If predicted output size exceeds this threshold, use aggressive compression.
 * (30 KB)
 */
export const PREDICT_LARGE_THRESHOLD = 30_720;

/**
 * If predicted output size is below this threshold, disable summarisation
 * entirely (pass maxBytes = Infinity).
 * (5 KB)
 */
export const PREDICT_SMALL_THRESHOLD = 5_120;

/** Aggressive compression: maxBytes lowered to 8 KB, chunkSummaryThreshold to 1 KB. */
export const AGGRESSIVE_MAX_BYTES = 8_192;
export const AGGRESSIVE_CHUNK_THRESHOLD = 1_024;

export interface CompressorConfig {
  /**
   * Called before execution to predict output size in bytes.
   * Receives tool name and raw input.
   * Return value drives threshold adaptation.
   */
  predictor?: (toolName: string, input: Record<string, unknown>) => number;

  /**
   * Override max verbatim bytes.  When undefined the adaptive logic chooses
   * based on the predictor result.
   */
  maxBytes?: number;

  /**
   * Override chunk summary threshold.  When undefined the adaptive logic chooses.
   */
  chunkSummaryThreshold?: number;

  /**
   * When true, skip summarisation regardless of output size.
   * Equivalent to maxBytes = Infinity.
   */
  disableSummarisation?: boolean;
}

/**
 * Derive concrete CompressorOptions from a CompressorConfig + predicted size.
 *
 * Rules:
 *   - predictedSize > PREDICT_LARGE_THRESHOLD  → aggressive (8 KB / 1 KB)
 *   - predictedSize < PREDICT_SMALL_THRESHOLD  → no summarisation (maxBytes = Infinity)
 *   - otherwise                                 → defaults (15 KB / 2 KB)
 *
 * Explicit overrides in `config` always win.
 */
export function resolveCompressionOptions(
  config: CompressorConfig,
  predictedSize: number
): { maxBytes: number; chunkSummaryThreshold: number } {
  // Explicit overrides take priority
  if (config.disableSummarisation) {
    return {
      maxBytes: config.maxBytes ?? Number.MAX_SAFE_INTEGER,
      chunkSummaryThreshold: config.chunkSummaryThreshold ?? Number.MAX_SAFE_INTEGER,
    };
  }

  // Compute adaptive defaults from prediction
  let adaptiveMax: number;
  let adaptiveChunk: number;

  if (predictedSize > PREDICT_LARGE_THRESHOLD) {
    adaptiveMax = AGGRESSIVE_MAX_BYTES;
    adaptiveChunk = AGGRESSIVE_CHUNK_THRESHOLD;
  } else if (predictedSize < PREDICT_SMALL_THRESHOLD) {
    adaptiveMax = Number.MAX_SAFE_INTEGER;
    adaptiveChunk = Number.MAX_SAFE_INTEGER;
  } else {
    // Import at call-site would create a circular dep; use the same numeric values
    adaptiveMax = 15_360; // DEFAULT_TOOL_RESULT_MAX_BYTES
    adaptiveChunk = 2_048; // DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD
  }

  return {
    maxBytes: config.maxBytes ?? adaptiveMax,
    chunkSummaryThreshold: config.chunkSummaryThreshold ?? adaptiveChunk,
  };
}
