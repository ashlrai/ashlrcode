/**
 * Trace commands — /replay and /trace for agent intent tracing.
 *
 *   /replay <session-id>          — re-read trace, re-execute tools with
 *                                   cached results, stream with commentary
 *   /trace inspect <session-id>   — decision tree view of all choice points
 *   /trace list                   — list available traces
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";

export function traceCommands(): Command[] {
  return [
    {
      name: "/replay",
      description: "Replay a recorded agent session with commentary",
      category: "agent",
      subcommands: [],
      handler: async (args, ctx) => {
        const sessionId = args.trim();
        if (!sessionId) {
          ctx.addOutput(
            theme.tertiary(
              "\n  Usage: /replay <session-id>\n  Use /trace list to see available sessions.\n"
            )
          );
          return true;
        }

        const { replayTrace, listTraces } = await import("../agent/intent-trace.ts");

        // Check the session exists
        const available = await listTraces();
        if (!available.includes(sessionId)) {
          ctx.addOutput(theme.error(`\n  No trace found for session "${sessionId}".\n`));
          if (available.length > 0) {
            ctx.addOutput(theme.tertiary("  Available sessions:"));
            for (const s of available.slice(0, 10)) {
              ctx.addOutput(`    ${s}`);
            }
            if (available.length > 10) {
              ctx.addOutput(theme.muted(`    ... and ${available.length - 10} more`));
            }
          } else {
            ctx.addOutput(theme.tertiary("  No traces recorded yet. Enable with ASHLRCODE_INTENT_TRACE=1\n"));
          }
          ctx.addOutput("");
          return true;
        }

        ctx.addOutput(theme.accent(`\n  Replaying session: ${sessionId}\n`));

        let toolCount = 0;
        let hitCount = 0;

        for await (const event of replayTrace(sessionId)) {
          switch (event.type) {
            case "commentary":
              ctx.addOutput(theme.secondary(event.text ?? ""));
              ctx.update();
              break;
            case "tool_replay":
              toolCount++;
              if (event.resultMatched) hitCount++;
              ctx.addOutput(
                theme.tertiary(
                  `  [replay] ${event.toolName} step=${event.stepIndex} ✓`
                )
              );
              ctx.update();
              break;
            case "done":
              break;
          }
        }

        ctx.addOutput(
          theme.success(
            `\n  Replay complete: ${toolCount} tools replayed, ${hitCount} matched.\n`
          )
        );
        return true;
      },
    },

    {
      name: "/trace",
      description: "Inspect agent intent traces",
      category: "agent",
      subcommands: ["inspect", "list"],
      handler: async (args, ctx) => {
        const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
        const {
          listTraces,
          loadTrace,
          buildDecisionTree,
          renderDecisionTree,
        } = await import("../agent/intent-trace.ts");

        // ── /trace list ──────────────────────────────────────────────────────
        if (!sub || sub === "list") {
          const sessions = await listTraces();
          if (sessions.length === 0) {
            ctx.addOutput(
              theme.tertiary(
                "\n  No traces recorded yet.\n  Enable with ASHLRCODE_INTENT_TRACE=1 or set intentTrace: true in settings.\n"
              )
            );
            return true;
          }
          ctx.addOutput(theme.accent(`\n  Recorded sessions (${sessions.length}):\n`));
          for (const s of sessions) {
            ctx.addOutput(`    ${s}`);
          }
          ctx.addOutput(
            theme.tertiary("\n  Use /trace inspect <session-id> for details.\n")
          );
          return true;
        }

        // ── /trace inspect <session-id> ──────────────────────────────────────
        if (sub === "inspect") {
          const sessionId = rest.join(" ").trim();
          if (!sessionId) {
            ctx.addOutput(
              theme.tertiary("\n  Usage: /trace inspect <session-id>\n")
            );
            return true;
          }

          const events = await loadTrace(sessionId);
          if (events.length === 0) {
            ctx.addOutput(
              theme.error(`\n  No trace found for session "${sessionId}".\n`)
            );
            return true;
          }

          ctx.addOutput(
            theme.accent(
              `\n  Trace for "${sessionId}" (${events.length} events)\n`
            )
          );

          const tree = buildDecisionTree(events);
          const rendered = renderDecisionTree(tree);

          // Stream the tree line by line for a pleasant experience
          for (const line of rendered.split("\n")) {
            ctx.addOutput(line);
          }

          // Summary stats
          const kinds = new Map<string, number>();
          for (const ev of events) {
            kinds.set(ev.kind, (kinds.get(ev.kind) ?? 0) + 1);
          }

          ctx.addOutput(theme.tertiary("\n  Event summary:"));
          for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
            ctx.addOutput(`    ${kind.padEnd(24)} ${count}`);
          }
          ctx.addOutput("");
          return true;
        }

        // Unknown sub-command
        ctx.addOutput(
          theme.tertiary(
            "\n  Usage:\n    /trace list\n    /trace inspect <session-id>\n"
          )
        );
        return true;
      },
    },
  ];
}
