/**
 * Agent commands — /verify, /coordinate, /kairos, /ship, /btw, /cancel, /trigger, /surgical.
 */

import { theme } from "../ui/theme.ts";
import type { Command, CommandContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Formatting helpers used by /tool-metrics
// ---------------------------------------------------------------------------
function padR(s: string, n: number): string { return s.padEnd(n); }
function padL(s: string, n: number): string { return s.padStart(n); }
function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
function fmtPct(rate: number): string { return `${(rate * 100).toFixed(1)}%`; }
function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)}MB`;
  if (b >= 1_024) return `${(b / 1_024).toFixed(1)}KB`;
  return `${Math.round(b)}B`;
}

export function agentCommands(): Command[] {
  return [
    {
      name: "/verify",
      description: "Run verification agent on recent changes. Pass --with-tests to also suggest/generate test stubs.",
      category: "agent",
      subcommands: ["--with-tests"],
      handler: async (args, ctx) => {
        const { runVerification, formatVerificationReport, getModifiedFiles } = await import(
          "../agent/verification.ts"
        );

        // Parse --with-tests flag
        const withTests = !!args?.includes("--with-tests");
        const intent = args?.replace("--with-tests", "").trim() || undefined;

        const modFiles = getModifiedFiles();
        if (modFiles.length === 0 && !intent) {
          ctx.addOutput(
            theme.warning("\n  No modified files to verify. Make changes first or specify: /verify <intent>\n"),
          );
          ctx.addOutput(
            theme.muted("  Tip: /verify --with-tests also suggests test cases for uncovered branches\n"),
          );
          return true;
        }

        ctx.addOutput(theme.accent(withTests
          ? "\n  🔍 Running verification agent with test suggestions...\n"
          : "\n  🔍 Running verification agent...\n"
        ));

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
          {
            intent,
            withTests,
            generateStubs: withTests,
            coverageThreshold: 70,
          },
        );

        ctx.addOutput("\n" + formatVerificationReport(vResult) + "\n");

        // If test suggestions exist but stubs weren't generated (plain /verify),
        // show a prompt to run with --with-tests
        if (!withTests && vResult.testSuggestions && vResult.testSuggestions.length > 0) {
          ctx.addOutput(
            theme.tertiary(
              `  💡 ${vResult.testSuggestions.length} test suggestion(s) available — run /verify --with-tests to generate stubs\n`
            )
          );
        }

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
          const resumeParts = args.replace("resume ", "").trim().split(" ");
          const checkpointId = resumeParts[0];
          const userResponse = resumeParts.slice(1).join(" ").trim() || "User approved to continue";
          if (!checkpointId) {
            ctx.addOutput(theme.warning("\n  Usage: /coordinate resume <checkpoint-id> [response]\n"));
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
          const result = await coordinateResume(checkpointId, userResponse, {
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
      name: "/surgical",
      description: "Set surgical mode tier (narrow/medium/wide) with auto-detection",
      category: "agent",
      subcommands: ["narrow", "medium", "wide", "off", "status", "analyze", "auto", "cost-analysis", "propose", "stats", "viz", "confidence", "history"],
      handler: async (args, ctx) => {
        const { analyzeScopeFromIntent, SurgicalScopeAnalyzer } = await import("../agent/surgical-scope.ts");

        // /surgical status — show current gate state with intent-based enhancement
        if (!args || args === "status") {
          const gate = (ctx.state.registry as any)._surgicalGate as
            | { enabled: boolean; tier: string }
            | null
            | undefined;

          // Pull intent analysis from session history if available
          const { getGlobalIntentTracker, formatIntentStatus } = await import("../agent/surgical-intent-analyzer.ts");
          const { getSurgicalAutoMode } = await import("../cli.ts");
          const tracker = getGlobalIntentTracker();
          const sessionHistory = tracker.getHistory();

          // Derive current tier for formatIntentStatus
          type LegacyTier = "narrow" | "medium" | "wide";
          const currentTier: 1 | 2 | 3 | 4 | LegacyTier | null = gate?.enabled
            ? (gate.tier as LegacyTier)
            : null;

          const autoModeOn = getSurgicalAutoMode();
          const autoStatus = autoModeOn
            ? theme.success("  Auto-tier mode: ON") + theme.muted(" (/surgical auto to disable)\n")
            : theme.tertiary("  Auto-tier mode: off") + theme.muted(" (/surgical auto to enable)\n");

          if (!gate?.enabled) {
            ctx.addOutput(theme.tertiary("\n  Surgical mode: off\n") + autoStatus);
          } else {
            ctx.addOutput(theme.accent(`\n  Surgical mode: ${gate.tier}\n`) + autoStatus);
          }

          // Show enhanced intent status — always when history exists, or with a
          // placeholder message if the session hasn't started yet.
          const hasContext = sessionHistory.length > 0 || tracker.size() > 0;

          if (hasContext) {
            const analysis = tracker.analyzeCurrentIntent();
            const pct = Math.round(analysis.confidence * 100);
            ctx.addOutput(formatIntentStatus(currentTier, analysis));
            ctx.addOutput(
              [
                `  Confidence:  ${pct}%${analysis.confidence < 0.75 ? theme.warning(" (low — tier picker will show on first message)") : ""}`,
                `  Reasoning:   ${analysis.reasoning}`,
                analysis.scopeCreepDetected ? theme.warning("  Scope creep detected in tool history!") : "",
                "",
              ].filter(Boolean).join("\n"),
            );
          } else {
            ctx.addOutput(
              [
                "",
                theme.secondary("  Usage:"),
                `    ${theme.accent("/surgical auto")}          — toggle auto-tier mode (intent picker on first message)`,
                `    ${theme.accent("/surgical")}               — auto-detect tier from next message`,
                `    ${theme.accent("/surgical analyze <msg>")} — analyze scope for a specific message`,
                `    ${theme.accent("/surgical narrow")}        — force narrow tier (1 file budget)`,
                `    ${theme.accent("/surgical medium")}        — force medium tier (3 file budget)`,
                `    ${theme.accent("/surgical wide")}          — force wide tier (6 file budget)`,
                `    ${theme.accent("/surgical off")}           — disable surgical mode`,
                `    ${theme.accent("/surgical status")}        — show current tier + intent analysis`,
                "",
                theme.muted("  Confidence and reasoning will appear once a session goal is set."),
                "",
              ].join("\n"),
            );
          }
          return true;
        }

        // /surgical auto — toggle surgical auto-tier mode
        // When enabled, the first message of each session triggers an intent
        // analysis: if confidence ≥ 0.8 the tier is silently applied; if
        // confidence is 0.5–0.79 an interactive tier picker is shown.
        if (args === "auto") {
          const { getSurgicalAutoMode, setSurgicalAutoMode } = await import("../cli.ts");
          const current = getSurgicalAutoMode();
          const next = !current;
          setSurgicalAutoMode(next);
          if (next) {
            ctx.addOutput(
              theme.success("\n  Surgical auto-tier mode ENABLED.\n") +
              theme.muted(
                "  On your first message this session, intent will be analysed and\n" +
                "  a surgical tier applied automatically (or you'll be prompted if\n" +
                "  confidence is between 50–79%).\n" +
                "  Disable with: /surgical auto\n"
              )
            );
          } else {
            ctx.addOutput(theme.tertiary("\n  Surgical auto-tier mode DISABLED.\n"));
          }
          return true;
        }

        // /surgical off — clear the gate
        if (args === "off") {
          ctx.state.registry.clearSurgicalGate();
          ctx.addOutput(theme.tertiary("\n  Surgical mode disabled.\n"));
          return true;
        }

        // /surgical narrow | medium | wide — force a specific tier
        if (args === "narrow" || args === "medium" || args === "wide") {
          const tier = args as "narrow" | "medium" | "wide";
          const budgets: Record<"narrow" | "medium" | "wide", number> = {
            narrow: 1,
            medium: 3,
            wide: 6,
          };
          ctx.state.registry.setSurgicalGate({ enabled: true, tier });
          ctx.addOutput(
            theme.accent(`\n  Surgical mode: ${tier} (file budget: ${budgets[tier]})\n`) +
            theme.muted("  Use /surgical off to disable.\n"),
          );
          return true;
        }

        // /surgical cost-analysis — show per-tier cost breakdowns + promotion opportunities
        if (args === "cost-analysis" || args.startsWith("cost-analysis ")) {
          const { generateCostAnalysisReport, formatCostAnalysisReport } = await import(
            "../agent/surgical-cost-optimizer.ts"
          );
          const { getGlobalIntentTracker } = await import("../agent/surgical-intent-analyzer.ts");
          const tracker = getGlobalIntentTracker();
          // Use current session confidence if available, otherwise default 0.75
          let confidence = 0.75;
          if (tracker.size() > 0) {
            const analysis = tracker.analyzeCurrentIntent();
            confidence = analysis.confidence;
          }
          const report = generateCostAnalysisReport(confidence);
          ctx.addOutput(
            [
              "",
              theme.accentBold("  Surgical Cost Analysis"),
              formatCostAnalysisReport(report),
            ].join("\n"),
          );
          return true;
        }

        // /surgical analyze <message> — analyze scope for a given message and show suggestion
        if (args.startsWith("analyze ")) {
          const msg = args.slice("analyze ".length).trim();
          if (!msg) {
            ctx.addOutput(theme.warning("\n  Usage: /surgical analyze <your message>\n"));
            return true;
          }
          const analyzer = new SurgicalScopeAnalyzer();
          const result = analyzer.analyze(msg, "");
          ctx.addOutput(
            [
              "",
              theme.accentBold("  Scope Analysis"),
              analyzer.formatSuggestion(result),
              "",
            ].join("\n"),
          );
          return true;
        }

        // /surgical propose <goal> — LLM-powered tier proposal with confidence scoring
        if (args.startsWith("propose ") || args === "propose") {
          const goal = args.startsWith("propose ") ? args.slice("propose ".length).trim() : "";
          if (!goal) {
            ctx.addOutput(
              [
                "",
                theme.warning("  Usage: /surgical propose <goal>"),
                theme.muted("  Example: /surgical propose add caching to login flow"),
                "",
              ].join("\n"),
            );
            return true;
          }

          const { proposeTierForGoal, logProposalFeedback, formatProposal } = await import(
            "../agent/surgical-proposer.ts"
          );

          // Gather codebase context
          const cwd = ctx.state.toolContext.cwd ?? process.cwd();
          let fileCount: number | undefined;
          let recentEdits: string[] | undefined;
          try {
            const proc = Bun.spawn(
              ["git", "diff", "--name-only", "HEAD~5", "HEAD"],
              { cwd, stdout: "pipe", stderr: "pipe" },
            );
            const out = await new Response(proc.stdout).text();
            await proc.exited;
            const edits = out.split("\n").map((l) => l.trim()).filter(Boolean);
            if (edits.length > 0) recentEdits = edits;
          } catch { /* non-git dirs OK */ }

          try {
            const proc = Bun.spawn(
              ["bash", "-c", "find . -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.tsx' -o -name '*.jsx' -o -name '*.py' -o -name '*.go' \\) | wc -l"],
              { cwd, stdout: "pipe", stderr: "pipe" },
            );
            const out = await new Response(proc.stdout).text();
            await proc.exited;
            const n = parseInt(out.trim(), 10);
            if (!isNaN(n) && n > 0) fileCount = n;
          } catch { /* best effort */ }

          const proposal = proposeTierForGoal(goal, { fileCount, recentEdits, cwd });

          ctx.addOutput(
            [
              "",
              theme.accentBold("  Surgical Tier Proposal"),
              formatProposal(proposal),
              "",
            ].join("\n"),
          );

          // Auto-apply if confidence >= 0.8
          if (proposal.confidence >= 0.8) {
            ctx.state.registry.setSurgicalGate({ enabled: true, tier: proposal.tier });
            ctx.addOutput(
              theme.success(
                `  Auto-applied: surgical mode set to ${proposal.tier} ` +
                `(confidence ${Math.round(proposal.confidence * 100)}% ≥ 80%)\n`,
              ) +
              theme.muted(
                "  Override with: /surgical narrow | /surgical medium | /surgical wide\n" +
                "  Log override feedback: /surgical propose-feedback <goal> <chosen-tier>\n",
              ),
            );

            // Log accepted feedback
            await logProposalFeedback({
              timestamp: new Date().toISOString(),
              goal,
              suggestedTier: proposal.tier,
              suggestedConfidence: proposal.confidence,
              chosenTier: proposal.tier,
              outcome: "accepted",
              chosenNumericTier: proposal.numericTier,
            });
          } else {
            ctx.addOutput(
              theme.warning(
                `  Confidence ${Math.round(proposal.confidence * 100)}% below 80% threshold.\n` +
                "  Pick a tier manually: /surgical narrow | /surgical medium | /surgical wide\n",
              ),
            );
          }

          return true;
        }

        // /surgical stats — show suggestion accuracy and calibration
        if (args === "stats") {
          const { loadProposalFeedback, computeProposalStats, formatProposalStats } = await import(
            "../agent/surgical-proposer.ts"
          );
          const feedback = await loadProposalFeedback();
          const stats = computeProposalStats(feedback);
          ctx.addOutput(formatProposalStats(stats));
          return true;
        }

        // /surgical viz — full tier confidence dashboard
        if (args === "viz" || args.startsWith("viz ")) {
          const { handleSurgicalViz } = await import("./surgical-viz.ts");
          return handleSurgicalViz(args.slice("viz".length).trim(), ctx);
        }

        // /surgical confidence — confidence distribution chart
        if (args === "confidence" || args.startsWith("confidence ")) {
          const { handleSurgicalConfidence } = await import("./surgical-viz.ts");
          return handleSurgicalConfidence(args.slice("confidence".length).trim(), ctx);
        }

        // /surgical history — recent tier decisions
        if (args === "history" || args.startsWith("history ")) {
          const { handleSurgicalHistory } = await import("./surgical-viz.ts");
          return handleSurgicalHistory(args.slice("history".length).trim(), ctx);
        }

        // /surgical <free-text> — auto-detect tier from the provided message text
        // This is the primary UX: user types what they want to do and the analyzer
        // suggests a tier before committing to it.
        const analyzer = new SurgicalScopeAnalyzer();
        const result = analyzeScopeFromIntent(args, "");
        const pct = Math.round(result.confidence * 100);

        ctx.addOutput(
          [
            "",
            theme.accentBold("  Surgical Scope Auto-Detection"),
            analyzer.formatSuggestion(result),
            "",
          ].join("\n"),
        );

        // Auto-apply when confidence is high enough (≥70%), otherwise prompt
        if (result.confidence >= 0.7) {
          const budgets: Record<"narrow" | "medium" | "wide", number> = {
            narrow: 1,
            medium: 3,
            wide: 6,
          };
          ctx.state.registry.setSurgicalGate({ enabled: true, tier: result.suggestedTier });
          ctx.addOutput(
            theme.success(
              `  Applied: surgical mode set to ${result.suggestedTier} ` +
              `(confidence ${pct}% — above 70% threshold)\n`,
            ) + theme.muted("  Override with: /surgical narrow | /surgical medium | /surgical wide\n"),
          );
        } else {
          ctx.addOutput(
            theme.warning(
              `  Confidence ${pct}% below threshold — not auto-applying.\n` +
              `  Run /surgical narrow, /surgical medium, or /surgical wide to set manually.\n`,
            ),
          );
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
    {
      name: "/tool-metrics",
      description: "Show tool execution performance metrics",
      category: "agent",
      subcommands: ["compare"],
      handler: async (args, ctx) => {
        const { getToolAnalytics } = await import("../agent/tool-analytics.ts");
        const analytics = getToolAnalytics();

        // /tool-metrics compare <goal1> <goal2>
        if (args?.startsWith("compare ")) {
          const parts = args.slice("compare ".length).trim().split(/\s+/);
          const goal1 = parts[0] ?? "";
          const goal2 = parts[1] ?? "";
          if (!goal1 || !goal2) {
            ctx.addOutput(theme.warning("\n  Usage: /tool-metrics compare <goal1> <goal2>\n"));
            return true;
          }
          const r1 = analytics.rollupByGoal(goal1);
          const r2 = analytics.rollupByGoal(goal2);
          const lines: string[] = [
            "",
            theme.accentBold("  Tool Metrics Comparison"),
            theme.muted(`  Goal A: ${goal1}   |   Goal B: ${goal2}`),
            "",
            "  " + padR("Tool", 18) + padL("Calls A", 9) + padL("Calls B", 9) +
              padL("Avg ms A", 10) + padL("Avg ms B", 10) + padL("Err% A", 8) + padL("Err% B", 8),
            "  " + "-".repeat(72),
          ];
          const allTools = new Set([
            ...r1.byTool.map((t) => t.toolName),
            ...r2.byTool.map((t) => t.toolName),
          ]);
          for (const tool of allTools) {
            const t1 = r1.byTool.find((t) => t.toolName === tool);
            const t2 = r2.byTool.find((t) => t.toolName === tool);
            lines.push(
              "  " +
                padR(tool.slice(0, 17), 18) +
                padL(t1 ? String(t1.calls) : "-", 9) +
                padL(t2 ? String(t2.calls) : "-", 9) +
                padL(t1 ? fmtMs(t1.avgDurationMs) : "-", 10) +
                padL(t2 ? fmtMs(t2.avgDurationMs) : "-", 10) +
                padL(t1 ? fmtPct(1 - t1.successRate) : "-", 8) +
                padL(t2 ? fmtPct(1 - t2.successRate) : "-", 8),
            );
          }
          lines.push("");
          ctx.addOutput(lines.join("\n"));
          return true;
        }

        // /tool-metrics <toolname> — detailed histogram for a single tool
        if (args && args.trim() && !args.startsWith("compare")) {
          const toolName = args.trim();
          const rollups = analytics.rollupByTool();
          const entry = rollups.find(
            (r) => r.toolName.toLowerCase() === toolName.toLowerCase(),
          );
          if (!entry) {
            ctx.addOutput(theme.warning(`\n  No metrics recorded for tool: ${toolName}\n`));
            return true;
          }
          const anomaly = analytics.anomalyDetect(toolName);
          const lines: string[] = [
            "",
            theme.accentBold(`  Tool Metrics: ${entry.toolName}`),
            "",
            `  Calls:        ${entry.calls}`,
            `  Errors:       ${entry.errors}  (${fmtPct(1 - entry.successRate)} error rate)`,
            `  Avg duration: ${fmtMs(entry.avgDurationMs)}`,
            `  P50 duration: ${fmtMs(entry.p50DurationMs)}`,
            `  P95 duration: ${fmtMs(entry.p95DurationMs)}`,
            `  Max duration: ${fmtMs(entry.maxDurationMs)}`,
            `  Avg output:   ${fmtBytes(entry.avgOutputBytes)}`,
            `  Total output: ${fmtBytes(entry.totalOutputBytes)}`,
          ];
          if (anomaly.outliers.length > 0) {
            lines.push("");
            lines.push(theme.warning(`  Anomalies (z > 2.5):`));
            lines.push(
              `  Baseline: mean=${fmtMs(anomaly.meanMs)} std=${fmtMs(anomaly.stdMs)}`,
            );
            for (const o of anomaly.outliers.slice(0, 5)) {
              const ts = new Date(o.timestamp).toISOString();
              lines.push(
                `    ${ts}  ${fmtMs(o.durationMs)}  z=${o.zScore.toFixed(2)}${o.isError ? "  [error]" : ""}`,
              );
            }
          }
          lines.push("");
          ctx.addOutput(lines.join("\n"));
          return true;
        }

        // /tool-metrics — ASCII table of all tools
        const rollups = analytics.rollupByTool();
        if (rollups.length === 0) {
          ctx.addOutput(theme.tertiary("\n  No tool metrics recorded yet.\n"));
          return true;
        }
        const lines: string[] = [
          "",
          theme.accentBold("  Tool Performance Metrics"),
          "",
          "  " +
            padR("Tool", 20) +
            padL("Calls", 7) +
            padL("Errors", 8) +
            padL("Succ%", 7) +
            padL("Avg ms", 9) +
            padL("P95 ms", 9) +
            padL("Avg out", 9),
          "  " + "-".repeat(69),
        ];
        for (const r of rollups) {
          lines.push(
            "  " +
              padR(r.toolName.slice(0, 19), 20) +
              padL(String(r.calls), 7) +
              padL(String(r.errors), 8) +
              padL(fmtPct(r.successRate), 7) +
              padL(fmtMs(r.avgDurationMs), 9) +
              padL(fmtMs(r.p95DurationMs), 9) +
              padL(fmtBytes(r.avgOutputBytes), 9),
          );
        }
        lines.push("");
        ctx.addOutput(lines.join("\n"));
        return true;
      },
    },
  ];
}
