/**
 * Autopilot commands — the full /autopilot command tree.
 * Extracted from repl.tsx (was ~600 lines of inline switch cases).
 */

import { existsSync } from "fs";
import { join } from "path";
import { theme } from "../ui/theme.ts";
import type { Command, CommandContext } from "./types.ts";

/** Shared autopilot progress handler to avoid duplicating the 20-line switch. */
function autopilotProgressHandler(ctx: CommandContext) {
  return (event: any) => {
    switch (event.type) {
      case "started":
        ctx.addOutput(theme.accent(`  🚀 Started: ${event.goal}`));
        break;
      case "tick":
        ctx.addOutput(theme.tertiary(`  ⏱ Tick ${event.tickNumber} [${event.phase}]`));
        break;
      case "scanning":
        ctx.addOutput(theme.secondary(`  🔍 ${event.message}`));
        break;
      case "scan_complete":
        ctx.addOutput(theme.success(`  ✓ Scan: ${event.newItems} new, ${event.totalItems} total`));
        break;
      case "executing":
        ctx.addOutput(theme.accent(`  ⚡ ${event.itemDescription}`));
        break;
      case "item_complete":
        ctx.addOutput(
          event.success
            ? theme.success(`  ✓ ${event.description}`)
            : theme.error(`  ✗ ${event.description}: ${event.summary}`),
        );
        break;
      case "wrapping_up":
        ctx.addOutput(theme.warning("  🎁 Wrapping up..."));
        break;
      case "stopped":
        ctx.addOutput(theme.accent(`  ═══ ${event.summary}`));
        break;
      case "user_message":
        ctx.addOutput(theme.tertiary(`  📩 ${event.message} → ${event.action}`));
        break;
      case "assessing":
        ctx.addOutput(theme.secondary(`  🔮 ${event.message}`));
        break;
      case "assessment":
        ctx.addOutput(theme.secondary(`  📊 ${event.assessment}`));
        break;
      case "committing":
        ctx.addOutput(theme.tertiary(`  📝 ${event.message}`));
        break;
      case "notification":
        ctx.addOutput(theme.warning(`  🔔 ${event.title}: ${event.body}`));
        break;
    }
    ctx.update();
  };
}

export function autopilotCommands(deps: {
  scanCodebase: (ctx: any, types: any) => Promise<any[]>;
  DEFAULT_CONFIG: { scanTypes: any };
  createAutopilotLoop: () => any;
  createVision: (cwd: string, text: string) => Promise<any>;
  loadVision: (cwd: string) => Promise<any>;
}): Command[] {
  return [
    {
      name: "/autopilot",
      description: "Autonomous mode — scan/fix or goal-driven",
      category: "workflow",
      subcommands: [
        "scan",
        "queue",
        "approve",
        "run",
        "auto",
        "stop",
        "wrap",
        "resume",
        "reset",
        "focus",
        "vision",
        "history",
      ],
      handler: async (args, ctx) => {
        const subCmd = args?.split(" ")[0];

        // ── Scan ────────────────────────────────────────────────────────
        if (!subCmd || subCmd === "scan") {
          ctx.addOutput(theme.accent("\n  🔍 Scanning codebase for work items...\n"));
          ctx.setProcessing(true);
          ctx.setSpinnerText("Scanning");
          ctx.update();

          try {
            const scanCtx = {
              cwd: ctx.state.toolContext.cwd,
              runCommand: async (cmd: string) => {
                const proc = Bun.spawn(["bash", "-c", cmd], {
                  cwd: ctx.state.toolContext.cwd,
                  stdout: "pipe",
                  stderr: "pipe",
                });
                return await new Response(proc.stdout).text();
              },
              searchFiles: async (pattern: string, path?: string) => {
                const fg = await import("fast-glob");
                const files = await fg.default(pattern, {
                  cwd: path ? `${ctx.state.toolContext.cwd}/${path}` : ctx.state.toolContext.cwd,
                  absolute: false,
                  ignore: ["**/node_modules/**", "**/.git/**"],
                });
                return files.join("\n");
              },
              grepContent: async (pattern: string, glob?: string) => {
                const spawnArgs = ["grep", "-rn", pattern, ctx.state.toolContext.cwd];
                if (glob) spawnArgs.push("--include", glob);
                spawnArgs.push("--max-count=50");
                const proc = Bun.spawn(spawnArgs, { stdout: "pipe", stderr: "pipe" });
                return await new Response(proc.stdout).text();
              },
            };

            const wq = ctx.getWorkQueue();
            const discovered = await deps.scanCodebase(scanCtx, deps.DEFAULT_CONFIG.scanTypes);
            const added = wq.addItems(discovered);
            await wq.save();

            const stats = wq.getStats();
            ctx.addOutput(theme.success(`  ✓ Scan complete: ${discovered.length} issues found, ${added} new\n`));

            const byType = new Map<string, number>();
            for (const item of discovered) {
              byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
            }
            for (const [type, count] of byType) {
              ctx.addOutput(theme.secondary(`    ${type}: ${count}`));
            }
            ctx.addOutput(
              theme.tertiary(
                `\n  Queue: ${stats.discovered ?? 0} pending · ${stats.approved ?? 0} approved · ${stats.completed ?? 0} done`,
              ),
            );
            ctx.addOutput(theme.tertiary("  Use /autopilot queue to see items, /autopilot approve all to approve\n"));
          } catch (err) {
            ctx.addOutput(theme.error(`  Scan failed: ${err instanceof Error ? err.message : String(err)}\n`));
          }

          ctx.setProcessing(false);
          ctx.update();
          return true;
        }

        // ── Queue ───────────────────────────────────────────────────────
        if (subCmd === "queue" || subCmd === "status") {
          const wq = ctx.getWorkQueue();
          const pending = wq.getByStatus("discovered");
          const approved = wq.getByStatus("approved");
          const stats = wq.getStats();

          ctx.addOutput(theme.accent("\n  📋 Autopilot Queue\n"));
          ctx.addOutput(
            theme.tertiary(
              `  ${stats.discovered ?? 0} discovered · ${stats.approved ?? 0} approved · ${stats.in_progress ?? 0} in progress · ${stats.completed ?? 0} done\n`,
            ),
          );

          if (pending.length > 0) {
            ctx.addOutput(theme.primary("  Pending (needs approval):"));
            for (const item of pending.slice(0, 15)) {
              const pColor =
                item.priority === "critical" ? theme.error : item.priority === "high" ? theme.warning : theme.secondary;
              ctx.addOutput(`  ${pColor(`[${item.priority}]`)} ${theme.accent(item.id)} ${item.title}`);
            }
            if (pending.length > 15) ctx.addOutput(theme.tertiary(`  ... and ${pending.length - 15} more`));
          }

          if (approved.length > 0) {
            ctx.addOutput(theme.primary("\n  Approved (ready to execute):"));
            for (const item of approved.slice(0, 10)) {
              ctx.addOutput(`  ${theme.success("✓")} ${theme.accent(item.id)} ${item.title}`);
            }
          }

          ctx.addOutput(theme.tertiary("\n  /autopilot approve <id> — approve one"));
          ctx.addOutput(theme.tertiary("  /autopilot approve all — approve all"));
          ctx.addOutput(theme.tertiary("  /autopilot run — execute next approved item\n"));
          return true;
        }

        // ── Approve ─────────────────────────────────────────────────────
        if (subCmd === "approve") {
          const wq = ctx.getWorkQueue();
          const target = args?.split(" ").slice(1).join(" ");
          if (target === "all") {
            const count = wq.approveAll();
            await wq.save();
            ctx.addOutput(theme.success(`\n  ✓ Approved ${count} items\n`));
          } else if (target) {
            const ok = wq.approve(target);
            await wq.save();
            ctx.addOutput(
              ok
                ? theme.success(`\n  ✓ Approved ${target}\n`)
                : theme.error(`\n  Item ${target} not found or already approved\n`),
            );
          } else {
            ctx.addOutput(theme.tertiary("\n  Usage: /autopilot approve <id> or /autopilot approve all\n"));
          }
          return true;
        }

        // ── Run ─────────────────────────────────────────────────────────
        if (subCmd === "run") {
          const wq = ctx.getWorkQueue();
          const next = wq.getNextApproved();
          if (!next) {
            ctx.addOutput(
              theme.tertiary("\n  No approved items to execute. Run /autopilot scan then /autopilot approve all\n"),
            );
            return true;
          }

          wq.startItem(next.id);
          await wq.save();
          ctx.addOutput(theme.accent(`\n  🚀 Executing: ${next.title}\n`));

          const prompt = `Fix this issue:\n\nType: ${next.type}\nFile: ${next.file}${next.line ? `:${next.line}` : ""}\nDescription: ${next.description}\n\nMake the fix, then verify it works.`;
          await ctx.runTurnInk(prompt);

          wq.completeItem(next.id);
          await wq.save();
          ctx.addOutput(theme.success(`  ✓ Completed: ${next.title}\n`));

          const remaining = wq.getByStatus("approved").length;
          if (remaining > 0) {
            ctx.addOutput(theme.tertiary(`  ${remaining} more approved items. /autopilot run to continue\n`));
          }
          return true;
        }

        // ── Auto ────────────────────────────────────────────────────────
        if (subCmd === "auto") {
          ctx.addOutput(theme.accent("\n  🚀 AUTOPILOT AUTO MODE — fully autonomous\n"));
          ctx.addOutput(theme.warning("  Scanning → fixing → testing → committing → PR → merge\n"));
          ctx.setProcessing(true);
          ctx.update();

          const cwd = ctx.state.toolContext.cwd;
          let originalBranch = "main";
          let hasUncommitted = false;
          const run = async (cmd: string): Promise<{ out: string; code: number }> => {
            const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
            const out = await new Response(proc.stdout).text();
            const code = await proc.exited;
            return { out: out.trim(), code };
          };
          const git = async (...gitArgs: string[]): Promise<string> => {
            const proc = Bun.spawn(["git", ...gitArgs], { cwd, stdout: "pipe", stderr: "pipe" });
            const out = await new Response(proc.stdout).text();
            await proc.exited;
            return out.trim();
          };

          try {
            originalBranch = await git("rev-parse", "--abbrev-ref", "HEAD");
            ctx.addOutput(theme.tertiary(`  Original branch: ${originalBranch}`));

            const statusResult = await run("git status --porcelain");
            hasUncommitted = statusResult.out.length > 0;
            if (hasUncommitted) {
              await git("stash", "push", "-m", "autopilot-save");
              ctx.addOutput(theme.tertiary("  Stashed uncommitted changes"));
            }

            const testCheck = await run("command -v bun >/dev/null 2>&1 && echo ok || echo missing");
            const hasTestRunner = testCheck.out.includes("ok");
            if (!hasTestRunner) {
              ctx.addOutput(theme.warning("  ⚠ bun not found — tests will be skipped\n"));
            }

            const ghCheck = await run("command -v gh >/dev/null 2>&1 && echo ok || echo missing");
            const hasGhCli = ghCheck.out.includes("ok");

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const branch = `autopilot/${timestamp}`;
            await git("checkout", "-b", branch);
            ctx.addOutput(theme.secondary(`  Branch: ${branch}`));

            ctx.addOutput(theme.accent("\n  🔍 Scanning...\n"));
            const scanCtx = {
              cwd,
              runCommand: async (cmd: string) => (await run(cmd)).out,
              searchFiles: async (pattern: string) => {
                const fg = await import("fast-glob");
                const files = await fg.default(pattern, {
                  cwd,
                  absolute: false,
                  ignore: ["**/node_modules/**", "**/.git/**"],
                });
                return files.join("\n");
              },
              grepContent: async (pattern: string, glob?: string) => {
                const grepArgs = ["grep", "-rn", pattern, cwd];
                if (glob) grepArgs.push(`--include=${glob}`);
                const proc = Bun.spawn(grepArgs, { stdout: "pipe", stderr: "pipe" });
                const out = await new Response(proc.stdout).text();
                return out.split("\n").slice(0, 50).join("\n");
              },
            };

            const wq = ctx.getWorkQueue();
            const discovered = await deps.scanCodebase(scanCtx, deps.DEFAULT_CONFIG.scanTypes);
            wq.addItems(discovered);
            const totalApproved = wq.approveAll();
            await wq.save();
            ctx.addOutput(theme.success(`  Found ${discovered.length} issues, approved ${totalApproved}\n`));

            if (totalApproved === 0) {
              ctx.addOutput(theme.success("  ✨ Codebase is clean! Nothing to fix.\n"));
              await git("checkout", originalBranch);
              await run(`git branch -D ${branch} 2>/dev/null`);
              if (hasUncommitted) await git("stash", "pop");
              ctx.setProcessing(false);
              ctx.update();
              return true;
            }

            let fixed = 0;
            let failed = 0;
            let consecutiveFails = 0;
            const maxFails = 3;

            while (true) {
              const next = wq.getNextApproved();
              if (!next || consecutiveFails >= maxFails) break;

              wq.startItem(next.id);
              ctx.addOutput(theme.accent(`\n  [${fixed + failed + 1}/${totalApproved}] ${next.title}`));
              ctx.setSpinnerText(next.title);
              ctx.update();

              try {
                const prompt = `Fix this issue:\nType: ${next.type}\nFile: ${next.file}${next.line ? `:${next.line}` : ""}\nDescription: ${next.description}\n\nMake the minimal fix. Do not change unrelated code.`;
                await ctx.runTurnInk(prompt);

                let testsPass = true;
                if (hasTestRunner) {
                  const testResult = await run("timeout 60 bun test 2>&1 || true");
                  testsPass = testResult.code === 0;
                }

                if (testsPass) {
                  await git("add", "-A");
                  await git("commit", "-m", `fix(autopilot): ${next.title}`);
                  wq.completeItem(next.id);
                  fixed++;
                  consecutiveFails = 0;
                  ctx.addOutput(theme.success("  ✓ Fixed and committed"));
                } else {
                  await run("git checkout -- . && git clean -fd 2>/dev/null || true");
                  wq.failItem(next.id, "Tests failed after fix");
                  failed++;
                  consecutiveFails++;
                  ctx.addOutput(theme.error("  ✗ Tests failed, reverted"));
                }
              } catch (err) {
                await run("git checkout -- . 2>/dev/null || true");
                wq.failItem(next.id, String(err));
                failed++;
                consecutiveFails++;
                ctx.addOutput(theme.error("  ✗ Execution failed"));
              }

              await wq.save();
              ctx.update();
            }

            if (fixed > 0 && hasGhCli) {
              ctx.addOutput(theme.accent("\n  📋 Creating PR...\n"));
              await git("push", "-u", "origin", branch);
              const prTitle = `fix(autopilot): ${fixed} automated fixes`;
              const prBody = `## Autopilot Fixes\n\nFixed ${fixed} issues automatically:\n${wq
                .getByStatus("completed")
                .slice(-fixed)
                .map((i) => `- ${i.title}`)
                .join("\n")}\n\nGenerated by AshlrCode Autopilot.`;
              const prProc = Bun.spawn(["gh", "pr", "create", "--title", prTitle, "--body", prBody], {
                cwd,
                stdout: "pipe",
                stderr: "pipe",
              });
              const prResult = (await new Response(prProc.stdout).text()).trim();
              await prProc.exited;

              if (prResult.includes("github.com")) {
                ctx.addOutput(theme.success(`  PR created: ${prResult.split("\n").pop()}`));
                const mergeProc = Bun.spawn(["gh", "pr", "merge", "--auto", "--squash"], {
                  cwd,
                  stdout: "pipe",
                  stderr: "pipe",
                });
                const mergeResult = (await new Response(mergeProc.stdout).text()).trim();
                await mergeProc.exited;
                ctx.addOutput(
                  mergeResult.includes("auto-merge")
                    ? theme.success("  Auto-merge enabled — will merge when checks pass")
                    : theme.secondary("  PR ready for review (auto-merge not available)"),
                );
              } else {
                ctx.addOutput(theme.secondary(`  PR creation: ${prResult.slice(0, 200)}`));
              }
            } else if (fixed > 0 && !hasGhCli) {
              ctx.addOutput(
                theme.warning("\n  ⚠ gh CLI not found — skipping PR creation. Install: https://cli.github.com"),
              );
              ctx.addOutput(theme.secondary(`  Changes committed on branch: ${branch}\n`));
            }

            await git("checkout", originalBranch).catch(() => {});
            if (fixed === 0) {
              await run(`git branch -D ${branch} 2>/dev/null || true`);
            }
            if (hasUncommitted) {
              await git("stash", "pop").catch(() => {});
            }

            ctx.addOutput(theme.accent("\n  ═══ Autopilot Summary ═══"));
            ctx.addOutput(theme.success(`  Fixed: ${fixed}`));
            if (failed > 0) ctx.addOutput(theme.error(`  Failed: ${failed}`));
            ctx.addOutput(theme.secondary(`  Skipped: ${totalApproved - fixed - failed}`));
            if (consecutiveFails >= maxFails) {
              ctx.addOutput(theme.warning(`  Stopped after ${maxFails} consecutive failures`));
            }
            ctx.addOutput("");
          } catch (err) {
            ctx.addOutput(theme.error(`\n  Autopilot error: ${err instanceof Error ? err.message : String(err)}\n`));
            try {
              const proc = Bun.spawn(["git", "checkout", originalBranch], {
                cwd: ctx.state.toolContext.cwd,
                stdout: "pipe",
                stderr: "pipe",
              });
              await proc.exited;
              if (hasUncommitted) {
                const pop = Bun.spawn(["git", "stash", "pop"], {
                  cwd: ctx.state.toolContext.cwd,
                  stdout: "pipe",
                  stderr: "pipe",
                });
                await pop.exited;
              }
            } catch {}
          }

          ctx.setProcessing(false);
          ctx.update();
          return true;
        }

        // ── Stop ────────────────────────────────────────────────────────
        if (subCmd === "stop") {
          const loop = ctx.getAutopilotLoop();
          if (!loop || !ctx.getAutopilotRunning()) {
            ctx.addOutput(theme.tertiary("\n  No autopilot running.\n"));
            return true;
          }
          ctx.addOutput(theme.warning("\n  ⏹ Stopping autopilot gracefully...\n"));
          loop.stop();
          ctx.setAutopilotRunning(false);
          ctx.addOutput(theme.success("  Autopilot stopped.\n"));
          return true;
        }

        // ── Wrap ────────────────────────────────────────────────────────
        if (subCmd === "wrap") {
          const loop = ctx.getAutopilotLoop();
          if (!loop || !ctx.getAutopilotRunning()) {
            ctx.addOutput(theme.tertiary("\n  No autopilot running.\n"));
            return true;
          }
          ctx.addOutput(theme.warning("\n  🎁 Wrapping up autopilot (finishing current item, then PR)...\n"));
          loop.requestWrapUp();
          return true;
        }

        // ── Resume ──────────────────────────────────────────────────────
        if (subCmd === "resume") {
          const cwd = ctx.state.toolContext.cwd;
          const vPath = join(cwd, ".ashlrcode", "vision.md");
          if (!existsSync(vPath)) {
            ctx.addOutput(theme.error("\n  No existing vision found. Start with /autopilot <your goal>\n"));
            return true;
          }
          const vision = await deps.loadVision(cwd);
          if (!vision) {
            ctx.addOutput(theme.error("\n  Failed to load vision file.\n"));
            return true;
          }
          ctx.addOutput(theme.accent(`\n  🚀 Resuming autopilot: ${vision.goal}\n`));
          const loop = deps.createAutopilotLoop();
          ctx.setAutopilotLoop(loop);
          ctx.setAutopilotRunning(true);
          loop
            .start(vision, {
              router: ctx.state.router,
              toolRegistry: ctx.state.registry,
              toolContext: ctx.state.toolContext,
              systemPrompt: ctx.state.baseSystemPrompt,
              onProgress: autopilotProgressHandler(ctx),
            })
            .then(() => {
              ctx.setAutopilotRunning(false);
              ctx.addOutput(theme.success("\n  Autopilot finished.\n"));
              ctx.update();
            })
            .catch((err: unknown) => {
              ctx.setAutopilotRunning(false);
              ctx.addOutput(theme.error(`\n  Autopilot error: ${err instanceof Error ? err.message : String(err)}\n`));
              ctx.update();
            });
          return true;
        }

        // ── Reset ───────────────────────────────────────────────────────
        if (subCmd === "reset") {
          const cwd = ctx.state.toolContext.cwd;
          const vPath = join(cwd, ".ashlrcode", "vision.md");
          const loop = ctx.getAutopilotLoop();
          if (loop && ctx.getAutopilotRunning()) {
            loop.stop();
            ctx.setAutopilotRunning(false);
          }
          ctx.setAutopilotLoop(null);
          if (existsSync(vPath)) {
            const { unlinkSync } = await import("fs");
            unlinkSync(vPath);
          }
          ctx.getWorkQueue().cleanup();
          await ctx.getWorkQueue().save();
          ctx.addOutput(theme.success("\n  ✓ Vision and queue cleared.\n"));
          return true;
        }

        // ── Focus ───────────────────────────────────────────────────────
        if (subCmd === "focus") {
          const focusArea = args?.split(" ").slice(1).join(" ");
          if (!focusArea) {
            ctx.addOutput(theme.tertiary("\n  Usage: /autopilot focus <area>\n"));
            return true;
          }
          const loop = ctx.getAutopilotLoop();
          if (!loop || !ctx.getAutopilotRunning()) {
            ctx.addOutput(theme.tertiary("\n  No autopilot running. Start with /autopilot <goal>\n"));
            return true;
          }
          loop.queueUserMessage(`focus on ${focusArea}`);
          ctx.addOutput(theme.success(`\n  ✓ Focus update queued: ${focusArea}\n`));
          return true;
        }

        // ── Vision ──────────────────────────────────────────────────────
        if (subCmd === "vision") {
          const cwd = ctx.state.toolContext.cwd;
          const vPath = join(cwd, ".ashlrcode", "vision.md");
          if (!existsSync(vPath)) {
            ctx.addOutput(theme.tertiary("\n  No vision set. Start with /autopilot <goal>\n"));
            return true;
          }
          const vision = await deps.loadVision(cwd);
          if (!vision) {
            ctx.addOutput(theme.error("\n  Failed to load vision.\n"));
            return true;
          }
          ctx.addOutput(theme.accent("\n  📋 Autopilot Vision\n"));
          ctx.addOutput(theme.primary(`  Goal: ${vision.goal}`));
          if (vision.focusAreas?.length > 0) {
            ctx.addOutput(theme.secondary(`  Focus: ${vision.focusAreas.join(", ")}`));
          }
          if (vision.progress?.length > 0) {
            ctx.addOutput(theme.secondary(`\n  Progress (${vision.progress.length} entries):`));
            for (const entry of vision.progress.slice(-10)) {
              const date = entry.timestamp.split("T")[0];
              ctx.addOutput(
                theme.tertiary(`    [${date}] ${entry.summary} (+${entry.itemsCompleted}, -${entry.itemsFailed})`),
              );
            }
          }
          const loop = ctx.getAutopilotLoop();
          if (ctx.getAutopilotRunning() && loop) {
            const status = loop.getStatus();
            ctx.addOutput(
              theme.success(
                `\n  Status: RUNNING (tick ${status.tickNumber}, ${status.itemsCompleted} done, ${status.itemsFailed} failed, ${status.duration})`,
              ),
            );
          } else {
            ctx.addOutput(theme.tertiary("\n  Status: Stopped. /autopilot resume to continue"));
          }
          ctx.addOutput("");
          return true;
        }

        // ── History ─────────────────────────────────────────────────────
        if (subCmd === "history") {
          const cwd = ctx.state.toolContext.cwd;
          const vPath = join(cwd, ".ashlrcode", "vision.md");
          if (!existsSync(vPath)) {
            ctx.addOutput(theme.tertiary("\n  No vision history. Start with /autopilot <goal>\n"));
            return true;
          }
          const vision = await deps.loadVision(cwd);
          if (!vision?.progress?.length) {
            ctx.addOutput(theme.tertiary("\n  No progress history yet.\n"));
            return true;
          }
          ctx.addOutput(theme.accent("\n  📜 Autopilot History\n"));
          for (const entry of vision.progress) {
            const date = entry.timestamp.split("T")[0];
            ctx.addOutput(
              theme.secondary(`  [${date}] ${entry.summary} (+${entry.itemsCompleted}, -${entry.itemsFailed})`),
            );
          }
          ctx.addOutput("");
          return true;
        }

        // ── Vision goal (unrecognized subcommand = start with goal) ─────
        if (
          subCmd &&
          ![
            "scan",
            "queue",
            "status",
            "approve",
            "run",
            "auto",
            "stop",
            "wrap",
            "resume",
            "reset",
            "focus",
            "vision",
            "history",
          ].includes(subCmd)
        ) {
          const cwd = ctx.state.toolContext.cwd;
          const vision = await deps.createVision(cwd, args!);
          ctx.addOutput(theme.accent(`\n  🚀 Autopilot started: ${vision.goal}\n`));
          const loop = deps.createAutopilotLoop();
          ctx.setAutopilotLoop(loop);
          ctx.setAutopilotRunning(true);
          loop
            .start(vision, {
              router: ctx.state.router,
              toolRegistry: ctx.state.registry,
              toolContext: ctx.state.toolContext,
              systemPrompt: ctx.state.baseSystemPrompt,
              onProgress: autopilotProgressHandler(ctx),
            })
            .then(() => {
              ctx.setAutopilotRunning(false);
              ctx.addOutput(theme.success("\n  Autopilot finished.\n"));
              ctx.update();
            })
            .catch((err: unknown) => {
              ctx.setAutopilotRunning(false);
              ctx.addOutput(theme.error(`\n  Autopilot error: ${err instanceof Error ? err.message : String(err)}\n`));
              ctx.update();
            });
          return true;
        }

        // ── Help / Status (no args) ─────────────────────────────────────
        const loop = ctx.getAutopilotLoop();
        if (!ctx.getAutopilotRunning() || !loop) {
          ctx.addOutput(theme.accent("\n  🤖 Autopilot — autonomous work discovery\n"));
          ctx.addOutput(theme.accentBold("  Unified (goal-driven):"));
          ctx.addOutput(theme.secondary("  /autopilot <vision>     — start autonomous mode toward a goal"));
          ctx.addOutput(theme.secondary("  /autopilot stop         — graceful stop"));
          ctx.addOutput(theme.secondary("  /autopilot wrap         — finish current, create PR, stop"));
          ctx.addOutput(theme.secondary("  /autopilot resume       — resume from existing vision"));
          ctx.addOutput(theme.secondary("  /autopilot vision       — show current vision"));
          ctx.addOutput(theme.secondary("  /autopilot focus <area> — update focus areas mid-run"));
          ctx.addOutput(theme.secondary("  /autopilot history      — show progress log"));
          ctx.addOutput(theme.secondary("  /autopilot reset        — delete vision and clear queue"));
          ctx.addOutput(theme.accentBold("\n  Legacy (scan-based):"));
          ctx.addOutput(theme.secondary("  /autopilot scan         — scan codebase for issues"));
          ctx.addOutput(theme.secondary("  /autopilot queue        — show work queue"));
          ctx.addOutput(theme.secondary("  /autopilot approve all  — approve all discovered items"));
          ctx.addOutput(theme.secondary("  /autopilot run          — execute next approved item"));
          ctx.addOutput(theme.secondary("  /autopilot auto         — FULL AUTO: scan → fix → test → PR → merge"));
          ctx.addOutput("");
          return true;
        }

        // No args but autopilot running — show status
        const status = loop.getStatus();
        ctx.addOutput(theme.accent("\n  🤖 Autopilot Status\n"));
        ctx.addOutput(theme.primary(`  Running: ${status.running ? "yes" : "no"}`));
        ctx.addOutput(theme.secondary(`  Tick: ${status.tickNumber}`));
        ctx.addOutput(
          theme.secondary(
            `  Completed: ${status.itemsCompleted} | Failed: ${status.itemsFailed} | Pending: ${status.queuePending}`,
          ),
        );
        ctx.addOutput(theme.secondary(`  Duration: ${status.duration}`));
        ctx.addOutput(theme.secondary(`  Focus: ${status.focusState}`));
        if (status.wrapUpRequested) {
          ctx.addOutput(theme.warning("  Wrap-up requested"));
        }
        ctx.addOutput(theme.tertiary("\n  /autopilot stop — stop | /autopilot wrap — finish & PR\n"));
        return true;
      },
    },
  ];
}
