/**
 * Tool Result Streaming Predictor with Adaptive Quantization
 *
 * Pre-execution estimator for tool output sizes.  Uses semantic analysis of
 * tool intent + recent history (dedup-cache stats, ToolMetrics) to estimate
 * output bytes before the tool executes, then feeds that estimate into
 * resolveCompressionOptions() so streamResultCompressor() can set thresholds
 * that match the expected output — reducing token waste on large outputs while
 * preserving full detail on small ones.
 *
 * Pipeline:
 *   1. classifyOutputPattern()  — label the tool call with a likely output pattern
 *   2. estimateFromPattern()    — map pattern → rough byte estimate
 *   3. blendWithHistory()       — refine with ToolMetrics history when available
 *   4. predict()                — entry point: returns PredictionResult
 *   5. recordActual()           — log actual bytes after execution for drift tracking
 *   6. getPredictionLog()       — inspect accuracy over time
 */

import { getToolMetrics } from "./tool-metrics.ts";

// ---------------------------------------------------------------------------
// Output pattern taxonomy
// ---------------------------------------------------------------------------

/**
 * Enumeration of recognisable tool output patterns.  Each pattern carries a
 * characteristic byte range that drives the initial size estimate.
 */
export type OutputPattern =
  | "file_listing"      // ls / find results — one path per line, many lines
  | "grep_results"      // grep matches — filename:lineno:content
  | "test_output"       // test runner output — pass/fail summaries, stack traces
  | "code_dump"         // source file content — moderate, structured
  | "stack_trace"       // error + call stack
  | "package_install"   // npm/yarn/bun install — dependency trees
  | "git_log"           // git log / diff — variable, often large
  | "config_file"       // JSON/YAML/TOML config — small, structured
  | "write_confirm"     // write/edit confirmation — tiny
  | "generic_text";     // fallback

// ---------------------------------------------------------------------------
// Pattern → byte-range heuristics
// ---------------------------------------------------------------------------

/**
 * Byte estimate per pattern.  These are P75 estimates — calibrated to be
 * slightly conservative so we lean toward more compression rather than less.
 */
const PATTERN_BYTE_ESTIMATES: Record<OutputPattern, number> = {
  file_listing:    65_000,   // find . -type f on a mid-sized project
  grep_results:    42_000,   // grep -r over src/
  test_output:     30_000,   // full test suite output
  code_dump:        8_000,   // typical source file
  stack_trace:     12_000,   // error + deep call stack
  package_install: 16_000,   // bun install
  git_log:         28_000,   // git log --oneline
  config_file:      3_500,   // package.json / tsconfig
  write_confirm:      400,   // "File written" etc.
  generic_text:    10_000,   // conservative default
};

// ---------------------------------------------------------------------------
// Confidence levels
// ---------------------------------------------------------------------------

export type ConfidenceLevel = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PredictionResult {
  /** Estimated output size in bytes. */
  estimatedBytes: number;
  /** Output pattern that drove the estimate. */
  pattern: OutputPattern;
  /** How confident we are in the estimate. */
  confidence: ConfidenceLevel;
  /**
   * Source that produced the primary estimate:
   * - "history"   — ToolMetrics had ≥ 3 samples; history dominated.
   * - "heuristic" — pattern-based heuristic only.
   * - "blended"   — mix of heuristic and limited history (1–2 samples).
   */
  source: "history" | "heuristic" | "blended";
}

export interface PredictionLogEntry {
  toolName: string;
  pattern: OutputPattern;
  estimatedBytes: number;
  actualBytes: number;
  /** Ratio actual/estimated.  Values >1 mean we under-predicted. */
  accuracyRatio: number;
  timestampMs: number;
}

// ---------------------------------------------------------------------------
// Semantic classifier
// ---------------------------------------------------------------------------

/**
 * Classify the likely output pattern for a tool call from its name and input.
 *
 * Checked top-to-bottom; first match wins.
 */
export function classifyOutputPattern(
  toolName: string,
  input: Record<string, unknown>
): OutputPattern {
  const name = toolName.toLowerCase();
  const inputText = Object.values(input)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");

  // Write / Edit operations → tiny confirmation messages
  if (/write|edit|patch|apply/i.test(name)) return "write_confirm";

  // Bash tool — inspect the command to classify
  if (/bash|shell|run|exec/i.test(name)) {
    if (/\bfind\b/.test(inputText))                             return "file_listing";
    if (/\bgrep\b.*-r|\bgrep\b.*--recursive|\brg\b/i.test(inputText)) return "grep_results";
    if (/\bgit\s+(log|diff|show|blame)\b/i.test(inputText))    return "git_log";
    if (/\b(npm|bun|yarn|pnpm)\s+(install|ci|add|i\b)/i.test(inputText)) return "package_install";
    if (/\b(jest|vitest|bun test|pytest|go test|cargo test)\b/i.test(inputText)) return "test_output";
    if (/\bcat\b/.test(inputText))                             return "code_dump";
    return "generic_text";
  }

  // Dedicated Grep tool
  if (/grep/i.test(name)) return "grep_results";

  // Dedicated LS / Glob tools
  if (/\b(ls|glob|find|dir)\b/i.test(name)) return "file_listing";

  // Read tool — classify by file extension / name
  if (/read|view|open/i.test(name)) {
    const path = String(input.file_path ?? input.path ?? "");
    if (/package\.json|tsconfig|\.yaml|\.yml|\.toml|\.env|\.ini/i.test(path)) return "config_file";
    if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|cs|rb|php|swift)\b/i.test(path)) return "code_dump";
    if (/\.(md|txt|log)\b/i.test(path)) return "generic_text";
    return "code_dump"; // safe default for unknown source files
  }

  // Test tool
  if (/test|spec|check/i.test(name)) return "test_output";

  return "generic_text";
}

// ---------------------------------------------------------------------------
// ToolResultPredictor
// ---------------------------------------------------------------------------

/**
 * Minimum number of ToolMetrics samples required to blend history into the
 * prediction.  Below this threshold we rely on heuristics only.
 */
const MIN_HISTORY_SAMPLES = 3;

/**
 * Maximum log entries retained in memory per predictor instance.
 * Old entries are evicted FIFO when the cap is reached.
 */
const MAX_LOG_ENTRIES = 500;

export class ToolResultPredictor {
  private static _instance: ToolResultPredictor | null = null;

  private readonly _log: PredictionLogEntry[] = [];

  // Private constructor — use getInstance() or create() for isolated instances.
  private constructor() {}

  /** Process-wide singleton. */
  static getInstance(): ToolResultPredictor {
    if (!ToolResultPredictor._instance) {
      ToolResultPredictor._instance = new ToolResultPredictor();
    }
    return ToolResultPredictor._instance;
  }

  /** Replace singleton (useful in tests). */
  static resetInstance(): void {
    ToolResultPredictor._instance = null;
  }

  /** Create an isolated instance (for unit tests). */
  static create(): ToolResultPredictor {
    return new ToolResultPredictor();
  }

  // -------------------------------------------------------------------------
  // Core prediction
  // -------------------------------------------------------------------------

  /**
   * Predict the output size (in bytes) for a tool call before it executes.
   *
   * Algorithm:
   *   1. Classify the output pattern from tool name + input.
   *   2. Look up ToolMetrics history for this tool.
   *   3. If history has ≥ MIN_HISTORY_SAMPLES: blend (70% history mean + 30% heuristic).
   *   4. If history has 1–2 samples: blend (50% each) and mark source "blended".
   *   5. Otherwise: use pattern-based estimate only.
   */
  predict(toolName: string, input: Record<string, unknown>): PredictionResult {
    const pattern = classifyOutputPattern(toolName, input);
    const heuristicBytes = PATTERN_BYTE_ESTIMATES[pattern];

    const metrics = getToolMetrics();
    const stats = metrics.getStats(toolName);

    if (stats && stats.samples >= MIN_HISTORY_SAMPLES) {
      // History-dominant: 70% mean + 30% heuristic; conservative bias via max
      const historyBlend = stats.avgBytes * 0.7 + stats.maxBytes * 0.3;
      const estimatedBytes = Math.round(historyBlend * 0.7 + heuristicBytes * 0.3);
      const confidence: ConfidenceLevel = stats.samples >= 10 ? "high" : "medium";
      return { estimatedBytes, pattern, confidence, source: "history" };
    }

    if (stats && stats.samples >= 1) {
      // Limited history: equal weight blend
      const estimatedBytes = Math.round((stats.avgBytes + heuristicBytes) / 2);
      return { estimatedBytes, pattern, confidence: "low", source: "blended" };
    }

    // Heuristic only
    return {
      estimatedBytes: heuristicBytes,
      pattern,
      confidence: "low",
      source: "heuristic",
    };
  }

  // -------------------------------------------------------------------------
  // Accuracy logging
  // -------------------------------------------------------------------------

  /**
   * Record the actual output size after a tool executes so we can track
   * prediction accuracy over time.  This is a fire-and-forget annotation —
   * it never throws.
   */
  recordActual(
    toolName: string,
    prediction: PredictionResult,
    actualBytes: number
  ): void {
    try {
      const ratio = actualBytes > 0 ? actualBytes / prediction.estimatedBytes : 1;
      const entry: PredictionLogEntry = {
        toolName,
        pattern: prediction.pattern,
        estimatedBytes: prediction.estimatedBytes,
        actualBytes,
        accuracyRatio: ratio,
        timestampMs: Date.now(),
      };

      this._log.push(entry);
      // FIFO eviction
      if (this._log.length > MAX_LOG_ENTRIES) {
        this._log.shift();
      }
    } catch {
      // Never throw from logging
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Return all logged prediction entries (newest last). */
  getPredictionLog(): readonly PredictionLogEntry[] {
    return this._log;
  }

  /**
   * Compute aggregate accuracy stats across all logged predictions.
   *
   * Returns undefined when there are no log entries yet.
   */
  getAccuracyStats(): {
    count: number;
    meanRatio: number;
    overPredictions: number;   // actual < estimated (wasted compression budget)
    underPredictions: number;  // actual > estimated (surprise large output)
    byPattern: Record<OutputPattern, { count: number; meanRatio: number }>;
  } | undefined {
    if (this._log.length === 0) return undefined;

    let sumRatio = 0;
    let over = 0;
    let under = 0;
    const byPattern: Partial<Record<OutputPattern, { sum: number; count: number }>> = {};

    for (const entry of this._log) {
      sumRatio += entry.accuracyRatio;
      if (entry.accuracyRatio < 1) over++;
      else if (entry.accuracyRatio > 1) under++;

      const p = byPattern[entry.pattern] ?? { sum: 0, count: 0 };
      p.sum += entry.accuracyRatio;
      p.count++;
      byPattern[entry.pattern] = p;
    }

    const patternResult = {} as Record<OutputPattern, { count: number; meanRatio: number }>;
    for (const [k, v] of Object.entries(byPattern)) {
      patternResult[k as OutputPattern] = {
        count: v!.count,
        meanRatio: v!.sum / v!.count,
      };
    }

    return {
      count: this._log.length,
      meanRatio: sumRatio / this._log.length,
      overPredictions: over,
      underPredictions: under,
      byPattern: patternResult,
    };
  }

  /** Reset the log (for testing). */
  resetLog(): void {
    this._log.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience accessors
// ---------------------------------------------------------------------------

/** Singleton accessor. */
export function getToolResultPredictor(): ToolResultPredictor {
  return ToolResultPredictor.getInstance();
}

/**
 * One-shot predict + return estimatedBytes.
 * Convenience wrapper for callers that only need the byte estimate.
 */
export function predictToolOutputSize(
  toolName: string,
  input: Record<string, unknown>
): number {
  return getToolResultPredictor().predict(toolName, input).estimatedBytes;
}
