/**
 * SpeculationIntentPredictor
 *
 * Analyzes the user's message + recent tool-call history to produce
 * confidence-scored predictions of which tools are likely to be called next.
 * These predictions are consumed by ToolBatcher to pre-emptively warm the
 * speculation cache before the model returns its response.
 *
 * Design notes
 * ────────────
 * • Pure CPU — no LLM call. Fast enough to run inline before every turn.
 * • Intent buckets: refactor | feature | debug | read | search | other
 * • Each tool prediction carries a confidence interval [lo, mid, hi].
 * • Feedback loop: when a predicted tool is actually called and the cache
 *   warms it, we log the outcome to speculation-feedback.jsonl.
 */

import { appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Broad categories of developer intent inferred from the user message. */
export type IntentBucket =
  | "refactor"
  | "feature"
  | "debug"
  | "read"
  | "search"
  | "test"
  | "other";

/** A single tool prediction with confidence scores. */
export interface ToolPrediction {
  /** Tool name (matches the tool registry names: Read, Grep, Glob, Bash, …) */
  toolName: string;
  /** Point-estimate confidence 0–1 */
  confidence: number;
  /** Lower bound of 90% confidence interval */
  confidenceLo: number;
  /** Upper bound of 90% confidence interval */
  confidenceHi: number;
  /** Why this tool was predicted */
  rationale: string;
  /** Suggested input hints when confidence is high enough to pre-warm */
  inputHints?: Record<string, unknown>;
}

/** Output of a single prediction run. */
export interface PredictionResult {
  /** Inferred intent category */
  intent: IntentBucket;
  /** Overall intent-inference confidence */
  intentConfidence: number;
  /** Ordered list of next-tool predictions, highest confidence first */
  predictions: ToolPrediction[];
  /** Wall-clock time taken to produce this prediction (ms) */
  latencyMs: number;
}

/** One record written to speculation-feedback.jsonl on a cache warm-up hit. */
export interface SpeculationFeedbackRecord {
  timestamp: string;
  intent: IntentBucket;
  intentConfidence: number;
  predictedTool: string;
  predictedConfidence: number;
  cacheHit: boolean;
  /** Latency saved in ms (0 when cacheHit is false) */
  latencySavedMs: number;
  /** The user message that triggered the prediction (first 120 chars) */
  messageSnippet: string;
}

// ---------------------------------------------------------------------------
// Telemetry counters (session-level singleton)
// ---------------------------------------------------------------------------

export interface SpeculationTelemetry {
  predictions: number;
  cacheHits: number;
  cacheMisses: number;
  falsePositives: number;
  totalLatencySavedMs: number;
  hitRatePct: number;
  avgLatencySavedMs: number;
  falsePositiveRatePct: number;
}

let _telemetry: SpeculationTelemetry = _emptyTelemetry();

function _emptyTelemetry(): SpeculationTelemetry {
  return {
    predictions: 0,
    cacheHits: 0,
    cacheMisses: 0,
    falsePositives: 0,
    totalLatencySavedMs: 0,
    hitRatePct: 0,
    avgLatencySavedMs: 0,
    falsePositiveRatePct: 0,
  };
}

export function getSpeculationTelemetry(): Readonly<SpeculationTelemetry> {
  return { ..._telemetry };
}

export function resetSpeculationTelemetry(): void {
  _telemetry = _emptyTelemetry();
}

function _updateTelemetry(
  hit: boolean,
  latencySavedMs: number,
  isFalsePositive: boolean,
): void {
  _telemetry.predictions++;
  if (hit) {
    _telemetry.cacheHits++;
    _telemetry.totalLatencySavedMs += latencySavedMs;
  } else {
    _telemetry.cacheMisses++;
  }
  if (isFalsePositive) _telemetry.falsePositives++;

  const total = _telemetry.cacheHits + _telemetry.cacheMisses;
  _telemetry.hitRatePct =
    total > 0 ? Math.round((_telemetry.cacheHits / total) * 100) : 0;
  _telemetry.avgLatencySavedMs =
    _telemetry.cacheHits > 0
      ? Math.round(_telemetry.totalLatencySavedMs / _telemetry.cacheHits)
      : 0;
  _telemetry.falsePositiveRatePct =
    total > 0 ? Math.round((_telemetry.falsePositives / total) * 100) : 0;
}

export function formatSpeculationTelemetry(): string {
  const t = _telemetry;
  const total = t.cacheHits + t.cacheMisses;
  return [
    "Speculation Telemetry:",
    `  Predictions made   : ${t.predictions}`,
    `  Cache hits         : ${t.cacheHits} / ${total} (${t.hitRatePct}%)`,
    `  False positives    : ${t.falsePositives} (${t.falsePositiveRatePct}%)`,
    `  Avg latency saved  : ${t.avgLatencySavedMs}ms`,
    `  Total latency saved: ${t.totalLatencySavedMs}ms`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Feedback JSONL logger
// ---------------------------------------------------------------------------

const DEFAULT_FEEDBACK_PATH = join(
  homedir(),
  ".ashlrcode",
  "speculation-feedback.jsonl",
);

export async function logSpeculationFeedback(
  record: SpeculationFeedbackRecord,
  path = DEFAULT_FEEDBACK_PATH,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // best-effort — feedback logging must never throw
  }
}

// ---------------------------------------------------------------------------
// Intent inference helpers
// ---------------------------------------------------------------------------

/** Keyword lists that signal each intent bucket. */
const INTENT_KEYWORDS: Record<IntentBucket, RegExp> = {
  refactor: /\b(refactor|rename|move|extract|inline|simplify|clean\s*up|reorganize|restructure)\b/i,
  feature: /\b(add|implement|build|create|new\s+feature|introduce|support|enable)\b/i,
  debug: /\b(fix|bug|error|crash|fail|broken|issue|problem|debug|diagnose|trace)\b/i,
  read: /\b(read|show|display|open|view|print|list|what\s+is|what\s+does|explain)\b/i,
  search: /\b(find|search|grep|look\s+for|where\s+is|which\s+files?|locate)\b/i,
  test: /\b(test|spec|coverage|assert|check|verify|validate|unit\s+test|integration)\b/i,
  other: /.*/,
};

/** Per-intent base confidences for common tools. */
const INTENT_TOOL_WEIGHTS: Record<
  IntentBucket,
  Array<{ toolName: string; weight: number; rationale: string }>
> = {
  refactor: [
    { toolName: "Read", weight: 0.90, rationale: "Refactor needs to read source files" },
    { toolName: "Grep", weight: 0.85, rationale: "Find all usages of target symbol" },
    { toolName: "Glob", weight: 0.75, rationale: "Discover files in scope" },
    { toolName: "Edit", weight: 0.70, rationale: "Apply the refactoring edits" },
    { toolName: "Bash", weight: 0.50, rationale: "Run type-check / linter after edit" },
  ],
  feature: [
    { toolName: "Read", weight: 0.85, rationale: "Understand existing code patterns" },
    { toolName: "Glob", weight: 0.80, rationale: "Locate related files" },
    { toolName: "Grep", weight: 0.70, rationale: "Find extension points and interfaces" },
    { toolName: "Edit", weight: 0.65, rationale: "Implement the feature" },
    { toolName: "Bash", weight: 0.55, rationale: "Run tests after implementation" },
  ],
  debug: [
    { toolName: "Bash", weight: 0.88, rationale: "Run failing code / reproduce issue" },
    { toolName: "Read", weight: 0.82, rationale: "Inspect error-related source files" },
    { toolName: "Grep", weight: 0.75, rationale: "Find error messages and stack frames" },
    { toolName: "Glob", weight: 0.50, rationale: "Scan for related test or log files" },
  ],
  read: [
    { toolName: "Read", weight: 0.92, rationale: "Directly reads the requested file" },
    { toolName: "Glob", weight: 0.65, rationale: "May need to locate the file first" },
    { toolName: "Grep", weight: 0.55, rationale: "May search for relevant content" },
  ],
  search: [
    { toolName: "Grep", weight: 0.92, rationale: "Direct search across files" },
    { toolName: "Glob", weight: 0.85, rationale: "Pattern-match file names" },
    { toolName: "Read", weight: 0.60, rationale: "Read files matching the search" },
  ],
  test: [
    { toolName: "Bash", weight: 0.90, rationale: "Run the test suite" },
    { toolName: "Read", weight: 0.75, rationale: "Read test and source files" },
    { toolName: "Glob", weight: 0.65, rationale: "Find test files" },
    { toolName: "Grep", weight: 0.55, rationale: "Search for test patterns" },
    { toolName: "Edit", weight: 0.50, rationale: "Write / update test files" },
  ],
  other: [
    { toolName: "Read", weight: 0.60, rationale: "Generic read operation likely" },
    { toolName: "Bash", weight: 0.50, rationale: "Generic shell command possible" },
  ],
};

/** Tools that recently appeared in history should get a recency bonus. */
const RECENCY_BONUS = 0.08;
/** Width of the 90% CI: confidence ± HALF_CI */
const HALF_CI = 0.10;

// ---------------------------------------------------------------------------
// Recent tool history analysis
// ---------------------------------------------------------------------------

interface RecentToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

/**
 * Given recent tool history, derive file-path hints that can be used to
 * pre-warm the Read cache.
 */
function extractFileHints(history: RecentToolCall[]): string[] {
  const paths = new Set<string>();

  for (const tc of history.slice(-10)) {
    // Paths from Read/Edit inputs
    const fp = tc.input["file_path"];
    if (typeof fp === "string" && fp) paths.add(fp);

    // Paths from Glob results (first few lines)
    if (tc.name === "Glob" && typeof tc.result === "string") {
      for (const line of tc.result.split("\n").slice(0, 5)) {
        const trimmed = line.trim();
        if (trimmed) paths.add(trimmed);
      }
    }

    // Paths extracted from Grep results (lines starting with /)
    if (tc.name === "Grep" && typeof tc.result === "string") {
      for (const line of tc.result.split("\n").slice(0, 5)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("/")) {
          // "path:line:content" → extract path
          const colonIdx = trimmed.indexOf(":");
          paths.add(colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed);
        }
      }
    }
  }

  return [...paths].slice(0, 8);
}

// ---------------------------------------------------------------------------
// SpeculationIntentPredictor
// ---------------------------------------------------------------------------

export class SpeculationIntentPredictor {
  private readonly feedbackPath: string;

  constructor(feedbackPath = DEFAULT_FEEDBACK_PATH) {
    this.feedbackPath = feedbackPath;
  }

  // -------------------------------------------------------------------------
  // Primary API
  // -------------------------------------------------------------------------

  /**
   * Analyze the user message + recent tool history and return tool predictions.
   *
   * @param message    The raw user message text for this turn.
   * @param history    Recent tool calls (from the last N turns, newest last).
   */
  predict(
    message: string,
    history: RecentToolCall[] = [],
  ): PredictionResult {
    const t0 = Date.now();

    // 1. Infer intent bucket
    const { intent, intentConfidence } = this._inferIntent(message);

    // 2. Get base weights for this intent
    const baseWeights = INTENT_TOOL_WEIGHTS[intent];

    // 3. Build a set of recently used tool names for the recency bonus
    const recentToolNames = new Set(history.slice(-5).map((tc) => tc.name));

    // 4. Score each tool
    const fileHints = extractFileHints(history);

    const predictions: ToolPrediction[] = baseWeights.map((w) => {
      // Apply recency bonus if this tool appeared recently
      const recencyAdj = recentToolNames.has(w.toolName) ? RECENCY_BONUS : 0;
      const raw = Math.min(1.0, w.weight + recencyAdj);

      // Scale by intent confidence
      const confidence = Math.round(raw * intentConfidence * 1000) / 1000;

      const pred: ToolPrediction = {
        toolName: w.toolName,
        confidence,
        confidenceLo: Math.max(0, Math.round((confidence - HALF_CI) * 1000) / 1000),
        confidenceHi: Math.min(1, Math.round((confidence + HALF_CI) * 1000) / 1000),
        rationale: w.rationale,
      };

      // Attach file hints for Read tool when we have paths
      if (w.toolName === "Read" && fileHints.length > 0) {
        pred.inputHints = { file_path: fileHints[0] };
      }

      return pred;
    });

    // 5. Sort descending by confidence
    predictions.sort((a, b) => b.confidence - a.confidence);

    return {
      intent,
      intentConfidence,
      predictions,
      latencyMs: Date.now() - t0,
    };
  }

  /**
   * After a prediction was made and the batcher attempted to warm the cache,
   * call this to record the outcome and update telemetry.
   *
   * @param prediction       The original prediction
   * @param toolName         Which tool was actually called
   * @param cacheHit         Whether the speculation cache had a result
   * @param latencySavedMs   Latency saved (0 on miss)
   * @param messageSnippet   First 120 chars of the user message
   * @param intent           Intent used for this prediction
   * @param intentConfidence Intent confidence
   */
  async recordOutcome(opts: {
    prediction: ToolPrediction;
    toolName: string;
    cacheHit: boolean;
    latencySavedMs: number;
    messageSnippet: string;
    intent: IntentBucket;
    intentConfidence: number;
  }): Promise<void> {
    const { prediction, toolName, cacheHit, latencySavedMs, messageSnippet, intent, intentConfidence } = opts;

    // A false positive is: we predicted the tool was NOT needed but it was, or
    // we pre-warmed it and the cache miss means we wasted compute.
    const isFalsePositive = !cacheHit && prediction.confidence >= 0.75;

    _updateTelemetry(cacheHit, latencySavedMs, isFalsePositive);

    if (cacheHit) {
      await logSpeculationFeedback(
        {
          timestamp: new Date().toISOString(),
          intent,
          intentConfidence,
          predictedTool: prediction.toolName,
          predictedConfidence: prediction.confidence,
          cacheHit: true,
          latencySavedMs,
          messageSnippet: messageSnippet.slice(0, 120),
        },
        this.feedbackPath,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Intent inference
  // -------------------------------------------------------------------------

  private _inferIntent(message: string): {
    intent: IntentBucket;
    intentConfidence: number;
  } {
    const buckets: IntentBucket[] = [
      "refactor",
      "feature",
      "debug",
      "read",
      "search",
      "test",
    ];

    let best: IntentBucket = "other";
    let bestScore = 0;
    let secondScore = 0;

    for (const bucket of buckets) {
      const re = INTENT_KEYWORDS[bucket];
      const matches = message.match(re);
      if (matches) {
        // Score by number of keyword matches (more = higher confidence)
        const score = matches.length;
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          best = bucket;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
    }

    if (bestScore === 0) {
      return { intent: "other", intentConfidence: 0.5 };
    }

    // Confidence: high when one bucket clearly dominates
    // Base = 0.65; bonus for each additional match; penalized when second is close
    const dominance = secondScore > 0 ? bestScore / (bestScore + secondScore) : 1.0;
    const intentConfidence = Math.min(
      0.95,
      Math.round((0.65 + dominance * 0.3) * 100) / 100,
    );

    return { intent: best, intentConfidence };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _globalPredictor: SpeculationIntentPredictor | null = null;

export function getGlobalSpeculationPredictor(): SpeculationIntentPredictor {
  if (!_globalPredictor) {
    _globalPredictor = new SpeculationIntentPredictor();
  }
  return _globalPredictor;
}

// ---------------------------------------------------------------------------
// Proposal formatter (used by /speculate command)
// ---------------------------------------------------------------------------

export function formatPredictionProposal(result: PredictionResult): string {
  const pct = Math.round(result.intentConfidence * 100);
  const lines: string[] = [
    `Intent: ${result.intent}  (${pct}% confidence)`,
    "",
    "Next-tool predictions:",
    "  Tool                Confidence  CI Range     Rationale",
    "  " + "─".repeat(70),
  ];

  for (const p of result.predictions) {
    const conf = `${Math.round(p.confidence * 100)}%`.padStart(10);
    const lo = Math.round(p.confidenceLo * 100);
    const hi = Math.round(p.confidenceHi * 100);
    const ci = `[${lo}%–${hi}%]`.padEnd(12);
    const name = p.toolName.padEnd(20);
    lines.push(`  ${name}${conf}  ${ci} ${p.rationale}`);
  }

  lines.push("");
  lines.push(
    `Prediction latency: ${result.latencyMs}ms`,
  );

  const t = getSpeculationTelemetry();
  if (t.predictions > 0) {
    lines.push(
      `Session telemetry: ${t.hitRatePct}% hit rate · ${t.avgLatencySavedMs}ms avg saved · ${t.falsePositiveRatePct}% false-positive`,
    );
  }

  return lines.join("\n");
}
