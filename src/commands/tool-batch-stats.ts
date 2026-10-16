/**
 * /tool-batch-stats command — display intelligent tool batching statistics.
 *
 * Shows:
 *  - Batch reduction %       (original calls vs. batched groups emitted)
 *  - Round-trip savings      (calls avoided via speculative batching)
 *  - Parallel efficiency     (avg tools executed per batch group)
 *  - Redundancy eliminated   (coalesced duplicate grep/read calls)
 *
 * Sub-commands:
 *   /tool-batch-stats         — show current session stats
 *   /tool-batch-stats reset   — reset the stats counters
 *   /tool-batch-stats demo    — run a demo batch and show visualisation
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";
import {
  getBatchingStats,
  resetBatchingStats,
  formatBatchingStats,
  batchToolCalls,
  visualiseBatchedPlan,
} from "../agent/tool-batching.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Demo plan
// ---------------------------------------------------------------------------

function buildDemoBatch(): { batches: ReturnType<typeof batchToolCalls>; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [
    { id: "demo-0", name: "Read",  input: { file_path: "/src/a.ts" } },
    { id: "demo-1", name: "Read",  input: { file_path: "/src/b.ts" } },
    { id: "demo-2", name: "Grep",  input: { pattern: "TODO", path: "/src" } },
    { id: "demo-3", name: "Grep",  input: { pattern: "FIXME", path: "/src" } },
    { id: "demo-4", name: "Edit",  input: { file_path: "/src/a.ts" } },
    { id: "demo-5", name: "Bash",  input: { command: "bun test" } },
  ];
  const batches = batchToolCalls(toolCalls);
  return { batches, toolCalls };
}

// ---------------------------------------------------------------------------
// /tool-batch-stats command
// ---------------------------------------------------------------------------

export function toolBatchStatsCommands(): Command[] {
  return [
    {
      name: "/tool-batch-stats",
      description: "Show intelligent tool batching statistics: batch reduction %, round-trip savings, parallel efficiency",
      category: "agent",
      subcommands: ["reset", "demo"],
      handler: async (args, ctx) => {
        const cleanArgs = args.trim();

        // ── /tool-batch-stats reset ────────────────────────────────────────
        if (cleanArgs === "reset") {
          resetBatchingStats();
          ctx.addOutput(theme.success("\n  Batching stats reset.\n"));
          return true;
        }

        // ── /tool-batch-stats demo ─────────────────────────────────────────
        if (cleanArgs === "demo") {
          const { batches, toolCalls } = buildDemoBatch();
          const vis = visualiseBatchedPlan(batches, toolCalls.length);

          ctx.addOutput(
            [
              "",
              theme.accentBold("  Tool Batching Demo  /tool-batch-stats demo"),
              theme.muted("  6 calls: Read×2, Grep×2 (same path), Edit, Bash"),
              "",
            ].join("\n")
          );
          ctx.addOutput(vis);
          ctx.addOutput("");
          ctx.addOutput(
            [
              theme.secondary("  What happened:"),
              `    ${theme.accent("Grep×2")} on /src were coalesced → 1 merged grep call`,
              `    ${theme.accent("Read×2")} were speculative-batched → 1 batch-read group`,
              `    ${theme.accent("Edit")} runs after batch-read (file-path dependency)`,
              `    ${theme.accent("Bash")} runs last (opaque write dependency)`,
              "",
            ].join("\n")
          );
          return true;
        }

        // ── /tool-batch-stats (default) ────────────────────────────────────
        const stats = getBatchingStats();
        const formatted = formatBatchingStats();

        ctx.addOutput(
          [
            "",
            theme.accentBold("  Tool Batching Statistics  /tool-batch-stats"),
            "",
          ].join("\n")
        );

        if (stats.totalCalls === 0) {
          ctx.addOutput(
            [
              theme.muted("  No batching data yet — tool batching runs automatically"),
              theme.muted("  when the agent processes multiple tool calls per turn."),
              "",
              theme.muted("  Run /tool-batch-stats demo to see a simulated example."),
              "",
            ].join("\n")
          );
        } else {
          // Bar chart for batch reduction
          const pct = stats.batchReductionPct;
          const barWidth = 40;
          const filled = Math.round((pct / 100) * barWidth);
          const bar = "█".repeat(Math.max(0, filled)) + "░".repeat(barWidth - Math.max(0, filled));

          ctx.addOutput(
            [
              `  Batch reduction   [${bar}] ${pct}%`,
              "",
              formatted,
              "",
            ].join("\n")
          );
        }

        ctx.addOutput(
          [
            theme.secondary("  Sub-commands:"),
            `    ${theme.accent("/tool-batch-stats reset")}  — reset counters`,
            `    ${theme.accent("/tool-batch-stats demo")}   — show demo batch visualisation`,
            "",
          ].join("\n")
        );

        return true;
      },
    },
  ];
}
