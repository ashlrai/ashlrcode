/**
 * /debug tool-failures command — review recent tool retries and success rates.
 *
 * Sub-commands:
 *   /debug tool-failures           — show retry stats + last 20 retry records
 *   /debug tool-failures reset     — clear the retry history ring buffer
 *   /debug tool-failures verbose   — show full retry history (up to 100 records)
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";
import {
  getRetryHistory,
  getRetryStats,
  formatRetryStats,
  resetRetryHistory,
} from "../agent/tool-retry-analyzer.ts";

export function toolRetryDebugCommands(): Command[] {
  return [
    {
      name: "/debug",
      description: "Debug sub-commands (e.g. /debug tool-failures)",
      category: "tools",
      subcommands: ["tool-failures"],
      handler: async (args, ctx) => {
        const trimmed = args.trim();

        // Only handle "tool-failures" sub-command; let other /debug variants fall through
        if (!trimmed.startsWith("tool-failures")) return false;

        const rest = trimmed.slice("tool-failures".length).trim();

        // ── /debug tool-failures reset ────────────────────────────────────
        if (rest === "reset") {
          resetRetryHistory();
          ctx.addOutput(theme.success("\n  Tool retry history cleared.\n"));
          return true;
        }

        // ── /debug tool-failures verbose ──────────────────────────────────
        if (rest === "verbose") {
          const history = getRetryHistory();
          if (history.length === 0) {
            ctx.addOutput(
              [
                "",
                theme.muted("  No tool retries recorded this session."),
                "",
              ].join("\n")
            );
            return true;
          }

          const lines: string[] = [
            "",
            theme.accentBold("  Tool Retry History  /debug tool-failures verbose"),
            "",
          ];

          const recent = history.slice(-100);
          for (const r of recent) {
            const time = new Date(r.timestamp).toLocaleTimeString();
            const statusIcon = r.succeeded ? theme.success("✓") : theme.error("✗");
            const categoryTag = `[${r.category}]`.padEnd(14);
            const attemptTag = `attempt ${r.attempt}`;
            lines.push(
              `  ${statusIcon} ${time}  ${r.toolName.padEnd(20)} ${categoryTag} ${attemptTag}` +
              (r.errorMessage ? `\n     ${theme.muted(r.errorMessage.slice(0, 80))}` : "")
            );
          }

          lines.push("");
          ctx.addOutput(lines.join("\n"));
          return true;
        }

        // ── /debug tool-failures (default) ────────────────────────────────
        const stats = getRetryStats();
        const history = getRetryHistory();
        const last20 = history.slice(-20);

        ctx.addOutput(
          [
            "",
            theme.accentBold("  Tool Failure Recovery  /debug tool-failures"),
            "",
          ].join("\n")
        );

        if (stats.length === 0) {
          ctx.addOutput(
            [
              theme.muted("  No tool retries recorded this session."),
              theme.muted("  Retries fire automatically when tools encounter transient,"),
              theme.muted("  timeout, parse, or not-found errors."),
              "",
            ].join("\n")
          );
        } else {
          ctx.addOutput(formatRetryStats() + "\n");

          if (last20.length > 0) {
            const lines: string[] = [theme.secondary("  Recent retries (last 20):"), ""];
            for (const r of last20) {
              const time = new Date(r.timestamp).toLocaleTimeString();
              const icon = r.succeeded ? theme.success("ok ") : theme.error("err");
              lines.push(
                `    ${icon}  ${time}  ${r.toolName.padEnd(18)} [${r.category}]  attempt ${r.attempt}`
              );
            }
            lines.push("");
            ctx.addOutput(lines.join("\n"));
          }
        }

        ctx.addOutput(
          [
            theme.secondary("  Sub-commands:"),
            `    ${theme.accent("/debug tool-failures reset")}    — clear retry history`,
            `    ${theme.accent("/debug tool-failures verbose")}  — show full history (up to 100)`,
            "",
          ].join("\n")
        );

        return true;
      },
    },
  ];
}
