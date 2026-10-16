/**
 * Surgical Proposal Retrainer — re-evaluates heuristic weights in SurgicalScope
 * using rolling-window success rates from recorded run outcomes.
 *
 * Runs weekly (cron) or on-demand via `/surgical feedback retrain`. Reads the
 * last 50 run records from the SurgicalFeedbackRecorder and computes per-tier
 * accuracy metrics. If accuracy for a tier is below threshold, it emits
 * recommended weight adjustments that can be applied to the heuristic scorer in
 * surgical-proposer.ts.
 *
 * Feature-gated by FEATURE_SURGICAL_RETRAINING (AC_FEATURE_SURGICAL_RETRAINING=true).
 *
 * Design notes:
 *   - We do NOT mutate the hard-coded signal lists in surgical-scope.ts at runtime.
 *     Instead, we compute scalar bias adjustments (–0.2 to +0.2) per tier that
 *     the proposer can add to its base heuristic scores. This keeps the signal
 *     lists as the source of truth while allowing continuous calibration.
 *   - Adjustments are written to ~/.ashlrcode/surgical-weights.json.
 *   - The proposer reads this file at startup (if FEATURE_SURGICAL_RETRAINING=true)
 *     and applies the biases to its base heuristic scores.
 */

import { join } from "path";
import { homedir } from "os";
import type { ScopeTier } from "./surgical-scope.ts";
import type { SurgicalRunRecord } from "./surgical-feedback-recorder.ts";
import { SurgicalFeedbackRecorder } from "./surgical-feedback-recorder.ts";

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Per-tier bias adjustments computed by the retrainer.
 * Each value is in [–0.2, +0.2]; positive = boost this tier's score.
 */
export interface TierBiasWeights {
  narrow: number;
  medium: number;
  wide: number;
  /** ISO timestamp of last retraining run. */
  lastRetrained: string;
  /** Number of records used for this training run. */
  sampleSize: number;
  /** Per-tier accuracy rates that drove these weights (0–1). */
  tierAccuracy: Record<ScopeTier, number>;
}

/** Default weights (no adjustment). */
export const DEFAULT_WEIGHTS: TierBiasWeights = {
  narrow: 0,
  medium: 0,
  wide: 0,
  lastRetrained: new Date(0).toISOString(),
  sampleSize: 0,
  tierAccuracy: { narrow: 0, medium: 0, wide: 0 },
};

/** Retraining result returned by ProposalRetrainer.retrain(). */
export interface RetrainingResult {
  /** Whether retraining produced any non-zero weight changes. */
  changed: boolean;
  /** Previous weights (before this run). */
  previous: TierBiasWeights;
  /** New weights (after this run). */
  updated: TierBiasWeights;
  /** Human-readable summary. */
  summary: string;
  /** Number of records analysed. */
  sampleSize: number;
}

// ── Weight file path ──────────────────────────────────────────────────────────

export function getWeightsFilePath(): string {
  return join(homedir(), ".ashlrcode", "surgical-weights.json");
}

// ── ProposalRetrainer ─────────────────────────────────────────────────────────

/**
 * Retrainer that analyses rolling-window run records and adjusts per-tier bias
 * weights for the heuristic proposer.
 *
 * Algorithm:
 *   1. Load last N records (default: 50).
 *   2. For each tier T, compute accuracy = correct_T / proposed_T.
 *   3. If accuracy_T < LOW_THRESHOLD  → increase bias for T by STEP.
 *   4. If accuracy_T > HIGH_THRESHOLD → decrease bias for T by STEP (avoid over-proposing).
 *   5. Clamp each bias to [–MAX_BIAS, +MAX_BIAS].
 *   6. Persist to ~/.ashlrcode/surgical-weights.json.
 */
export class ProposalRetrainer {
  private static readonly WINDOW = 50;
  private static readonly LOW_THRESHOLD = 0.5; // below this → boost tier
  private static readonly HIGH_THRESHOLD = 0.8; // above this → slight penalty (over-proposing)
  private static readonly STEP = 0.05;
  private static readonly MAX_BIAS = 0.2;

  private readonly recorder: SurgicalFeedbackRecorder;
  private readonly weightsPath: string;

  constructor(recorder?: SurgicalFeedbackRecorder, weightsPath?: string) {
    this.recorder = recorder ?? new SurgicalFeedbackRecorder();
    this.weightsPath = weightsPath ?? getWeightsFilePath();
  }

  /**
   * Run a retraining pass using the most recent WINDOW run records.
   * Persists updated weights to disk and returns a result summary.
   */
  async retrain(): Promise<RetrainingResult> {
    const records = await this.recorder.loadRecent(ProposalRetrainer.WINDOW);
    const previous = await this.loadWeights();

    if (records.length < 5) {
      return {
        changed: false,
        previous,
        updated: previous,
        summary: `Insufficient data: ${records.length} records (need ≥5).`,
        sampleSize: records.length,
      };
    }

    // Compute per-tier accuracy
    const tierAccuracy = this._computeTierAccuracy(records);

    // Build new biases from previous + delta
    const updated: TierBiasWeights = {
      narrow: this._adjustBias(previous.narrow, tierAccuracy.narrow),
      medium: this._adjustBias(previous.medium, tierAccuracy.medium),
      wide: this._adjustBias(previous.wide, tierAccuracy.wide),
      lastRetrained: new Date().toISOString(),
      sampleSize: records.length,
      tierAccuracy,
    };

    const changed =
      updated.narrow !== previous.narrow ||
      updated.medium !== previous.medium ||
      updated.wide !== previous.wide;

    if (changed) {
      await this._saveWeights(updated);
    }

    return {
      changed,
      previous,
      updated,
      summary: this._buildSummary(previous, updated, tierAccuracy, records.length),
      sampleSize: records.length,
    };
  }

  /**
   * Load saved weights from disk. Returns DEFAULT_WEIGHTS if file is missing
   * or unparseable.
   */
  async loadWeights(): Promise<TierBiasWeights> {
    try {
      const { readFile } = await import("fs/promises");
      const raw = await readFile(this.weightsPath, { encoding: "utf8" });
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "narrow" in parsed) {
        return {
          narrow: Number(parsed.narrow) || 0,
          medium: Number(parsed.medium) || 0,
          wide: Number(parsed.wide) || 0,
          lastRetrained: String(parsed.lastRetrained ?? new Date(0).toISOString()),
          sampleSize: Number(parsed.sampleSize) || 0,
          tierAccuracy: {
            narrow: Number(parsed.tierAccuracy?.narrow) || 0,
            medium: Number(parsed.tierAccuracy?.medium) || 0,
            wide: Number(parsed.tierAccuracy?.wide) || 0,
          },
        };
      }
    } catch {
      // File doesn't exist or is corrupt — return defaults
    }
    return { ...DEFAULT_WEIGHTS };
  }

  /**
   * Format a RetrainingResult for display in `/surgical feedback retrain`.
   */
  formatResult(result: RetrainingResult): string {
    const lines = [
      "",
      "  ── Surgical Proposal Retrainer ──────────────────────────",
      `  Sample size:      ${result.sampleSize} run records`,
    ];

    if (!result.changed) {
      lines.push(`  Result:           ${result.summary}`);
      lines.push("");
      return lines.join("\n");
    }

    const { previous: p, updated: u } = result;
    const fmt = (v: number) => (v >= 0 ? `+${(v * 100).toFixed(0)}%` : `${(v * 100).toFixed(0)}%`);
    const delta = (prev: number, next: number) => {
      const d = next - prev;
      if (Math.abs(d) < 0.001) return "(no change)";
      return d > 0 ? `↑ ${fmt(d)}` : `↓ ${fmt(d)}`;
    };

    lines.push(
      "  Tier accuracy:",
      `    narrow:   ${Math.round(u.tierAccuracy.narrow * 100)}%`,
      `    medium:   ${Math.round(u.tierAccuracy.medium * 100)}%`,
      `    wide:     ${Math.round(u.tierAccuracy.wide * 100)}%`,
      "",
      "  Weight adjustments:",
      `    narrow:   ${fmt(p.narrow)} → ${fmt(u.narrow)}  ${delta(p.narrow, u.narrow)}`,
      `    medium:   ${fmt(p.medium)} → ${fmt(u.medium)}  ${delta(p.medium, u.medium)}`,
      `    wide:     ${fmt(p.wide)} → ${fmt(u.wide)}  ${delta(p.wide, u.wide)}`,
      "",
      `  ${result.summary}`,
      "",
    );

    return lines.join("\n");
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Compute per-tier accuracy: for each tier T, what fraction of the runs
   * that proposed T actually ended up executing T?
   * Returns 0 for tiers with no proposals.
   */
  private _computeTierAccuracy(
    records: SurgicalRunRecord[],
  ): Record<ScopeTier, number> {
    const proposed: Record<ScopeTier, number> = { narrow: 0, medium: 0, wide: 0 };
    const correct: Record<ScopeTier, number> = { narrow: 0, medium: 0, wide: 0 };

    for (const r of records) {
      proposed[r.proposedTier]++;
      if (r.proposedTier === r.actualTier) {
        correct[r.proposedTier]++;
      }
    }

    return {
      narrow: proposed.narrow > 0 ? correct.narrow / proposed.narrow : 0,
      medium: proposed.medium > 0 ? correct.medium / proposed.medium : 0,
      wide: proposed.wide > 0 ? correct.wide / proposed.wide : 0,
    };
  }

  /** Adjust a single tier's bias based on its accuracy. */
  private _adjustBias(current: number, accuracy: number): number {
    let delta = 0;
    if (accuracy < ProposalRetrainer.LOW_THRESHOLD) {
      delta = ProposalRetrainer.STEP; // boost: proposer under-proposes this tier
    } else if (accuracy > ProposalRetrainer.HIGH_THRESHOLD) {
      delta = -ProposalRetrainer.STEP * 0.5; // slight penalty: proposer over-proposes
    }
    const next = current + delta;
    // Clamp to [−MAX_BIAS, +MAX_BIAS]
    return (
      Math.round(
        Math.max(-ProposalRetrainer.MAX_BIAS, Math.min(ProposalRetrainer.MAX_BIAS, next)) * 1000,
      ) / 1000
    );
  }

  private _buildSummary(
    prev: TierBiasWeights,
    updated: TierBiasWeights,
    accuracy: Record<ScopeTier, number>,
    n: number,
  ): string {
    const changes: string[] = [];
    for (const tier of ["narrow", "medium", "wide"] as ScopeTier[]) {
      const d = updated[tier] - prev[tier];
      if (Math.abs(d) > 0.001) {
        changes.push(`${tier} ${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}%`);
      }
    }
    if (changes.length === 0) return `No changes needed (n=${n}; all tiers within target accuracy).`;
    return `Adjusted weights: ${changes.join(", ")} (n=${n}).`;
  }

  private async _saveWeights(weights: TierBiasWeights): Promise<void> {
    const dir = this.weightsPath.substring(0, this.weightsPath.lastIndexOf("/"));
    try {
      const { mkdir, writeFile } = await import("fs/promises");
      await mkdir(dir, { recursive: true });
      await writeFile(this.weightsPath, JSON.stringify(weights, null, 2), { encoding: "utf8" });
    } catch {
      // Silently ignore — weight persistence must never break the main UX
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _globalRetrainer: ProposalRetrainer | null = null;

/** Get (or lazily create) the global ProposalRetrainer. */
export function getGlobalRetrainer(): ProposalRetrainer {
  if (!_globalRetrainer) {
    _globalRetrainer = new ProposalRetrainer();
  }
  return _globalRetrainer;
}

/**
 * Load the current saved weights (or defaults if not yet trained).
 * Convenience wrapper used by surgical-proposer.ts to apply bias at proposal time.
 */
export async function loadCurrentWeights(): Promise<TierBiasWeights> {
  return getGlobalRetrainer().loadWeights();
}
