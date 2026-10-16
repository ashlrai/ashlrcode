/**
 * Trace commands — /replay and /trace for agent intent tracing.
 *
 *   /replay <session-id>                — re-read trace, re-execute tools with
 *                                         cached results, stream with commentary
 *   /replay <session-id> --viz          — same but renders full ASCII decision-tree
 *   /trace inspect <session-id>         — decision tree view of all choice points
 *   /trace replay <session-id> [--viz]  — alias for /replay with optional viz flag
 *   /trace drill <event-id>             — zoom into a single decision point
 *   /trace list                         — list available traces
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";

export function traceCommands(): Command[] {
  return [
    {
      name: "/replay",
      description: "Replay a recorded agent session with commentary",
      category: "agent",
      subcommands: ["--viz"],
      handler: async (args, ctx) => {
        const parts = (args ?? "").trim().split(/\s+/);
        const viz = parts.includes("--viz");
        const sessionId = parts.filter((p) => p !== "--viz").join(" ").trim();

        if (!sessionId) {
          ctx.addOutput(
            theme.tertiary(
              "\n  Usage: /replay <session-id> [--viz]\n" +
              "         --viz  renders a full ASCII decision-tree after replay\n" +
              "  Use /trace list to see available sessions.\n"
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

        // --viz: render the full ASCII decision-tree visualization
        if (viz) {
          const { getTraceNavigator, renderDecisionTreeViz } = await import("../agent/trace-navigator.ts");
          const nav = getTraceNavigator();
          nav.invalidate(sessionId);
          const tree = await nav.getDecisionTree(sessionId);
          ctx.addOutput(theme.accent("\n  Decision Tree Visualization:\n"));
          const rendered = renderDecisionTreeViz(tree);
          for (const line of rendered.split("\n")) {
            ctx.addOutput(line);
          }
          ctx.addOutput("");
        }

        return true;
      },
    },

    {
      name: "/trace",
      description: "Inspect agent intent traces",
      category: "agent",
      subcommands: ["inspect", "list", "replay", "drill"],
      handler: async (args, ctx) => {
        const tokens = (args ?? "").trim().split(/\s+/);
        const sub = tokens[0];
        const rest = tokens.slice(1);
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
            theme.tertiary(
              "\n  Use /trace inspect <session-id> for details.\n" +
              "      /trace replay <session-id> [--viz] for animated replay.\n" +
              "      /trace drill <event-id> to zoom into a decision.\n"
            )
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

        // ── /trace replay <session-id> [--viz] ───────────────────────────────
        if (sub === "replay") {
          const viz = rest.includes("--viz");
          const sessionId = rest.filter((p) => p !== "--viz").join(" ").trim();
          if (!sessionId) {
            ctx.addOutput(
              theme.tertiary(
                "\n  Usage: /trace replay <session-id> [--viz]\n" +
                "         --viz  renders full ASCII decision-tree after replay\n"
              )
            );
            return true;
          }
          // Delegate to /replay handler by re-entering the replay command with the right args
          const { replayTrace } = await import("../agent/intent-trace.ts");
          const available = await listTraces();
          if (!available.includes(sessionId)) {
            ctx.addOutput(theme.error(`\n  No trace found for session "${sessionId}".\n`));
            if (available.length > 0) {
              for (const s of available.slice(0, 10)) ctx.addOutput(`    ${s}`);
            }
            ctx.addOutput("");
            return true;
          }

          ctx.addOutput(theme.accent(`\n  Replaying session: ${sessionId}\n`));
          let toolCount = 0;
          for await (const event of replayTrace(sessionId)) {
            switch (event.type) {
              case "commentary":
                ctx.addOutput(theme.secondary(event.text ?? ""));
                ctx.update();
                break;
              case "tool_replay":
                toolCount++;
                ctx.addOutput(theme.tertiary(`  [replay] ${event.toolName} step=${event.stepIndex} ✓`));
                ctx.update();
                break;
              case "done":
                break;
            }
          }
          ctx.addOutput(theme.success(`\n  Replay complete: ${toolCount} tools replayed.\n`));

          if (viz) {
            const { getTraceNavigator, renderDecisionTreeViz } = await import("../agent/trace-navigator.ts");
            const nav = getTraceNavigator();
            nav.invalidate(sessionId);
            const tree = await nav.getDecisionTree(sessionId);
            ctx.addOutput(theme.accent("\n  Decision Tree Visualization:\n"));
            for (const line of renderDecisionTreeViz(tree).split("\n")) {
              ctx.addOutput(line);
            }
            ctx.addOutput("");
          }
          return true;
        }

        // ── /trace drill <event-id> ──────────────────────────────────────────
        if (sub === "drill") {
          const eventId = rest.join(" ").trim();
          if (!eventId) {
            ctx.addOutput(
              theme.tertiary(
                "\n  Usage: /trace drill <event-id>\n" +
                "  Event IDs have the form <session-id>:<seq>\n" +
                "  Use /trace inspect <session-id> to find event IDs.\n"
              )
            );
            return true;
          }

          const { getTraceNavigator } = await import("../agent/trace-navigator.ts");
          const nav = getTraceNavigator();
          const detail = await nav.getDrillDown(eventId);

          ctx.addOutput(theme.accent(`\n  Drill-down: ${eventId}\n`));
          ctx.addOutput(theme.accentBold("  Decision Point") + `  [${detail.node.kind}]`);
          ctx.addOutput(`  ${detail.node.label}`);
          ctx.addOutput("");
          ctx.addOutput(theme.accentBold("  Explanation:"));
          for (const line of detail.explanation.split("\n")) {
            ctx.addOutput(`  ${line}`);
          }

          if (detail.siblings.length > 0) {
            ctx.addOutput("");
            ctx.addOutput(theme.tertiary(`  Siblings in same turn (${detail.siblings.length}):`));
            for (const sib of detail.siblings.slice(0, 8)) {
              ctx.addOutput(`    [${sib.kind}] ${sib.label}`);
            }
            if (detail.siblings.length > 8) {
              ctx.addOutput(theme.muted(`    ... and ${detail.siblings.length - 8} more`));
            }
          }

          ctx.addOutput("");
          ctx.addOutput(theme.tertiary("  Speculation state at this point:"));
          ctx.addOutput(`    Hits so far   : ${detail.speculationState.hitsSoFar}`);
          ctx.addOutput(`    Misses so far : ${detail.speculationState.missesSoFar}`);
          if (detail.speculationState.lastCacheType) {
            ctx.addOutput(`    Last cache    : ${detail.speculationState.lastCacheType}`);
          }

          ctx.addOutput("");
          ctx.addOutput(theme.tertiary("  Token budget at this point:"));
          ctx.addOutput(`    Approx tokens    : ${detail.tokenBudgetSnapshot.approxTokens}`);
          ctx.addOutput(`    Compressions     : ${detail.tokenBudgetSnapshot.compressionCount}`);
          ctx.addOutput("");
          return true;
        }

        // Unknown sub-command
        ctx.addOutput(
          theme.tertiary(
            "\n  Usage:\n" +
            "    /trace list\n" +
            "    /trace inspect <session-id>\n" +
            "    /trace replay  <session-id> [--viz]\n" +
            "    /trace drill   <event-id>\n"
          )
        );
        return true;
      },
    },
  ];
}
