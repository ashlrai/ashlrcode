/**
 * Agent commands — /verify, /coordinate, /kairos, /ship, /btw, /cancel, /trigger.
 */

import { theme } from "../ui/theme.ts";
import type { Command, CommandContext } from "./types.ts";

export function agentCommands(): Command[] {
  return [
    {
      name: "/verify",
      description: "Run verification agent on recent changes",
      category: "agent",
      handler: async (args, ctx) => {
        const { runVerification, formatVerificationReport, getModifiedFiles } = await import(
          "../agent/verification.ts"
        );
        const modFiles = getModifiedFiles();
        if (modFiles.length === 0 && !args) {
          ctx.addOutput(
            theme.warning("\n  No modified files to verify. Make changes first or specify: /verify <intent>\n"),
          );
          return true;
        }
        ctx.addOutput(theme.accent("\n  🔍 Running verification agent...\n"));
        const vResult = await runVerification(
          {
            router: ctx.state.router,
            toolRegistry: ctx.state.registry,
            toolContext: ctx.state.toolContext,
            systemPrompt: ctx.state.baseSystemPrompt,
            onOutput: (text) => {
              ctx.addOutput(text);
              ctx.update();
            },
          },
          { intent: args || undefined },
        );
        ctx.addOutput("\n" + formatVerificationReport(vResult) + "\n");
        return true;
      },
    },
    {
      name: "/coordinate",
      description: "Break complex tasks into parallel sub-agents",
      category: "agent",
      subcommands: ["resume", "list", "checkpoints"],
      handler: async (args, ctx) => {
        if (!args) {
          ctx.addOutput(
            theme.warning("\n  Usage: /coordinate <goal>\n  Example: /coordinate Refactor auth module to use JWT\n"),
          );
          return true;
        }

        // Handle resume subcommand
        if (args.startsWith("resume ")) {
          const checkpointId = args.replace("resume ", "").trim();
          if (!checkpointId) {
            ctx.addOutput(theme.warning("\n  Usage: /coordinate resume <checkpoint-id>\n"));
            return true;
          }
          const { loadCheckpoint } = await import("../agent/checkpoint.ts");
          const checkpoint = await loadCheckpoint(checkpointId);
          if (!checkpoint) {
            ctx.addOutput(theme.error(`\n  Checkpoint "${checkpointId}" not found.\n`));
            // List available checkpoints
            const { listPendingCheckpoints } = await import("../agent/checkpoint.ts");
            const pending = await listPendingCheckpoints();
            if (pending.length > 0) {
              ctx.addOutput(theme.tertiary("  Available checkpoints:"));
              for (const cp of pending) {
                ctx.addOutput(
                  `    ${theme.accent(cp.id)} — ${cp.reason} (${new Date(cp.createdAt).toLocaleDateString()})`,
                );
              }
            }
            ctx.addOutput("");
            return true;
          }

          ctx.addOutput(theme.accent(`\n  🔄 Resuming from checkpoint: ${checkpoint.reason}\n`));
          const { coordinateResume } = await import("../agent/coordinator.ts");
          const result = await coordinateResume(checkpointId, "User approved to continue", {
            router: ctx.state.router,
            toolRegistry: ctx.state.registry,
            toolContext: ctx.state.toolContext,
            systemPrompt: ctx.state.baseSystemPrompt,
            autoVerify: true,
            onProgress: (event) => {
              switch (event.type) {
                case "planning":
                  ctx.addOutput(theme.tertiary(`  📋 ${event.message}\n`));
                  break;
                case "dispatching":
                  ctx.addOutput(
                    theme.accent(
                      `  🚀 [${event.taskIndex + 1}/${event.totalTasks}] Dispatching to ${event.agentName}\n`,
                    ),
                  );
                  break;
                case "agent_complete":
                  ctx.addOutput(
                    event.success
                      ? theme.success(`  ✓ ${event.agentName} completed\n`)
                      : theme.error(`  ✗ ${event.agentName} failed\n`),
                  );
                  break;
                case "verifying":
                  ctx.addOutput(theme.tertiary("  🔍 Running verification...\n"));
                  break;
                case "checkpoint":
                  ctx.addOutput(theme.warning(`\n  ⏸ Checkpoint: ${(event as any).checkpoint.reason}`));
                  ctx.addOutput(theme.accent(`  Resume with: /coordinate resume ${(event as any).checkpoint.id}\n`));
                  break;
                case "complete":
                  ctx.addOutput(theme.success(`  ✅ ${event.summary}\n`));
                  break;
              }
              ctx.update();
            },
          });
          const { formatCoordinatorReport } = await import("../agent/coordinator.ts");
          ctx.addOutput("\n" + formatCoordinatorReport(result) + "\n");
          return true;
        }

        if (args === "list" || args === "checkpoints") {
          const { listPendingCheckpoints } = await import("../agent/checkpoint.ts");
          const pending = await listPendingCheckpoints();
          if (pending.length === 0) {
            ctx.addOutput(theme.tertiary("\n  No pending checkpoints.\n"));
          } else {
            ctx.addOutput(theme.accent(`\n  ⏸ ${pending.length} pending checkpoint(s):\n`));
            for (const cp of pending) {
              ctx.addOutput(`  ${theme.accent(cp.id)} — ${cp.reason}`);
              ctx.addOutput(
                theme.muted(
                  `    Type: ${cp.type} · Created: ${new Date(cp.createdAt).toLocaleDateString()} · Goal: ${cp.goal.slice(0, 60)}`,
                ),
              );
            }
            ctx.addOutput(theme.tertiary("\n  /coordinate resume <id> to resume\n"));
          }
          return true;
        }

        const { coordinate, formatCoordinatorReport } = await import("../agent/coordinator.ts");
        ctx.addOutput(theme.accent("\n  🎯 Coordinator mode — breaking task into subtasks...\n"));
        const coordResult = await coordinate(args, {
          router: ctx.state.router,
          toolRegistry: ctx.state.registry,
          toolContext: ctx.state.toolContext,
          systemPrompt: ctx.state.baseSystemPrompt,
          autoVerify: true,
          onProgress: (event) => {
            switch (event.type) {
              case "planning":
                ctx.addOutput(theme.tertiary(`  📋 ${event.message}\n`));
                break;
              case "dispatching":
                ctx.addOutput(
                  theme.accent(`  🚀 [${event.taskIndex + 1}/${event.totalTasks}] Dispatching to ${event.agentName}\n`),
                );
                break;
              case "agent_complete":
                ctx.addOutput(
                  event.success
                    ? theme.success(`  ✓ ${event.agentName} completed\n`)
                    : theme.error(`  ✗ ${event.agentName} failed\n`),
                );
                break;
              case "verifying":
                ctx.addOutput(theme.tertiary("  🔍 Running verification...\n"));
                break;
              case "checkpoint":
                ctx.addOutput(theme.warning(`\n  ⏸ Checkpoint: ${(event as any).checkpoint.reason}`));
                ctx.addOutput(theme.accent(`  Resume with: /coordinate resume ${(event as any).checkpoint.id}\n`));
                break;
              case "complete":
                ctx.addOutput(theme.success(`  ✅ ${event.summary}\n`));
                break;
            }
            ctx.update();
          },
        });
        ctx.addOutput("\n" + formatCoordinatorReport(coordResult) + "\n");
        return true;
      },
    },
    {
      name: "/kairos",
      description: "Start autonomous mode (focus-aware)",
      category: "agent",
      subcommands: ["stop"],
      handler: async (args, ctx) => {
        if (args === "stop") {
          const kairos = ctx.getKairos();
          if (kairos?.isRunning()) {
            await kairos.stop();
            ctx.setKairos(null);
          } else {
            ctx.addOutput(theme.tertiary("\n  KAIROS not running\n"));
          }
          return true;
        }
        if (!args) {
          ctx.addOutput(
            [
              "",
              theme.accentBold("  KAIROS — Autonomous Agent Mode"),
              "",
              `  ${theme.accent("Usage:")}  /kairos <goal>`,
              `  ${theme.accent("Stop:")}   /kairos stop`,
              "",
              `  ${theme.muted("Detects terminal focus to adjust behavior:")}`,
              `    ${theme.success("Focused")}    → Collaborative (asks before big changes)`,
              `    ${theme.warning("Unfocused")}  → Full auto (commits, pushes independently)`,
              `    ${theme.muted("Unknown")}    → Balanced default`,
              "",
              `  ${theme.muted("Heartbeat every 30s · macOS notification when done · Auto-stops when idle")}`,
              "",
              `  ${theme.accent("Example:")} /kairos Fix all TODO comments in src/agent/`,
              "",
            ].join("\n"),
          );
          return true;
        }
        const kairos = ctx.getKairos();
        if (kairos?.isRunning()) {
          ctx.addOutput(theme.warning("\n  KAIROS already running. /kairos stop first.\n"));
          return true;
        }
        const { KairosLoop } = await import("../agent/kairos.ts");
        const newKairos = new KairosLoop({
          router: ctx.state.router,
          toolRegistry: ctx.state.registry,
          toolContext: ctx.state.toolContext,
          systemPrompt: ctx.state.baseSystemPrompt,
          heartbeatIntervalMs: 30_000,
          maxAutonomousIterations: 5,
          onOutput: (text) => {
            ctx.addOutput(text);
          },
          onToolStart: (name) => {
            ctx.addOutput(`  * ${name}`);
            ctx.update();
          },
          onToolEnd: (_name, result, isError) => {
            ctx.addOutput(isError ? `  x ${result.slice(0, 80)}` : `  > ${result.split("\n")[0]?.slice(0, 80)}`);
            ctx.update();
          },
        });
        ctx.setKairos(newKairos as any);
        await newKairos.start(args);
        return true;
      },
    },
    {
      name: "/ship",
      description: "Autonomous product-building agent",
      category: "agent",
      subcommands: ["stop"],
      handler: async (args, ctx) => {
        if (args === "stop") {
          const pa = ctx.getProductAgent();
          if (pa?.isRunning()) {
            pa.stop();
            ctx.setProductAgent(null);
            ctx.addOutput(theme.accent("\n  ProductAgent stopped\n"));
          } else {
            ctx.addOutput(theme.tertiary("\n  ProductAgent not running\n"));
          }
          return true;
        }
        if (!args) {
          ctx.addOutput(
            [
              "",
              theme.accentBold("  🚀 ProductAgent — Autonomous Product Building"),
              "",
              `  ${theme.accent("Usage:")}  /ship <product-goal>`,
              `  ${theme.accent("Stop:")}   /ship stop`,
              "",
              `  ${theme.muted("The agent autonomously:")}`,
              `    1. Scans your codebase against the goal`,
              `    2. Finds bugs, missing features, quality gaps`,
              `    3. Prioritizes by user impact`,
              `    4. Executes fixes with sub-agents`,
              `    5. Verifies every change`,
              "",
              `  ${theme.accent("Example:")} /ship Make ashlrcode production-ready for paying users`,
              "",
            ].join("\n"),
          );
          return true;
        }
        const pa = ctx.getProductAgent();
        if (pa?.isRunning()) {
          ctx.addOutput(theme.warning("\n  ProductAgent already running. /ship stop first.\n"));
          return true;
        }
        const { ProductAgent, formatProductReport } = await import("../agent/product-agent.ts");
        const newPa = new ProductAgent({
          router: ctx.state.router,
          toolRegistry: ctx.state.registry,
          toolContext: ctx.state.toolContext,
          systemPrompt: ctx.state.baseSystemPrompt,
          goal: args,
          maxItems: 20,
          pauseBetweenMs: 3000,
          autoCommit: false,
          onOutput: (text) => {
            ctx.addOutput(text);
            ctx.update();
          },
          onPhaseChange: (phase) => {
            ctx.setSpinnerText(`ProductAgent: ${phase}`);
            ctx.update();
          },
        });
        ctx.setProductAgent(newPa as any);
        const shipResult = await newPa.start();
        ctx.addOutput("\n" + formatProductReport(shipResult) + "\n");
        ctx.setProductAgent(null);
        return true;
      },
    },
    {
      name: "/btw",
      description: "Side question without interrupting flow",
      category: "workflow",
      handler: async (args, ctx) => {
        if (!args) {
          ctx.addOutput(
            theme.tertiary(
              "\n  Usage: /btw <question>\n  Ask a side question in the background — doesn't block your flow.\n",
            ),
          );
          return true;
        }
        const { runSubAgent } = await import("../agent/sub-agent.ts");
        ctx.addOutput(theme.accent(`\n  💬 Side question (background): ${args}\n`));
        const btwOpId = `bg-${Date.now()}`;
        const btwController = new AbortController();
        ctx.backgroundOps.set(btwOpId, {
          name: `btw: ${args.slice(0, 60)}${args.length > 60 ? "..." : ""}`,
          startedAt: Date.now(),
          cancel: () => btwController.abort(),
        });
        runSubAgent({
          name: "btw",
          prompt: args,
          systemPrompt:
            ctx.state.baseSystemPrompt +
            "\n\nThis is a brief side question. Answer concisely (1-3 sentences). Do not modify any files.",
          router: ctx.state.router,
          toolRegistry: ctx.state.registry,
          toolContext: ctx.state.toolContext,
          readOnly: true,
          maxIterations: 5,
        })
          .then((result) => {
            if (btwController.signal.aborted) return;
            ctx.addOutput(theme.accent("\n  💬 BTW answer:\n") + result.text + "\n");
            ctx.update();
          })
          .catch((err) => {
            if (btwController.signal.aborted) {
              ctx.addOutput(theme.tertiary(`\n  💬 BTW cancelled: ${args.slice(0, 60)}\n`));
            } else {
              ctx.addOutput(theme.error(`\n  💬 BTW error: ${err instanceof Error ? err.message : String(err)}\n`));
            }
            ctx.update();
          })
          .finally(() => {
            ctx.backgroundOps.delete(btwOpId);
          });
        return true;
      },
    },
    {
      name: "/cancel",
      description: "List or cancel background operations",
      category: "workflow",
      subcommands: ["all"],
      handler: async (args, ctx) => {
        const allOps: Array<{ id: string; name: string; startedAt: number; cancel: () => void }> = [];
        for (const [id, op] of ctx.backgroundOps) {
          allOps.push({ id, ...op });
        }
        const kairos = ctx.getKairos();
        if (kairos?.isRunning()) {
          allOps.push({
            id: "kairos",
            name: "KAIROS autonomous mode",
            startedAt: 0,
            cancel: () => {
              kairos?.stop();
              ctx.setKairos(null);
            },
          });
        }
        const pa = ctx.getProductAgent();
        if (pa?.isRunning()) {
          allOps.push({
            id: "ship",
            name: "ProductAgent (/ship)",
            startedAt: 0,
            cancel: () => {
              pa?.stop();
              ctx.setProductAgent(null);
            },
          });
        }

        if (!args) {
          if (allOps.length === 0) {
            ctx.addOutput(theme.tertiary("\n  No active background operations.\n"));
          } else {
            const lines = ["", theme.accentBold("  Active Background Operations"), ""];
            for (const op of allOps) {
              const elapsed = op.startedAt > 0 ? `${Math.round((Date.now() - op.startedAt) / 1000)}s ago` : "running";
              lines.push(`    ${theme.accent(op.id)}  ${op.name}  ${theme.muted(`(${elapsed})`)}`);
            }
            lines.push("");
            lines.push(theme.muted("  Usage: /cancel all  or  /cancel <id>"));
            lines.push("");
            ctx.addOutput(lines.join("\n"));
          }
          return true;
        }

        if (args === "all") {
          if (allOps.length === 0) {
            ctx.addOutput(theme.tertiary("\n  No active background operations to cancel.\n"));
          } else {
            for (const op of allOps) {
              op.cancel();
            }
            ctx.addOutput(theme.success(`\n  Cancelled ${allOps.length} background operation(s).\n`));
          }
          return true;
        }

        const target = allOps.find((op) => op.id === args);
        if (target) {
          target.cancel();
          ctx.addOutput(theme.success(`\n  Cancelled: ${target.name}\n`));
        } else {
          ctx.addOutput(theme.error(`\n  No background operation found with ID: ${args}\n`));
          if (allOps.length > 0) {
            ctx.addOutput(theme.muted(`  Active IDs: ${allOps.map((op) => op.id).join(", ")}\n`));
          }
        }
        return true;
      },
    },
    {
      name: "/trigger",
      description: "Schedule recurring agent tasks",
      category: "agent",
      subcommands: ["add", "list", "delete", "toggle"],
      handler: async (args, ctx) => {
        const { createTrigger, deleteTrigger, listTriggers, toggleTrigger } = await import("../agent/cron.ts");
        const [sub, ...triggerRest] = (args ?? "").split(" ");

        if (sub === "add") {
          const [schedule, ...promptParts] = triggerRest;
          if (!schedule || promptParts.length === 0) {
            ctx.addOutput(
              theme.tertiary(
                "\n  Usage: /trigger add <schedule> <prompt>\n  Schedule: 30s, 5m, 1h, 2d\n  Example: /trigger add 5m run tests\n",
              ),
            );
            return true;
          }
          try {
            const t = await createTrigger("trigger", schedule!, promptParts.join(" "), ctx.state.toolContext.cwd);
            ctx.addOutput(theme.success(`\n  Trigger created: ${t.id} (every ${t.schedule})\n`));
          } catch (e: any) {
            ctx.addOutput(theme.error(`\n  ${e.message}\n`));
          }
          return true;
        }

        if (sub === "list" || !sub) {
          const triggers = await listTriggers();
          if (triggers.length === 0) {
            ctx.addOutput(theme.tertiary("\n  No triggers. Use /trigger add <schedule> <prompt>\n"));
            return true;
          }
          ctx.addOutput(theme.secondary("\n  Scheduled Triggers:\n"));
          for (const t of triggers) {
            const status = t.enabled ? theme.success("●") : theme.error("○");
            const lastInfo = t.lastRun ? ` (ran ${t.runCount}x)` : " (never ran)";
            ctx.addOutput(`  ${status} ${t.id} — every ${t.schedule} — ${t.prompt.slice(0, 50)}${lastInfo}`);
          }
          ctx.addOutput("");
          return true;
        }

        if (sub === "delete" && triggerRest[0]) {
          const deleted = await deleteTrigger(triggerRest[0]!);
          ctx.addOutput(
            deleted
              ? theme.success(`\n  Deleted ${triggerRest[0]}\n`)
              : theme.error(`\n  Trigger not found: ${triggerRest[0]}\n`),
          );
          return true;
        }

        if (sub === "toggle" && triggerRest[0]) {
          const toggled = await toggleTrigger(triggerRest[0]!);
          ctx.addOutput(
            toggled
              ? theme.success(`\n  ${toggled.id} is now ${toggled.enabled ? "enabled" : "disabled"}\n`)
              : theme.error(`\n  Trigger not found: ${triggerRest[0]}\n`),
          );
          return true;
        }

        ctx.addOutput(
          theme.tertiary(
            "\n  /trigger add <schedule> <prompt>\n  /trigger list\n  /trigger toggle <id>\n  /trigger delete <id>\n",
          ),
        );
        return true;
      },
    },
  ];
}
