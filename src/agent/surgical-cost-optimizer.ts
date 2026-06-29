/**
 * Surgical Cost Optimizer — cost-aware tier promotion scoring for surgical mode.
 *
 * Tracks per-tool cost and latency metrics over a rolling 100-call window, then
 * computes a `promotionScore()` that weighs the capability gain of moving to a
 * higher tier against the additional cost + latency that the new tier brings.
 *
 * Decision rule (from spec):
 *   Promote only if:
 *     (new_capability_value > cost_penalty * PROMOTION_MULTIPLIER)
 *       AND confidence > 0.75
 *     OR cost_penalty < FREE_PROMOTION_THRESHOLD
 *
 * Where:
 *   PROMOTION_MULTIPLIER  = 2.5  (benefit must outweigh cost by 2.5×)
 *   FREE_PROMOTION_THRESHOLD = $0.01 per call (essentially free — always promote)
 *
 * Integration:
 *   - Imported by surgical-scope.ts to feed cost scores into tier decisions.
 *   - Exposed via `/surgical cost-analysis` command (agent.ts).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SurgicalTier = 1 | 2 | 3 | 4;

/**
 * Rolling cost+latency metrics for a single tool over the last 100 calls.
 */
export interface ToolCostMetric {
  /** Tool name as registered (e.g. "Bash", "Edit", "Read"). */
  toolName: string;
  /** Average USD cost per call over the window. 0 for free tools. */
  avgCostUsd: number;
  /** Number of calls in the current window (max 100). */
  callCount: number;
  /** P50 latency in milliseconds. */
  p50Ms: number;
  /** P95 latency in milliseconds. */
  p95Ms: number;
  /** P99 latency in milliseconds. */
  p99Ms: number;
  /** Timestamp of the last recorded call (ms since epoch). */
  lastUpdatedAt: number;
}

/**
 * A single recorded tool call used to compute rolling metrics.
 */
export interface ToolCallRecord {
  toolName: string;
  costUsd: number;
  durationMs: number;
  at: number;
}

/**
 * Per-tier aggregate cost summary derived from the tools available at that tier.
 */
export interface TierCostSummary {
  tier: SurgicalTier;
  /** Average total cost per agent call when operating at this tier. */
  avgCallCostUsd: number;
  /** P95 latency for tools at this tier. */
  p95LatencyMs: number;
  /** Names of tools available at this tier (and above). */
  availableTools: string[];
}

/**
 * Result of a tier promotion score calculation.
 */
export interface PromotionScoreResult {
  /** Source tier being evaluated for promotion. */
  fromTier: SurgicalTier;
  /** Target tier to potentially promote to. */
  toTier: SurgicalTier;
  /** Estimated additional USD cost per call if promoted. */
  costDeltaUsd: number;
  /** Estimated capability gain [0–1] from promotion (quality delta). */
  capabilityGain: number;
  /** Confidence in the capability gain estimate [0–1]. */
  confidence: number;
  /**
   * Final numeric score. Positive = promote, negative = stay.
   * Score = capabilityGain - (costDeltaUsd * PROMOTION_MULTIPLIER * 100)
   * (cost is scaled to the same units as gain via a normalization factor)
   */
  score: number;
  /** Whether the promotion decision rule recommends promoting. */
  shouldPromote: boolean;
  /** Human-readable reason for the decision. */
  reasoning: string;
}

/**
 * Full cost-analysis report for the `/surgical cost-analysis` command.
 */
export interface CostAnalysisReport {
  /** Summaries for each tier. */
  tierSummaries: TierCostSummary[];
  /** Promotion opportunity scores for each tier boundary. */
  promotionScores: PromotionScoreResult[];
  /** ISO timestamp of the report. */
  generatedAt: string;
  /** Total calls recorded across all tools in the window. */
  totalCallsTracked: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Capability gain must exceed cost penalty by this multiplier to promote. */
const PROMOTION_MULTIPLIER = 2.5;

/**
 * If cost delta is below this threshold (USD/call), always promote regardless
 * of capability gain — the cost is negligible.
 */
const FREE_PROMOTION_THRESHOLD = 0.01;

/** Confidence minimum to allow promotion (unless cost is negligible). */
const CONFIDENCE_THRESHOLD = 0.75;

/** Rolling window size (max recorded calls per tool). */
const WINDOW_SIZE = 100;

// ---------------------------------------------------------------------------
// Tool-to-tier mapping
// ---------------------------------------------------------------------------

/**
 * Tools unlocked at each tier (additive — higher tiers include lower tier tools).
 *
 *   Tier 1 (micro):    Read, Glob, Grep, LS
 *   Tier 2 (fine):     + Edit (single-file)
 *   Tier 3 (balanced): + Bash (safe patterns), Write (multi-file)
 *   Tier 4 (broad):    + Agent, Coordinate (unrestricted Bash)
 */
const TOOLS_BY_TIER: Record<SurgicalTier, string[]> = {
  1: ["Read", "Glob", "Grep", "LS"],
  2: ["Edit"],
  3: ["Bash", "Write"],
  4: ["Agent", "Coordinate"],
};

/**
 * Canonical per-call cost estimates (USD) for tools that have a measurable cost.
 * Most tools are effectively free (compute-bound), but LLM-calling tools
 * (Agent, Coordinate) incur model costs. Values are conservative estimates.
 */
const TOOL_COST_ESTIMATES: Record<string, number> = {
  Read:       0.000,
  Glob:       0.000,
  Grep:       0.000,
  LS:         0.000,
  Edit:       0.000,
  Write:      0.000,
  Bash:       0.005,  // subprocess + possible output tokens
  Agent:      0.025,  // sub-agent LLM call
  Coordinate: 0.030,  // multi-sub-agent orchestration
};

/**
 * Capability gain (quality improvement proxy) from having a given tool available.
 * These are normalized 0–1 estimates based on how much each tool expands what an
 * agent can accomplish.
 */
const TOOL_CAPABILITY_WEIGHTS: Record<string, number> = {
  Read:       0.10,
  Glob:       0.05,
  Grep:       0.08,
  LS:         0.03,
  Edit:       0.25,
  Write:      0.15,
  Bash:       0.20,
  Agent:      0.18,
  Coordinate: 0.12,
};

// ---------------------------------------------------------------------------
// Rolling window store
// ---------------------------------------------------------------------------

/** Per-tool rolling call buffer (max WINDOW_SIZE entries). */
const _callBuffers = new Map<string, ToolCallRecord[]>();

/**
 * Record a tool call into the rolling window.
 * Oldest entries are evicted once the window reaches WINDOW_SIZE.
 */
export function recordToolCall(call: ToolCallRecord): void {
  const buf = _callBuffers.get(call.toolName) ?? [];
  buf.push({ ...call });
  if (buf.length > WINDOW_SIZE) {
    buf.shift();
  }
  _callBuffers.set(call.toolName, buf);
}

/**
 * Reset the rolling window store (for testing).
 */
export function resetToolCallStore(): void {
  _callBuffers.clear();
}

// ---------------------------------------------------------------------------
// ToolCostMetric computation
// ---------------------------------------------------------------------------

/**
 * Compute the percentile value (0–100) from a sorted numeric array.
 * Returns 0 if the array is empty.
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.min(idx, sortedValues.length - 1)]!;
}

/**
 * Compute ToolCostMetric for a tool from its rolling call buffer.
 * Falls back to canonical cost estimates for tools with no recorded calls.
 */
export function getToolCostMetric(toolName: string): ToolCostMetric {
  const buf = _callBuffers.get(toolName) ?? [];

  if (buf.length === 0) {
    // No recorded calls — return canonical estimates
    const canonicalCost = TOOL_COST_ESTIMATES[toolName] ?? 0;
    return {
      toolName,
      avgCostUsd: canonicalCost,
      callCount: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      lastUpdatedAt: 0,
    };
  }

  const costs = buf.map((c) => c.costUsd);
  const durations = [...buf.map((c) => c.durationMs)].sort((a, b) => a - b);
  const avgCost = costs.reduce((s, c) => s + c, 0) / costs.length;

  return {
    toolName,
    avgCostUsd: avgCost,
    callCount: buf.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    lastUpdatedAt: buf[buf.length - 1]!.at,
  };
}

/**
 * Get ToolCostMetrics for all tools in the rolling window store.
 */
export function getAllToolCostMetrics(): ToolCostMetric[] {
  const toolNames = new Set([
    ...Object.keys(TOOL_COST_ESTIMATES),
    ..._callBuffers.keys(),
  ]);
  return [...toolNames].map((name) => getToolCostMetric(name));
}

// ---------------------------------------------------------------------------
// Tier cost summaries
// ---------------------------------------------------------------------------

/**
 * Compute the cumulative cost and latency for a given tier by aggregating
 * the metrics of all tools available up to and including that tier.
 */
export function getTierCostSummary(tier: SurgicalTier): TierCostSummary {
  // Collect all tools available at this tier (all tiers ≤ requested tier)
  const allTools: string[] = [];
  for (let t = 1; t <= tier; t++) {
    allTools.push(...(TOOLS_BY_TIER[t as SurgicalTier] ?? []));
  }

  let totalCost = 0;
  let maxP95 = 0;

  for (const toolName of allTools) {
    const metric = getToolCostMetric(toolName);
    totalCost += metric.avgCostUsd;
    if (metric.p95Ms > maxP95) maxP95 = metric.p95Ms;
  }

  return {
    tier,
    avgCallCostUsd: totalCost,
    p95LatencyMs: maxP95,
    availableTools: [...allTools],
  };
}

/**
 * Get cost summaries for all 4 tiers.
 */
export function getAllTierCostSummaries(): TierCostSummary[] {
  return [1, 2, 3, 4].map((t) => getTierCostSummary(t as SurgicalTier));
}

// ---------------------------------------------------------------------------
// Capability gain estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the capability gain (quality improvement) of moving from one tier
 * to another. This is a normalized 0–1 value computed from the capability
 * weights of newly unlocked tools.
 *
 * The gain is further adjusted by:
 *   - testPassRateDelta: observed improvement in test pass rate at the higher tier
 *   - errorReductionDelta: observed reduction in tool errors at the higher tier
 *
 * Both delta parameters default to 0 (no observed quality data).
 */
export function estimateCapabilityGain(
  fromTier: SurgicalTier,
  toTier: SurgicalTier,
  testPassRateDelta = 0,
  errorReductionDelta = 0,
): number {
  if (toTier <= fromTier) return 0;

  // Sum capability weights of tools newly unlocked in (fromTier, toTier]
  let gain = 0;
  for (let t = fromTier + 1; t <= toTier; t++) {
    const tools = TOOLS_BY_TIER[t as SurgicalTier] ?? [];
    for (const tool of tools) {
      gain += TOOL_CAPABILITY_WEIGHTS[tool] ?? 0;
    }
  }

  // Normalize: maximum possible gain moving from tier 1 to tier 4
  const maxGain = Object.values(TOOL_CAPABILITY_WEIGHTS).reduce((s, v) => s + v, 0)
    - (TOOL_CAPABILITY_WEIGHTS["Read"] ?? 0)
    - (TOOL_CAPABILITY_WEIGHTS["Glob"] ?? 0)
    - (TOOL_CAPABILITY_WEIGHTS["Grep"] ?? 0)
    - (TOOL_CAPABILITY_WEIGHTS["LS"] ?? 0);

  const normalizedGain = maxGain > 0 ? gain / maxGain : 0;

  // Blend with observed quality signals (clamped to [0, 1])
  const qualityBoost = Math.max(0, Math.min(1, testPassRateDelta + errorReductionDelta));
  const combined = normalizedGain * 0.7 + qualityBoost * 0.3;

  return Math.max(0, Math.min(1, combined));
}

// ---------------------------------------------------------------------------
// Core promotion score
// ---------------------------------------------------------------------------

/**
 * Compute a promotion score for moving from `fromTier` to `toTier`.
 *
 * Decision rule (spec):
 *   Promote if:
 *     (capabilityGain > costDelta * PROMOTION_MULTIPLIER) AND confidence > 0.75
 *   OR:
 *     costDelta < FREE_PROMOTION_THRESHOLD
 *
 * @param fromTier            Current tier.
 * @param toTier              Candidate promotion target.
 * @param confidence          Confidence in tier decision [0–1] from intent analyzer.
 * @param testPassRateDelta   Observed pass-rate improvement at toTier vs fromTier [0–1].
 * @param errorReductionDelta Observed error-rate reduction at toTier [0–1].
 */
export function promotionScore(
  fromTier: SurgicalTier,
  toTier: SurgicalTier,
  confidence: number,
  testPassRateDelta = 0,
  errorReductionDelta = 0,
): PromotionScoreResult {
  const fromSummary = getTierCostSummary(fromTier);
  const toSummary = getTierCostSummary(toTier);
  const costDelta = Math.max(0, toSummary.avgCallCostUsd - fromSummary.avgCallCostUsd);

  const capabilityGain = estimateCapabilityGain(fromTier, toTier, testPassRateDelta, errorReductionDelta);

  // Normalized score: capability gain minus scaled cost penalty
  // Cost delta is multiplied by 100 to put USD (~0.01–0.05 range) on the same
  // 0–1 scale as capability gain.
  const costPenaltyNormalized = costDelta * PROMOTION_MULTIPLIER * 100;
  const score = capabilityGain - costPenaltyNormalized;

  // Decision rule
  const isFreePromotion = costDelta < FREE_PROMOTION_THRESHOLD;
  const capabilityExceedsCost = capabilityGain > costDelta * PROMOTION_MULTIPLIER;
  const shouldPromote =
    isFreePromotion ||
    (capabilityExceedsCost && confidence > CONFIDENCE_THRESHOLD);

  // Build reasoning
  const reasonParts: string[] = [];
  reasonParts.push(`Tier ${fromTier}→${toTier}`);
  reasonParts.push(`costDelta=$${costDelta.toFixed(4)}/call`);
  reasonParts.push(`capabilityGain=${(capabilityGain * 100).toFixed(1)}%`);
  reasonParts.push(`confidence=${(confidence * 100).toFixed(0)}%`);

  if (isFreePromotion) {
    reasonParts.push(`cost < $${FREE_PROMOTION_THRESHOLD} threshold → auto-promote`);
  } else if (capabilityExceedsCost && confidence > CONFIDENCE_THRESHOLD) {
    reasonParts.push(`gain > cost×${PROMOTION_MULTIPLIER} AND conf>${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}% → promote`);
  } else if (!capabilityExceedsCost) {
    const neededGain = (costDelta * PROMOTION_MULTIPLIER * 100).toFixed(1);
    reasonParts.push(`gain ${(capabilityGain * 100).toFixed(1)}% < required ${neededGain}% → stay`);
  } else {
    reasonParts.push(`conf ${(confidence * 100).toFixed(0)}% < ${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}% threshold → stay`);
  }

  return {
    fromTier,
    toTier,
    costDeltaUsd: costDelta,
    capabilityGain,
    confidence,
    score,
    shouldPromote,
    reasoning: reasonParts.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Full cost-analysis report
// ---------------------------------------------------------------------------

/**
 * Generate a full cost-analysis report covering all tier summaries and all
 * adjacent-tier promotion scores. Used by `/surgical cost-analysis`.
 *
 * @param confidence        Current session confidence from intent analyzer.
 * @param testPassRateDelta Optional observed test pass rate improvement [0–1].
 * @param errorReductionDelta Optional observed error reduction [0–1].
 */
export function generateCostAnalysisReport(
  confidence = 0.75,
  testPassRateDelta = 0,
  errorReductionDelta = 0,
): CostAnalysisReport {
  const tierSummaries = getAllTierCostSummaries();

  // Compute adjacent-tier promotion scores (1→2, 2→3, 3→4)
  const promotionScores: PromotionScoreResult[] = [];
  for (let from = 1; from <= 3; from++) {
    promotionScores.push(
      promotionScore(
        from as SurgicalTier,
        (from + 1) as SurgicalTier,
        confidence,
        testPassRateDelta,
        errorReductionDelta,
      ),
    );
  }

  const totalCalls = [..._callBuffers.values()].reduce((s, buf) => s + buf.length, 0);

  return {
    tierSummaries,
    promotionScores,
    generatedAt: new Date().toISOString(),
    totalCallsTracked: totalCalls,
  };
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

function fmtUsd(usd: number): string {
  if (usd === 0) return "$0.0000";
  return `$${usd.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  if (ms === 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Format a CostAnalysisReport as a human-readable string for the REPL.
 */
export function formatCostAnalysisReport(report: CostAnalysisReport): string {
  const lines: string[] = [
    "",
    "  ── Surgical Cost Analysis ────────────────────────────────────",
    `  Generated: ${report.generatedAt}`,
    `  Calls tracked: ${report.totalCallsTracked}`,
    "",
    "  Per-Tier Cost Breakdown:",
    "  " + "─".repeat(60),
    "  " + "Tier".padEnd(6) + "Name".padEnd(12) + "Cost/call".padEnd(14) + "P95 latency".padEnd(14) + "Tools",
    "  " + "─".repeat(60),
  ];

  const tierNames: Record<SurgicalTier, string> = {
    1: "micro",
    2: "fine",
    3: "balanced",
    4: "broad",
  };

  for (const summary of report.tierSummaries) {
    const name = tierNames[summary.tier] ?? "?";
    const newTools = TOOLS_BY_TIER[summary.tier] ?? [];
    lines.push(
      "  " +
        `T${summary.tier}`.padEnd(6) +
        name.padEnd(12) +
        fmtUsd(summary.avgCallCostUsd).padEnd(14) +
        fmtMs(summary.p95LatencyMs).padEnd(14) +
        `+[${newTools.join(", ")}]`,
    );
  }

  lines.push("", "  Promotion Opportunities:", "  " + "─".repeat(60));

  for (const ps of report.promotionScores) {
    const decision = ps.shouldPromote ? "PROMOTE" : "STAY";
    const decStyle = ps.shouldPromote ? "  [Y]" : "  [N]";
    lines.push(
      `${decStyle} T${ps.fromTier}→T${ps.toTier}: ${ps.reasoning}`,
    );
    _ = decision; // used for clarity in formatted output above
  }

  lines.push("", "  Legend: [Y]=promote recommended  [N]=stay at current tier", "");
  return lines.join("\n");
}

// Suppress unused variable lint — `decision` assigned for clarity
let _ = "";

// ---------------------------------------------------------------------------
// SurgicalCostOptimizer class
// ---------------------------------------------------------------------------

/**
 * SurgicalCostOptimizer — class API wrapping the functional cost optimizer.
 *
 * Create one instance per surgical session. Call `recordCall()` after each
 * tool execution, then `scorePromotion()` when the tier promoter is considering
 * a tier change.
 */
export class SurgicalCostOptimizer {
  private sessionConfidence: number;
  private testPassRateDelta: number;
  private errorReductionDelta: number;

  constructor(options: {
    confidence?: number;
    testPassRateDelta?: number;
    errorReductionDelta?: number;
  } = {}) {
    this.sessionConfidence = options.confidence ?? 0.75;
    this.testPassRateDelta = options.testPassRateDelta ?? 0;
    this.errorReductionDelta = options.errorReductionDelta ?? 0;
  }

  /** Update the session confidence from the intent analyzer. */
  setConfidence(confidence: number): void {
    this.sessionConfidence = Math.max(0, Math.min(1, confidence));
  }

  /** Update observed quality deltas. */
  setQualityDeltas(testPassRateDelta: number, errorReductionDelta: number): void {
    this.testPassRateDelta = Math.max(0, Math.min(1, testPassRateDelta));
    this.errorReductionDelta = Math.max(0, Math.min(1, errorReductionDelta));
  }

  /** Record a tool call (delegates to module-level store). */
  recordCall(call: ToolCallRecord): void {
    recordToolCall(call);
  }

  /**
   * Score a potential tier promotion.
   * Returns the full PromotionScoreResult including the shouldPromote decision.
   */
  scorePromotion(
    fromTier: SurgicalTier,
    toTier: SurgicalTier,
  ): PromotionScoreResult {
    return promotionScore(
      fromTier,
      toTier,
      this.sessionConfidence,
      this.testPassRateDelta,
      this.errorReductionDelta,
    );
  }

  /** Generate and return the full cost-analysis report. */
  generateReport(): CostAnalysisReport {
    return generateCostAnalysisReport(
      this.sessionConfidence,
      this.testPassRateDelta,
      this.errorReductionDelta,
    );
  }

  /** Format the full report as a display string. */
  formatReport(): string {
    return formatCostAnalysisReport(this.generateReport());
  }
}
