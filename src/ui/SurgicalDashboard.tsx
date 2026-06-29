/**
 * SurgicalDashboard — text-based terminal visualization for surgical mode
 * confidence and tier decision history.
 *
 * Renders three sections:
 *   1. Tier Distribution — narrow / medium / wide counts with bar charts
 *   2. Top Goal Patterns — success rates and confidence per pattern
 *   3. Confidence Heatmap legend + Recent Decisions (last 10)
 *
 * This is a pure text renderer (no Ink JSX required at runtime) that
 * produces styled string output compatible with ctx.addOutput() in the REPL.
 * It exports both:
 *   - renderSurgicalDashboard(data) → string   — full dashboard
 *   - renderConfidenceChart(patterns) → string — confidence distribution only
 *   - renderDecisionHistory(decisions) → string — last N decisions
 */

import type { PatternStats, TierDistribution, RecentDecision } from "../agent/surgical-confidence-analyzer.ts";
import { theme } from "./theme.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function padR(s: string, n: number): string {
  return s.padEnd(n);
}
function padL(s: string, n: number): string {
  return s.padStart(n);
}

/**
 * Render a simple text bar of the given width (0–1 fill fraction).
 * Uses unicode block chars for a dense bar.
 */
function bar(fill: number, width = 20): string {
  const filled = Math.round(Math.clamp(fill, 0, 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Polyfill Math.clamp for safety
if (typeof (Math as any).clamp !== "function") {
  (Math as any).clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
}

/**
 * Color a confidence value with heatmap coloring:
 *   0.0–0.5  → red (error)
 *   0.5–0.8  → yellow (warning)
 *   0.8+     → green (success)
 */
function colorConfidence(value: number): string {
  const pct = Math.round(value * 100);
  const label = `${pct}%`;
  if (value >= 0.8) return theme.success(label);
  if (value >= 0.5) return theme.warning(label);
  return theme.error(label);
}

/**
 * Color a success rate the same way as confidence.
 */
function colorSuccessRate(rate: number): string {
  return colorConfidence(rate);
}

/**
 * Format a tier label with appropriate color.
 */
function colorTier(tier: "narrow" | "medium" | "wide"): string {
  switch (tier) {
    case "narrow": return theme.accent(tier);
    case "medium": return theme.warning(tier);
    case "wide": return theme.error(tier);
  }
}

/**
 * Format an ISO timestamp as a short date+time string.
 * e.g. "2026-06-29 14:32"
 */
function fmtTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toISOString().slice(0, 10);
    const time = d.toISOString().slice(11, 16);
    return `${date} ${time}`;
  } catch {
    return iso.slice(0, 16);
  }
}

// ── Section renderers ──────────────────────────────────────────────────────────

/**
 * Render the tier distribution section with bar charts.
 */
export function renderTierDistribution(dist: TierDistribution): string {
  const lines: string[] = [
    "",
    theme.accentBold("  ── Tier Distribution ─────────────────────────────────────"),
    "",
  ];

  if (dist.total === 0) {
    lines.push(theme.muted("  No tier decisions recorded yet."));
    lines.push(theme.muted("  Use /surgical propose <goal> to start generating data."));
    lines.push("");
    return lines.join("\n");
  }

  const tiers: ("narrow" | "medium" | "wide")[] = ["narrow", "medium", "wide"];
  for (const tier of tiers) {
    const count = dist[tier];
    const pct = dist.total > 0 ? count / dist.total : 0;
    const barStr = bar(pct, 24);
    const pctLabel = `${Math.round(pct * 100)}%`;
    lines.push(
      `  ${padR(colorTier(tier), 18)}  ${theme.secondary(barStr)}  ` +
      `${padL(String(count), 4)} ${theme.muted(`(${pctLabel})`)}`,
    );
  }
  lines.push("");
  lines.push(theme.muted(`  Total decisions: ${dist.total}`));
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the top goal patterns table with success rates and confidence.
 * Shows up to 5 patterns.
 */
export function renderConfidenceChart(patterns: PatternStats[]): string {
  const lines: string[] = [
    "",
    theme.accentBold("  ── Goal Pattern Confidence ───────────────────────────────"),
    "",
  ];

  if (patterns.length === 0) {
    lines.push(theme.muted("  No pattern data yet."));
    lines.push("");
    return lines.join("\n");
  }

  // Header
  lines.push(
    "  " +
    padR("Pattern", 14) +
    padR("Tier", 10) +
    padR("Success", 10) +
    padR("Confidence", 12) +
    padL("n", 5),
  );
  lines.push("  " + theme.muted("─".repeat(54)));

  const top5 = patterns.slice(0, 5);
  for (const p of top5) {
    lines.push(
      "  " +
      padR(p.pattern.slice(0, 13), 14) +
      padR(colorTier(p.recommendedTier), 10 + 10) + // color adds escape codes
      "  " +
      padR(colorSuccessRate(p.successRate), 10 + 10) +
      "  " +
      padR(colorConfidence(p.confidence), 12 + 10) +
      "  " +
      padL(String(p.sampleSize), 5),
    );
  }

  if (patterns.length > 5) {
    lines.push(theme.muted(`  ... and ${patterns.length - 5} more patterns`));
  }

  lines.push("");
  lines.push(theme.muted("  Confidence: ") + theme.error("  0–50% low  ") + theme.warning(" 50–80% med ") + theme.success(" 80%+ high"));
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the last 10 tier decisions with timestamps and outcomes.
 */
export function renderDecisionHistory(decisions: RecentDecision[]): string {
  const lines: string[] = [
    "",
    theme.accentBold("  ── Recent Tier Decisions ─────────────────────────────────"),
    "",
  ];

  if (decisions.length === 0) {
    lines.push(theme.muted("  No decisions recorded yet."));
    lines.push("");
    return lines.join("\n");
  }

  // Header
  lines.push(
    "  " +
    padR("Timestamp", 17) +
    padR("Goal", 28) +
    padR("Suggested", 11) +
    padR("Chosen", 9) +
    padR("Conf", 7) +
    "Outcome",
  );
  lines.push("  " + theme.muted("─".repeat(84)));

  const recent10 = decisions.slice(0, 10);
  for (const d of recent10) {
    const outcomeStr = d.accepted
      ? theme.success("accepted")
      : d.outcome === "unknown"
        ? theme.muted("unknown")
        : theme.warning("override");

    lines.push(
      "  " +
      padR(fmtTimestamp(d.timestamp), 17) +
      padR(d.goal.slice(0, 27), 28) +
      padR(colorTier(d.suggestedTier), 11 + 9) +
      "  " +
      padR(
        d.suggestedTier === d.chosenTier ? theme.muted(d.chosenTier) : colorTier(d.chosenTier),
        9 + (d.suggestedTier !== d.chosenTier ? 9 : 9),
      ) +
      "  " +
      padR(colorConfidence(d.confidence), 7 + 9) +
      "  " +
      outcomeStr,
    );
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render the full surgical dashboard combining all three sections.
 */
export function renderSurgicalDashboard(
  dist: TierDistribution,
  patterns: PatternStats[],
  decisions: RecentDecision[],
): string {
  return [
    "",
    theme.accentBold("  ═══════════════════════════════════════════════════════════"),
    theme.accentBold("    Surgical Mode — Tier Confidence Dashboard"),
    theme.accentBold("  ═══════════════════════════════════════════════════════════"),
    renderTierDistribution(dist),
    renderConfidenceChart(patterns),
    renderDecisionHistory(decisions),
  ].join("");
}
