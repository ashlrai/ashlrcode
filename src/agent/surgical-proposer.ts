/**
 * Surgical Mode Intent-to-Tier Auto-Proposal with Confidence Scoring.
 *
 * Provides a proactive tier recommender for surgical mode that:
 *
 *   1. Given a user goal, calls an LLM with goal + codebase context
 *      (file count, recent edits, scope patterns) to score each tier.
 *   2. Returns { tier: 'medium', confidence: 0.92, reasoning: '...' }
 *      with a ScopeTier label (narrow / medium / wide).
 *   3. Suggests a tier but allows user override via `/surgical narrow|medium|wide`.
 *   4. On override, logs feedback tuple
 *      (goal, suggested_tier, chosen_tier, outcome) to
 *      ~/.ashlrcode/surgical-feedback.jsonl for future fine-tuning.
 *   5. `/surgical stats` shows suggestion accuracy (how often confidence matched).
 *
 * Integration points:
 *   - `proposeTierForGoal(goal, context)` — main entry; uses heuristic scorer
 *     as deterministic fallback when no LLM client is attached.
 *   - `proposeTierWithLLM(goal, context, llmClient)` — LLM-powered path.
 *   - `logProposalFeedback(fb)` — append feedback tuple to JSONL file.
 *   - `loadProposalFeedback()` — read all feedback for stats.
 *   - `computeProposalStats(feedback)` — accuracy / calibration metrics.
 */

import { join } from "path";
import { homedir } from "os";
import { analyzeIntent } from "./surgical-intent-analyzer.ts";
import { analyzeScopeFromIntent } from "./surgical-scope.ts";
import type { ScopeTier } from "./surgical-scope.ts";
import type { SurgicalTier } from "../tools/guards/surgical-tier-promoter.ts";

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Per-tier confidence score returned by the LLM scorer.
 * Each field is a 0–1 float; they need not sum to 1.
 */
export interface TierScores {
  narrow: number;
  medium: number;
  wide: number;
}

/**
 * Full proposal returned by `proposeTierForGoal` and `proposeTierWithLLM`.
 *
 * The `tier` field uses the ScopeTier label (narrow/medium/wide) aligned
 * with the `/surgical` command UI; `numericTier` is the 1–4 value used by
 * the surgical gate.
 */
export interface SurgicalProposal {
  /** Recommended scope tier label. */
  tier: ScopeTier;
  /** Equivalent 1–4 numeric tier (1=narrow, 2–3=medium, 4=wide). */
  numericTier: SurgicalTier;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Human-readable explanation shown to the user. */
  reasoning: string;
  /** Per-tier raw scores for transparency. */
  scores: TierScores;
  /** Whether the proposal was derived from an LLM call vs. heuristics. */
  source: "llm" | "heuristic";
}

/**
 * Codebase context passed to the tier proposer.
 * All fields are optional; richer context = better proposals.
 */
export interface CodebaseContext {
  /** Total number of source files in the project. */
  fileCount?: number;
  /** Paths of recently edited files (last N commits). */
  recentEdits?: string[];
  /** Free-form text describing the codebase (e.g. git diff summary). */
  description?: string;
  /** Current working directory. */
  cwd?: string;
}

/**
 * Feedback tuple logged when a user overrides the proposed tier.
 * Used for offline accuracy analysis and future fine-tuning.
 */
export interface ProposalFeedback {
  /** ISO timestamp of the override event. */
  timestamp: string;
  /** The user's stated goal. */
  goal: string;
  /** The tier the system proposed. */
  suggestedTier: ScopeTier;
  /** The confidence the system had at proposal time. */
  suggestedConfidence: number;
  /** The tier the user actually chose (may equal suggestedTier if accepted). */
  chosenTier: ScopeTier;
  /**
   * Outcome reported after the session:
   *   "accepted"  — user kept the suggested tier
   *   "overridden" — user chose a different tier
   *   "unknown"   — outcome not yet recorded
   */
  outcome: "accepted" | "overridden" | "unknown";
  /** Optional numeric tier the user chose. */
  chosenNumericTier?: SurgicalTier;
}

/**
 * Aggregated accuracy/calibration statistics over a set of feedback entries.
 */
export interface ProposalStats {
  /** Total feedback entries. */
  total: number;
  /** Entries where user accepted the suggestion. */
  accepted: number;
  /** Entries where user overrode the suggestion. */
  overridden: number;
  /** Acceptance rate (accepted / total). */
  acceptanceRate: number;
  /** Mean confidence across all entries. */
  meanConfidence: number;
  /**
   * Calibration: mean confidence for accepted entries vs overridden entries.
   * A well-calibrated proposer has higher mean confidence for accepted entries.
   */
  meanConfidenceAccepted: number;
  meanConfidenceOverridden: number;
  /** Breakdown of how often each tier was suggested. */
  tierSuggestionCounts: Record<ScopeTier, number>;
  /** Breakdown of how often each tier was chosen. */
  tierChoiceCounts: Record<ScopeTier, number>;
}

// ── LLM client interface (thin abstraction) ───────────────────────────────────

/**
 * Minimal LLM client interface.  Any concrete provider can implement this
 * (Anthropic, OpenAI, Grok, etc.) without coupling to a specific SDK.
 */
export interface LLMClient {
  /**
   * Generate a text completion.
   * @param prompt  The full prompt to send.
   * @returns The raw text response from the model.
   */
  complete(prompt: string): Promise<string>;
}

// ── Heuristic scoring ─────────────────────────────────────────────────────────

/**
 * Build per-tier heuristic scores from intent analysis + codebase context.
 * This is used both as a standalone scorer and as the fallback when no LLM
 * client is available.
 */
function scoreHeuristic(goal: string, ctx: CodebaseContext): TierScores {
  const intentResult = analyzeIntent(goal, []);
  const scopeResult = analyzeScopeFromIntent(goal, ctx.description ?? "");

  // Base scores from intent analysis tier
  const tierToScores: Record<SurgicalTier, TierScores> = {
    1: { narrow: 0.85, medium: 0.10, wide: 0.05 },
    2: { narrow: 0.70, medium: 0.25, wide: 0.05 },
    3: { narrow: 0.10, medium: 0.75, wide: 0.15 },
    4: { narrow: 0.05, medium: 0.15, wide: 0.80 },
  };

  const scores = { ...tierToScores[intentResult.tier] };

  // Adjust based on codebase context
  const fileCount = ctx.fileCount ?? 0;
  const recentEditCount = ctx.recentEdits?.length ?? 0;

  if (fileCount > 200) {
    // Large codebase → lean toward medium/wide
    scores.narrow = Math.max(0.05, scores.narrow - 0.10);
    scores.medium = Math.min(0.95, scores.medium + 0.05);
    scores.wide = Math.min(0.95, scores.wide + 0.05);
  } else if (fileCount > 0 && fileCount <= 20) {
    // Small codebase → narrow ops are more reasonable
    scores.narrow = Math.min(0.95, scores.narrow + 0.05);
  }

  if (recentEditCount >= 5) {
    // Many recent edits → likely medium/wide scope
    scores.narrow = Math.max(0.05, scores.narrow - 0.08);
    scores.medium = Math.min(0.95, scores.medium + 0.05);
    scores.wide = Math.min(0.95, scores.wide + 0.03);
  }

  // Cross-validate with scope analysis confidence
  if (scopeResult.suggestedTier === "narrow") {
    scores.narrow = Math.min(0.95, scores.narrow + scopeResult.confidence * 0.10);
  } else if (scopeResult.suggestedTier === "medium") {
    scores.medium = Math.min(0.95, scores.medium + scopeResult.confidence * 0.10);
  } else if (scopeResult.suggestedTier === "wide") {
    scores.wide = Math.min(0.95, scores.wide + scopeResult.confidence * 0.10);
  }

  // Normalize to ensure scores are in [0, 1]
  const clamp = (v: number) => Math.max(0.01, Math.min(0.99, v));
  return {
    narrow: clamp(scores.narrow),
    medium: clamp(scores.medium),
    wide: clamp(scores.wide),
  };
}

/** Pick the winning tier from scores and build a SurgicalProposal. */
function buildProposalFromScores(
  scores: TierScores,
  goal: string,
  ctx: CodebaseContext,
  source: "llm" | "heuristic",
): SurgicalProposal {
  // Pick winning tier by highest score
  const entries = (Object.entries(scores) as [ScopeTier, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  const winningTier = entries[0]![0];
  const winningScore = entries[0]![1];

  // Map scope tier to numeric tier
  const tierMap: Record<ScopeTier, SurgicalTier> = {
    narrow: 1,
    medium: 3,
    wide: 4,
  };
  const numericTier = tierMap[winningTier];

  // Build reasoning
  const reasonParts: string[] = [];

  const intentResult = analyzeIntent(goal, []);
  if (intentResult.reasoning) {
    reasonParts.push(`Intent analysis: ${intentResult.reasoning}`);
  }

  const ctxParts: string[] = [];
  if (ctx.fileCount !== undefined) {
    ctxParts.push(`${ctx.fileCount} files in project`);
  }
  if (ctx.recentEdits && ctx.recentEdits.length > 0) {
    ctxParts.push(`${ctx.recentEdits.length} recent edits`);
    // Check if edits cluster in related modules
    const dirs = new Set(
      ctx.recentEdits.map((f) => f.split("/").slice(0, -1).join("/")),
    );
    if (dirs.size <= 2) {
      ctxParts.push("touches " + dirs.size + " module(s) — scope contained");
    } else {
      ctxParts.push(`touches ${dirs.size} directories — broader scope`);
    }
  }
  if (ctxParts.length > 0) {
    reasonParts.push(`Context: ${ctxParts.join(", ")}`);
  }

  reasonParts.push(
    `Scores: narrow=${(scores.narrow * 100).toFixed(0)}% medium=${(scores.medium * 100).toFixed(0)}% wide=${(scores.wide * 100).toFixed(0)}%`,
  );

  return {
    tier: winningTier,
    numericTier,
    confidence: Math.round(winningScore * 100) / 100,
    reasoning: reasonParts.join("; "),
    scores,
    source,
  };
}

// ── LLM prompt builder ────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for tier scoring.
 *
 * The prompt instructs the model to return a JSON object with three float
 * fields: `narrow`, `medium`, `wide` — each a probability in [0, 1] indicating
 * how likely that tier is the correct one for this goal.
 */
export function buildTierScoringPrompt(goal: string, ctx: CodebaseContext): string {
  const ctxLines: string[] = [];
  if (ctx.fileCount !== undefined) {
    ctxLines.push(`- Project file count: ${ctx.fileCount}`);
  }
  if (ctx.recentEdits && ctx.recentEdits.length > 0) {
    ctxLines.push(`- Recently edited files (${ctx.recentEdits.length}):`);
    for (const f of ctx.recentEdits.slice(0, 10)) {
      ctxLines.push(`    ${f}`);
    }
  }
  if (ctx.description) {
    ctxLines.push(`- Codebase description: ${ctx.description.slice(0, 500)}`);
  }
  if (ctx.cwd) {
    ctxLines.push(`- Working directory: ${ctx.cwd}`);
  }

  const ctxSection =
    ctxLines.length > 0
      ? `\n## Codebase Context\n${ctxLines.join("\n")}`
      : "";

  return `You are a surgical-mode tier recommender for an AI coding assistant.

## Task
Given the user's goal and codebase context, score each surgical mode tier
with a probability (0.0–1.0) indicating how well that tier fits the goal.

## Tiers
- **narrow** (Tier 1): Read-only exploration or single-token edits (typo fix, rename variable).
  File budget: 1 file. No Bash.
- **medium** (Tier 2–3): Focused edits touching 2–4 related files. May run safe Bash commands.
  File budget: 3 files. Examples: fix failing test, add helper function, update import.
- **wide** (Tier 4): Multi-file refactors, new features, migrations, or system-wide changes.
  File budget: 6+ files. Full tool access.

## User Goal
"${goal}"${ctxSection}

## Instructions
Return ONLY a JSON object (no markdown, no commentary) with three float fields:
{
  "narrow": <0.0–1.0>,
  "medium": <0.0–1.0>,
  "wide": <0.0–1.0>
}

The three scores need not sum to 1.0 — each is an independent probability.
Higher = more likely that tier is appropriate for this goal.`;
}

/**
 * Parse an LLM response into TierScores.
 * Handles both raw JSON and JSON embedded in markdown code blocks.
 * Returns null if the response cannot be parsed.
 */
export function parseLLMTierScores(response: string): TierScores | null {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1]!.trim();
  }

  // Find JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const narrow = Number(parsed.narrow);
    const medium = Number(parsed.medium);
    const wide = Number(parsed.wide);

    if (isNaN(narrow) || isNaN(medium) || isNaN(wide)) return null;

    // Clamp to [0, 1]
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return { narrow: clamp(narrow), medium: clamp(medium), wide: clamp(wide) };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Propose a surgical tier using heuristic scoring (no LLM required).
 *
 * This is the fast-path entry point used when no LLM client is available
 * or when latency is a concern. Results are deterministic for a given input.
 *
 * @param goal  The user's stated goal.
 * @param ctx   Optional codebase context (file count, recent edits, etc.).
 */
export function proposeTierForGoal(
  goal: string,
  ctx: CodebaseContext = {},
): SurgicalProposal {
  const scores = scoreHeuristic(goal, ctx);
  return buildProposalFromScores(scores, goal, ctx, "heuristic");
}

/**
 * Propose a surgical tier using an LLM for richer scoring.
 *
 * Falls back to heuristic scoring if the LLM call fails or returns an
 * unparseable response. The fallback is transparent to the caller — only
 * the `source` field differs.
 *
 * @param goal      The user's stated goal.
 * @param ctx       Optional codebase context.
 * @param llmClient An LLMClient implementation.
 */
export async function proposeTierWithLLM(
  goal: string,
  ctx: CodebaseContext = {},
  llmClient: LLMClient,
): Promise<SurgicalProposal> {
  const prompt = buildTierScoringPrompt(goal, ctx);

  try {
    const response = await llmClient.complete(prompt);
    const scores = parseLLMTierScores(response);

    if (!scores) {
      // LLM returned unparseable response — fall back to heuristic
      const fallbackScores = scoreHeuristic(goal, ctx);
      const proposal = buildProposalFromScores(fallbackScores, goal, ctx, "heuristic");
      proposal.reasoning = `[LLM parse failed, heuristic used] ${proposal.reasoning}`;
      return proposal;
    }

    // Blend LLM scores with heuristic scores (70% LLM, 30% heuristic)
    const heuristicScores = scoreHeuristic(goal, ctx);
    const blended: TierScores = {
      narrow: scores.narrow * 0.7 + heuristicScores.narrow * 0.3,
      medium: scores.medium * 0.7 + heuristicScores.medium * 0.3,
      wide: scores.wide * 0.7 + heuristicScores.wide * 0.3,
    };

    const proposal = buildProposalFromScores(blended, goal, ctx, "llm");
    proposal.reasoning = `[LLM+heuristic blend] ${proposal.reasoning}`;
    return proposal;
  } catch (err) {
    // Network/API error — fall back to heuristic
    const fallbackScores = scoreHeuristic(goal, ctx);
    const proposal = buildProposalFromScores(fallbackScores, goal, ctx, "heuristic");
    const errMsg = err instanceof Error ? err.message : String(err);
    proposal.reasoning = `[LLM error: ${errMsg.slice(0, 80)}, heuristic used] ${proposal.reasoning}`;
    return proposal;
  }
}

// ── Feedback logging ──────────────────────────────────────────────────────────

/** Path to the feedback JSONL file. */
export function getFeedbackFilePath(): string {
  return join(homedir(), ".ashlrcode", "surgical-feedback.jsonl");
}

/**
 * Append a feedback tuple to ~/.ashlrcode/surgical-feedback.jsonl.
 *
 * Creates the file and parent directory if they don't exist.
 * Non-blocking: errors are silently swallowed to avoid disrupting the UX.
 */
export async function logProposalFeedback(feedback: ProposalFeedback): Promise<void> {
  const filePath = getFeedbackFilePath();
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));

  try {
    // Ensure directory exists
    const { mkdir } = await import("fs/promises");
    await mkdir(dir, { recursive: true });

    // Append JSONL line
    const { appendFile } = await import("fs/promises");
    const line = JSON.stringify(feedback) + "\n";
    await appendFile(filePath, line, { encoding: "utf8" });
  } catch {
    // Silently ignore — feedback logging must never break the main UX
  }
}

/**
 * Load all feedback entries from ~/.ashlrcode/surgical-feedback.jsonl.
 * Returns an empty array if the file doesn't exist or can't be parsed.
 */
export async function loadProposalFeedback(): Promise<ProposalFeedback[]> {
  const filePath = getFeedbackFilePath();

  try {
    const { readFile } = await import("fs/promises");
    const raw = await readFile(filePath, { encoding: "utf8" });
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entries: ProposalFeedback[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && parsed.goal) {
          entries.push(parsed as ProposalFeedback);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Compute accuracy and calibration statistics from a set of feedback entries.
 */
export function computeProposalStats(feedback: ProposalFeedback[]): ProposalStats {
  const total = feedback.length;

  if (total === 0) {
    return {
      total: 0,
      accepted: 0,
      overridden: 0,
      acceptanceRate: 0,
      meanConfidence: 0,
      meanConfidenceAccepted: 0,
      meanConfidenceOverridden: 0,
      tierSuggestionCounts: { narrow: 0, medium: 0, wide: 0 },
      tierChoiceCounts: { narrow: 0, medium: 0, wide: 0 },
    };
  }

  const accepted = feedback.filter((f) => f.outcome === "accepted").length;
  const overridden = feedback.filter((f) => f.outcome === "overridden").length;

  const meanConfidence =
    feedback.reduce((s, f) => s + f.suggestedConfidence, 0) / total;

  const acceptedEntries = feedback.filter((f) => f.outcome === "accepted");
  const overriddenEntries = feedback.filter((f) => f.outcome === "overridden");

  const meanConfidenceAccepted =
    acceptedEntries.length > 0
      ? acceptedEntries.reduce((s, f) => s + f.suggestedConfidence, 0) /
        acceptedEntries.length
      : 0;

  const meanConfidenceOverridden =
    overriddenEntries.length > 0
      ? overriddenEntries.reduce((s, f) => s + f.suggestedConfidence, 0) /
        overriddenEntries.length
      : 0;

  const tierSuggestionCounts: Record<ScopeTier, number> = { narrow: 0, medium: 0, wide: 0 };
  const tierChoiceCounts: Record<ScopeTier, number> = { narrow: 0, medium: 0, wide: 0 };

  for (const f of feedback) {
    if (f.suggestedTier in tierSuggestionCounts) {
      tierSuggestionCounts[f.suggestedTier]++;
    }
    if (f.chosenTier in tierChoiceCounts) {
      tierChoiceCounts[f.chosenTier]++;
    }
  }

  return {
    total,
    accepted,
    overridden,
    acceptanceRate: accepted / total,
    meanConfidence,
    meanConfidenceAccepted,
    meanConfidenceOverridden,
    tierSuggestionCounts,
    tierChoiceCounts,
  };
}

/**
 * Format a ProposalStats object as a human-readable string for display
 * in the `/surgical stats` command.
 */
export function formatProposalStats(stats: ProposalStats): string {
  if (stats.total === 0) {
    return [
      "",
      "  ── Surgical Proposal Stats ─────────────────────────────",
      "  No feedback recorded yet.",
      "  Use /surgical propose <goal> to generate proposals.",
      "  Stats accumulate as you accept or override suggestions.",
      "",
    ].join("\n");
  }

  const acceptPct = Math.round(stats.acceptanceRate * 100);
  const meanConfPct = Math.round(stats.meanConfidence * 100);
  const confAccPct = Math.round(stats.meanConfidenceAccepted * 100);
  const confOvrPct = Math.round(stats.meanConfidenceOverridden * 100);

  const calibrated =
    stats.meanConfidenceAccepted >= stats.meanConfidenceOverridden
      ? "calibrated (higher confidence on accepted suggestions)"
      : "under-calibrated (confidence doesn't predict acceptance well)";

  return [
    "",
    "  ── Surgical Proposal Stats ─────────────────────────────",
    `  Total proposals:    ${stats.total}`,
    `  Accepted:           ${stats.accepted} (${acceptPct}%)`,
    `  Overridden:         ${stats.overridden} (${100 - acceptPct}%)`,
    `  Mean confidence:    ${meanConfPct}%`,
    `  Confidence (accepted):   ${confAccPct}%`,
    `  Confidence (overridden): ${confOvrPct}%`,
    `  Calibration:        ${calibrated}`,
    "",
    "  Tier suggestion distribution:",
    `    narrow:  ${stats.tierSuggestionCounts.narrow}`,
    `    medium:  ${stats.tierSuggestionCounts.medium}`,
    `    wide:    ${stats.tierSuggestionCounts.wide}`,
    "",
    "  Tier choice distribution:",
    `    narrow:  ${stats.tierChoiceCounts.narrow}`,
    `    medium:  ${stats.tierChoiceCounts.medium}`,
    `    wide:    ${stats.tierChoiceCounts.wide}`,
    "",
  ].join("\n");
}

/**
 * Format a SurgicalProposal for display to the user before they confirm/override.
 *
 * Example output:
 *   Tier proposal: medium (confidence: 87%)
 *   Reasoning: Intent analysis: ...; Context: 3 files...
 *   Scores: narrow=8% medium=87% wide=12%
 *   Accept:   /surgical medium
 *   Override: /surgical narrow | /surgical wide
 */
export function formatProposal(proposal: SurgicalProposal): string {
  const pct = Math.round(proposal.confidence * 100);
  const narrowPct = Math.round(proposal.scores.narrow * 100);
  const mediumPct = Math.round(proposal.scores.medium * 100);
  const widePct = Math.round(proposal.scores.wide * 100);
  const sourceTag = proposal.source === "llm" ? " [LLM-scored]" : " [heuristic]";

  return [
    `  Tier proposal: ${proposal.tier} (confidence: ${pct}%)${sourceTag}`,
    `  Reasoning: ${proposal.reasoning}`,
    `  Scores:   narrow=${narrowPct}%  medium=${mediumPct}%  wide=${widePct}%`,
    `  Accept:   /surgical ${proposal.tier}`,
    `  Override: /surgical narrow | /surgical medium | /surgical wide`,
  ].join("\n");
}
