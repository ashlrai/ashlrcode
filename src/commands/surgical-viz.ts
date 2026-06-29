/**
 * Surgical Viz Commands — /surgical viz, /surgical confidence, /surgical history
 *
 * Provides a real-time dashboard of surgical tier confidence and scope decisions.
 *
 * Commands:
 *   /surgical viz        — full dashboard (tier distribution + patterns + history)
 *   /surgical confidence — confidence distribution chart (text-based)
 *   /surgical history    — recent 20 tier decisions with feedback
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";

/**
 * Register surgical viz sub-commands.
 * These are designed to be called from within the /surgical handler in agent.ts
 * by checking the args prefix (viz | confidence | history).
 *
 * Returns an array of Command objects — the caller should wire them or
 * the /surgical handler can call surgicalVizHandler(args, ctx) directly.
 */
export function surgicalVizCommands(): Command[] {
  return [
    {
      name: "/surgical viz",
      description: "Full surgical tier confidence dashboard",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalViz(args, ctx);
      },
    },
    {
      name: "/surgical confidence",
      description: "Confidence distribution chart by goal pattern",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalConfidence(args, ctx);
      },
    },
    {
      name: "/surgical history",
      description: "Recent 20 tier decisions with timestamps and outcomes",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalHistory(args, ctx);
      },
    },
  ];
}

// ── Handlers (also exported for direct use from agent.ts /surgical handler) ───

/**
 * /surgical viz — full dashboard
 */
export async function handleSurgicalViz(
  _args: string,
  ctx: { addOutput: (text: string) => void },
): Promise<boolean> {
  const { TierConfidenceAnalyzer } = await import("../agent/surgical-confidence-analyzer.ts");
  const { renderSurgicalDashboard } = await import("../ui/SurgicalDashboard.tsx");

  const analyzer = new TierConfidenceAnalyzer();

  const [dist, patterns, decisions] = await Promise.all([
    analyzer.getTierDistribution(),
    analyzer.analyze(),
    analyzer.getRecentDecisions(10),
  ]);

  ctx.addOutput(renderSurgicalDashboard(dist, patterns, decisions));
  return true;
}

/**
 * /surgical confidence — confidence distribution chart only
 */
export async function handleSurgicalConfidence(
  _args: string,
  ctx: { addOutput: (text: string) => void },
): Promise<boolean> {
  const { TierConfidenceAnalyzer } = await import("../agent/surgical-confidence-analyzer.ts");
  const { renderConfidenceChart, renderTierDistribution } = await import("../ui/SurgicalDashboard.tsx");

  const analyzer = new TierConfidenceAnalyzer();

  const [dist, patterns] = await Promise.all([
    analyzer.getTierDistribution(),
    analyzer.analyze(),
  ]);

  ctx.addOutput(
    [
      "",
      theme.accentBold("  Surgical Tier Confidence"),
      renderTierDistribution(dist),
      renderConfidenceChart(patterns),
    ].join(""),
  );
  return true;
}

/**
 * /surgical history — recent 20 tier decisions
 */
export async function handleSurgicalHistory(
  _args: string,
  ctx: { addOutput: (text: string) => void },
): Promise<boolean> {
  const { TierConfidenceAnalyzer } = await import("../agent/surgical-confidence-analyzer.ts");
  const { renderDecisionHistory } = await import("../ui/SurgicalDashboard.tsx");

  const analyzer = new TierConfidenceAnalyzer();
  const decisions = await analyzer.getRecentDecisions(20);

  ctx.addOutput(
    [
      "",
      theme.accentBold("  Surgical Tier History"),
      renderDecisionHistory(decisions),
    ].join(""),
  );
  return true;
}
