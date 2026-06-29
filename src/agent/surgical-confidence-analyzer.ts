/**
 * TierConfidenceAnalyzer — reads surgical-feedback.jsonl and computes
 * per-goal-pattern success rates, returning structured data for the
 * SurgicalDashboard visualization.
 *
 * A "goal pattern" is extracted from the goal string by detecting the
 * dominant intent keyword (e.g. "refactor", "test", "install", "fix").
 * All feedback entries sharing the same pattern are grouped together and
 * a success rate (accepted / total) is computed.
 *
 * Public API:
 *   - TierConfidenceAnalyzer.analyze() — load feedback + return PatternStats[]
 *   - TierConfidenceAnalyzer.getTierDistribution() — counts per tier label
 *   - TierConfidenceAnalyzer.getRecentDecisions() — last N entries with metadata
 */

import { loadProposalFeedback, type ProposalFeedback } from "./surgical-proposer.ts";
import type { ScopeTier } from "./surgical-scope.ts";

// ── Public types ───────────────────────────────────────────────────────────────

/** Stats for a single goal-pattern bucket. */
export interface PatternStats {
  /** The extracted pattern label, e.g. "refactor", "test", "fix". */
  pattern: string;
  /** Tier the system most often recommends for this pattern. */
  recommendedTier: ScopeTier;
  /** Fraction of times the recommendation was accepted (0–1). */
  successRate: number;
  /** Mean confidence score across all entries in this pattern. */
  confidence: number;
  /** Number of feedback entries in this pattern bucket. */
  sampleSize: number;
}

/** Counts of how many times each tier label appeared as a suggestion. */
export interface TierDistribution {
  narrow: number;
  medium: number;
  wide: number;
  /** Total entries. */
  total: number;
}

/** A single recent tier decision for history display. */
export interface RecentDecision {
  /** ISO timestamp. */
  timestamp: string;
  /** The user's goal (truncated to 60 chars). */
  goal: string;
  /** The extracted goal pattern. */
  pattern: string;
  /** Tier the system suggested. */
  suggestedTier: ScopeTier;
  /** Tier the user actually chose. */
  chosenTier: ScopeTier;
  /** Confidence at proposal time. */
  confidence: number;
  /** Whether the user accepted (true) or overrode (false) the suggestion. */
  accepted: boolean;
  /** Human-readable outcome label. */
  outcome: "accepted" | "overridden" | "unknown";
}

// ── Pattern extraction ─────────────────────────────────────────────────────────

/**
 * Map of keyword → pattern label.
 * Longer keys are checked first so "fix typo" beats "fix".
 */
const PATTERN_KEYWORDS: [string, string][] = [
  ["fix typo", "fix-typo"],
  ["fix failing test", "test"],
  ["fix test", "test"],
  ["add test", "test"],
  ["write test", "test"],
  ["update test", "test"],
  ["refactor", "refactor"],
  ["reorganize", "refactor"],
  ["restructure", "refactor"],
  ["rewrite", "refactor"],
  ["migrate", "migrate"],
  ["install", "install"],
  ["add feature", "feature"],
  ["new feature", "feature"],
  ["implement", "feature"],
  ["add", "add"],
  ["update", "update"],
  ["fix", "fix"],
  ["remove", "remove"],
  ["delete", "remove"],
  ["rename", "rename"],
  ["move", "rename"],
  ["extract", "extract"],
];

/**
 * Extract the dominant goal pattern from a goal string.
 * Returns "other" if no known keyword matches.
 */
export function extractGoalPattern(goal: string): string {
  const lower = goal.toLowerCase();
  for (const [keyword, pattern] of PATTERN_KEYWORDS) {
    if (lower.includes(keyword)) return pattern;
  }
  return "other";
}

// ── TierConfidenceAnalyzer ─────────────────────────────────────────────────────

/**
 * Reads surgical-feedback.jsonl and computes per-pattern confidence statistics
 * suitable for rendering in the SurgicalDashboard.
 */
export class TierConfidenceAnalyzer {
  /**
   * Load all feedback and compute per-pattern success rates.
   * Returns patterns sorted by sampleSize descending (most data first).
   */
  async analyze(): Promise<PatternStats[]> {
    const feedback = await loadProposalFeedback();
    if (feedback.length === 0) return [];

    // Group by pattern
    const groups = new Map<
      string,
      { entries: ProposalFeedback[]; tierCounts: Record<ScopeTier, number> }
    >();

    for (const entry of feedback) {
      const pattern = extractGoalPattern(entry.goal);
      if (!groups.has(pattern)) {
        groups.set(pattern, { entries: [], tierCounts: { narrow: 0, medium: 0, wide: 0 } });
      }
      const group = groups.get(pattern)!;
      group.entries.push(entry);
      group.tierCounts[entry.suggestedTier]++;
    }

    const results: PatternStats[] = [];

    for (const [pattern, group] of groups) {
      const { entries, tierCounts } = group;
      const total = entries.length;
      const accepted = entries.filter((e) => e.outcome === "accepted").length;
      const successRate = total > 0 ? accepted / total : 0;
      const confidence =
        total > 0 ? entries.reduce((s, e) => s + e.suggestedConfidence, 0) / total : 0;

      // Recommended tier = the one suggested most often for this pattern
      const recommendedTier = (
        Object.entries(tierCounts) as [ScopeTier, number][]
      ).sort((a, b) => b[1] - a[1])[0]![0];

      results.push({
        pattern,
        recommendedTier,
        successRate: Math.round(successRate * 100) / 100,
        confidence: Math.round(confidence * 100) / 100,
        sampleSize: total,
      });
    }

    return results.sort((a, b) => b.sampleSize - a.sampleSize);
  }

  /**
   * Compute the distribution of suggested tiers across all feedback.
   */
  async getTierDistribution(): Promise<TierDistribution> {
    const feedback = await loadProposalFeedback();
    const dist: TierDistribution = { narrow: 0, medium: 0, wide: 0, total: feedback.length };
    for (const entry of feedback) {
      dist[entry.suggestedTier]++;
    }
    return dist;
  }

  /**
   * Return the most recent N tier decisions, newest first.
   * Default N = 20.
   */
  async getRecentDecisions(limit = 20): Promise<RecentDecision[]> {
    const feedback = await loadProposalFeedback();
    // Sort newest first
    const sorted = [...feedback].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return sorted.slice(0, limit).map((entry) => ({
      timestamp: entry.timestamp,
      goal: entry.goal.length > 60 ? entry.goal.slice(0, 57) + "..." : entry.goal,
      pattern: extractGoalPattern(entry.goal),
      suggestedTier: entry.suggestedTier,
      chosenTier: entry.chosenTier,
      confidence: entry.suggestedConfidence,
      accepted: entry.outcome === "accepted",
      outcome: entry.outcome,
    }));
  }
}
