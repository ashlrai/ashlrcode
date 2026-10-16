/**
 * session-commands.ts — /budget command
 *
 * Provides the /budget slash command for inspecting context budget telemetry.
 *
 * Subcommands:
 *   /budget status  — show current usage + historical breakdown by tier + provider
 *   /budget         — alias for /budget status
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";
import {
  getContextBudgetMonitor,
  classifyBudgetColor,
  formatTokenCount,
} from "../agent/context-budget-monitor.ts";

/**
 * Format a fill ratio as a colored percentage string using ANSI escape codes
 * based on our budget color thresholds (green/yellow/red).
 */
function colorPct(pct: number): string {
  const color = classifyBudgetColor(pct);
  const str = `${pct}%`;
  if (color === "green") return theme.success(str);
  if (color === "yellow") return theme.warning(str);
  return theme.error(str);
}

export function budgetCommands(): Command[] {
  return [
    {
      name: "/budget",
      description: "Show context budget telemetry and compression history",
      category: "session",
      subcommands: ["status"],
      handler: async (args, ctx) => {
        const sub = (args ?? "").trim();

        // /budget or /budget status — same behavior
        if (sub === "" || sub === "status") {
          const monitor = getContextBudgetMonitor();
          const snap = monitor.getSnapshot();
          const history = monitor.getProviderHistory();
          const turns = monitor.getTurns();

          ctx.addOutput("");
          ctx.addOutput(theme.accent("  Context Budget Status"));
          ctx.addOutput(theme.muted("  " + "─".repeat(50)));

          // Current state
          ctx.addOutput(
            `  Provider : ${theme.secondary(snap.provider)}  Model: ${theme.secondary(snap.model)}`
          );
          ctx.addOutput(
            `  Used     : ${colorPct(snap.usedPercent)} ` +
            `(${formatTokenCount(snap.usedTokens)} / ${formatTokenCount(snap.contextLimit)} tokens)`
          );
          ctx.addOutput(
            `  Runway   : ${snap.runwayTurns >= 999 ? theme.success("∞ turns") : `${snap.runwayTurns} turns`}`
          );
          ctx.addOutput(
            `  Overhead : ${snap.overheadMultiplier.toFixed(2)}x ` +
            theme.muted("(reasoning model multiplier)")
          );

          // Recent compression ratios
          const [c1 = 0, c2 = 0, c3 = 0] = snap.recentCompressionRatios;
          ctx.addOutput(
            `  Compress : ${colorPct(c1)}  ${colorPct(c2)}  ${colorPct(c3)} ` +
            theme.muted("(last 3 turns, oldest→newest)")
          );

          // Historical breakdown by provider
          if (history.length > 0) {
            ctx.addOutput("");
            ctx.addOutput(theme.accent("  Historical Breakdown by Provider"));
            ctx.addOutput(theme.muted("  " + "─".repeat(50)));
            for (const entry of history) {
              const maxPct = Math.round(entry.maxFillRatio * 100);
              ctx.addOutput(
                `  ${theme.secondary(entry.provider + "/" + entry.model)}`
              );
              ctx.addOutput(
                `    Turns: ${entry.turns}  ` +
                `Avg tokens/turn: ${formatTokenCount(entry.avgTokensPerTurn)}  ` +
                `Peak fill: ${colorPct(maxPct)}`
              );
              if (entry.compressionEvents > 0) {
                ctx.addOutput(
                  `    Compression events: ${entry.compressionEvents}  ` +
                  `Total saved: ${formatTokenCount(entry.totalCompressionSaved)} tokens`
                );
              }
            }
          }

          // Recent turn log (last 5)
          if (turns.length > 0) {
            ctx.addOutput("");
            ctx.addOutput(theme.accent("  Recent Turns (last 5)"));
            ctx.addOutput(theme.muted("  " + "─".repeat(50)));
            const recent = turns.slice(-5);
            for (const t of recent) {
              const fillPct = Math.round(t.fillRatio * 100);
              const comprStr =
                t.compressionTier > 0
                  ? theme.warning(` [compress T${t.compressionTier}, saved ${formatTokenCount(t.compressionSaved)}]`)
                  : "";
              ctx.addOutput(
                `  Turn ${t.turnIndex}: ` +
                `in=${formatTokenCount(t.inputTokens)} ` +
                `out=${formatTokenCount(t.outputTokens)}` +
                (t.reasoningTokens > 0 ? ` reason=${formatTokenCount(t.reasoningTokens)}` : "") +
                `  fill=${colorPct(fillPct)}` +
                comprStr
              );
            }
          }

          ctx.addOutput("");
          return true;
        }

        // Unknown subcommand
        ctx.addOutput(
          theme.tertiary("\n  Usage: /budget [status]\n")
        );
        return true;
      },
    },
  ];
}
