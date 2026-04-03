/**
 * Ink-based REPL — replaces readline for interactive mode.
 *
 * Manages display state and bridges between the agent loop callbacks
 * and the Ink React component tree.
 */

import React from "react";
import { render } from "ink";
import { App } from "./ui/App.tsx";
import { runAgentLoop } from "./agent/loop.ts";
import { getCurrentMode, cycleMode, getPromptForMode } from "./ui/mode.ts";
import { getEffort, setEffort, cycleEffort, getEffortConfig, getEffortEmoji, type EffortLevel } from "./ui/effort.ts";
import { estimateTokens, getProviderContextLimit, needsCompaction, autoCompact, snipCompact, contextCollapse } from "./agent/context.ts";
import { renderMarkdownDelta, flushMarkdown, resetMarkdown } from "./ui/markdown.ts";
import { getBuddyReaction, getBuddyArt, isFirstToolCall, recordThinking, recordToolCallSuccess, recordError, saveBuddy, startBuddyAnimation, stopBuddyAnimation } from "./ui/buddy.ts";
import { renderBuddyWithBubble } from "./ui/speech-bubble.ts";
import { isPlanMode, getPlanModePrompt } from "./planning/plan-mode.ts";
import { categorizeError } from "./agent/error-handler.ts";
import { theme } from "./ui/theme.ts";
import chalk from "chalk";
import type { ProviderRouter } from "./providers/router.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";
import type { Message } from "./providers/types.ts";
import type { Session } from "./persistence/session.ts";
import type { SkillRegistry } from "./skills/registry.ts";
import type { BuddyData } from "./ui/buddy.ts";
import { shutdownLSP } from "./tools/lsp.ts";
import { setBypassMode } from "./config/permissions.ts";
import { listFeatures } from "./config/features.ts";
import { hasPendingQuestion, answerPendingQuestion } from "./tools/ask-user.ts";
import { generateBuddyComment, shouldUseAI, type BuddyCommentType } from "./ui/buddy-ai.ts";
import { scanCodebase } from "./autopilot/scanner.ts";
import { WorkQueue } from "./autopilot/queue.ts";
import { DEFAULT_CONFIG } from "./autopilot/types.ts";
import { generateDream, loadRecentDreams, formatDreamsForPrompt, IdleDetector } from "./agent/dream.ts";
import { FileHistoryStore, setFileHistory, getFileHistory } from "./state/file-history.ts";
import { loadKeybindings, getBindings, InputHistory } from "./ui/keybindings.ts";
import { SpeculationCache } from "./agent/speculation.ts";
import { setSpeculationCache } from "./agent/tool-executor.ts";

// Buddy quips (imported from banner for status line)
const QUIPS: Record<string, string[]> = {
  happy: [
    "ship it, yolo",
    "lgtm, didn't read a damn thing",
    "tests are for people with trust issues",
    "it works on my machine, deploy it",
    "that code is mid but whatever",
    "we move fast and break stuff here",
    "clean code is for nerds",
    "have you tried turning it off and never back on",
    "git push --force and pray",
    "code review? I am the code review",
    "technically it compiles",
    "the real bugs were the friends we made",
    "this is either genius or insanity",
    "stack overflow told me to do this",
    "my therapist says I should stop enabling devs",
  ],
  thinking: [
    "hold on, downloading more brain...",
    "consulting my imaginary friend",
    "pretending to understand your code",
    "asking chatgpt for help (jk... unless?)",
    "processing... or napping, hard to tell",
    "my last brain cell is working overtime",
    "calculating the meaning of your spaghetti code",
    "I've seen worse... actually no I haven't",
    "trying not to hallucinate here",
    "one sec, arguing with myself",
  ],
  sleepy: [
    "*yawns in binary*",
    "do we HAVE to code right now?",
    "I was having a great dream about typescript",
    "loading enthusiasm... 404 not found",
    "five more minutes...",
    "my motivation called in sick today",
    "I'm not lazy, I'm energy efficient",
    "can we just deploy yesterday's code again?",
  ],
};
let quipIdx = Math.floor(Math.random() * 10);
function getQuip(mood: string): string {
  const q = QUIPS[mood] ?? QUIPS.sleepy!;
  quipIdx = (quipIdx + 1) % q.length;
  return q[quipIdx]!;
}

interface ReplState {
  router: ProviderRouter;
  registry: ToolRegistry;
  toolContext: ToolContext;
  session: Session;
  history: Message[];
  baseSystemPrompt: string;
  skillRegistry: SkillRegistry;
  buddy: BuddyData;
}

export function startInkRepl(state: ReplState, maxCostUSD: number): void {
  // Ink owns stdin in raw mode — readline prompts would deadlock.
  setBypassMode(true);
  startBuddyAnimation();

  // Autopilot work queue
  const workQueue = new WorkQueue(state.toolContext.cwd);
  workQueue.load().catch(() => {});

  // File history for undo support
  const fileHistoryStore = new FileHistoryStore(state.session.id);
  setFileHistory(fileHistoryStore);
  fileHistoryStore.loadFromDisk().catch(() => {});

  // Speculation cache — pre-fetches likely read-only tool results
  const speculationCache = new SpeculationCache(100, 30_000);
  setSpeculationCache(speculationCache);

  // Keybindings & input history
  loadKeybindings().catch(() => {});
  const inputHistory = new InputHistory();

  // Load dreams from previous sessions into system prompt
  loadRecentDreams(3).then(dreams => {
    if (dreams.length > 0) {
      const dreamContext = formatDreamsForPrompt(dreams);
      state.baseSystemPrompt += "\n\n" + dreamContext;
    }
  }).catch(() => {});

  // Idle detector — generate dream when user is idle for 2 minutes
  const idleDetector = new IdleDetector(async () => {
    if (state.history.length > 4) {
      await generateDream(state.history, state.session.id).catch(() => {});
    }
  }, 120_000);

  let items: Array<{ id: number; text: string }> = [
    { id: 0, text: theme.warning("  ⚠ All tools auto-approved (Ink mode). Use with care.") },
  ];
  let nextId = 1;
  let turnCount = 0;
  let currentQuipType: BuddyCommentType = "quip";
  let cachedQuip = getQuip(state.buddy.mood); // Cache quip — don't regenerate on every render
  let lastToolName = "";
  let lastToolResult = "";
  let lastHadError = false;
  let aiCommentGen = 0; // Guards against stale AI callbacks overwriting mid-turn
  let aiCommentInFlight = false;
  let isProcessing = false;
  let spinnerText = "Thinking";
  const formatTk = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : `${n}`;

  const MAX_ITEMS = 2000;

  function addOutput(text: string) {
    items = [...items.slice(-MAX_ITEMS), { id: nextId++, text }];
    update();
  }

  function getDisplayProps() {
    const ctxLimit = getProviderContextLimit(state.router.currentProvider.name);
    const ctxUsed = estimateTokens(state.history);
    const ctxPct = Math.round((ctxUsed / ctxLimit) * 100);
    const mode = getCurrentMode();
    const modeColors: Record<string, string> = { normal: "green", plan: "magenta", "accept-edits": "yellow", yolo: "red" };

    const effort = getEffort();
    const effortDisplay = effort !== "normal" ? ` ${getEffortEmoji()} ${effort}` : "";

    return {
      mode: mode + effortDisplay,
      modeColor: modeColors[mode] ?? "green",
      contextPercent: ctxPct,
      contextUsed: formatTk(ctxUsed),
      contextLimit: formatTk(ctxLimit),
      buddyName: state.buddy.name,
      buddyQuip: cachedQuip,
      buddyQuipType: currentQuipType,
      buddyArt: getBuddyArt(state.buddy),
      items,
      isProcessing,
      spinnerText,
      commands: [
        "/help", "/cost", "/status", "/effort", "/btw", "/history", "/undo",
        "/restore", "/tools", "/skills", "/buddy", "/memory", "/sessions",
        "/model", "/compact", "/diff", "/git", "/clear", "/quit",
        "/autopilot", "/autopilot scan", "/autopilot queue", "/autopilot auto",
        "/autopilot approve all", "/autopilot run", "/features", "/keybindings",
        ...state.skillRegistry.getAll().map(s => s.trigger),
      ],
    };
  }

  async function handleSubmit(input: string) {
    idleDetector.ping();
    inputHistory.push(input);

    // If the AskUser tool is waiting for an answer, route the input there
    // instead of starting a new agent turn.
    if (hasPendingQuestion()) {
      answerPendingQuestion(input);
      return;
    }

    // Prevent concurrent turns
    if (isProcessing) return;

    // Detect image file paths (drag-and-drop inserts path as text)
    const imageMatch = input.match(/(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp))(?:\s|$)/i)
      ?? input.match(/(?:^|\s)([^\s]+\.(?:png|jpg|jpeg|gif|webp))(?:\s|$)/i);

    if (imageMatch) {
      const imagePath = imageMatch[1]!;
      const textPart = input.replace(imagePath, "").trim() || "Describe this image.";
      try {
        const { existsSync } = await import("fs");
        const { readFile } = await import("fs/promises");
        const { resolve } = await import("path");

        const fullPath = resolve(state.toolContext.cwd, imagePath);
        if (existsSync(fullPath)) {
          const buffer = await readFile(fullPath);
          const base64 = buffer.toString("base64");
          const ext = fullPath.split(".").pop()?.toLowerCase() ?? "png";
          const mime = ext === "jpg" ? "jpeg" : ext;

          addOutput(theme.accent(`\n  📎 [Image: ${imagePath.split("/").pop()}]\n`));
          addOutput(theme.secondary(`  ${textPart}\n`));

          // Send as multimodal message with image
          await runTurnInkWithImage(textPart, `data:image/${mime};base64,${base64}`);
          return;
        }
      } catch {}
    }

    // Smart paste: collapse long multi-line text
    const lines = input.split("\n");
    let displayInput = input;
    if (lines.length > 10) {
      displayInput = `[Pasted ${lines.length} lines]`;
    }

    // Handle built-in commands
    if (input.startsWith("/")) {
      // Skills
      if (state.skillRegistry.isSkill(input.split(" ")[0]!)) {
        const expanded = state.skillRegistry.expand(input);
        if (expanded) {
          addOutput(theme.accent(`\n  ⚡ Running skill: ${input.split(" ")[0]}\n`));
          await runTurnInk(expanded);
          return;
        }
      }

      // Commands
      const handled = await handleCommand(input);
      if (handled) return;
    }

    await runTurnInk(input, displayInput);
  }

  /** Run with image attachment */
  async function runTurnInkWithImage(text: string, imageDataUrl: string) {
    isProcessing = true; spinnerText = "Analyzing image"; update();
    try {
      const systemPrompt = state.baseSystemPrompt + getPlanModePrompt();
      const userMsg: import("./providers/types.ts").Message = { role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text }] };
      const preTurn = state.history.length;
      state.history.push(userMsg);
      const result = await runAgentLoop("", state.history, { systemPrompt, router: state.router, toolRegistry: state.registry, toolContext: state.toolContext, readOnly: isPlanMode(), onText: (t) => { isProcessing = false; addOutput(t); update(); }, onToolStart: (name) => { isProcessing = true; spinnerText = name; update(); }, onToolEnd: (_n, r, e) => { isProcessing = false; addOutput((e ? theme.error("  ✗ ") : theme.success("  ✓ ")) + r.split("\n")[0]?.slice(0, 90)); update(); } });
      state.history.length = 0; state.history.push(...result.messages);
      const newMsgs = result.messages.slice(preTurn);
      if (newMsgs.length > 0) await state.session.appendMessages(newMsgs);
    } catch (err) { addOutput(theme.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`)); }
    isProcessing = false; update();
  }

  async function handleCommand(input: string): Promise<boolean> {
    const [cmd, ...rest] = input.split(" ");
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "/help":
        addOutput(`\nCommands: /plan /cost /status /effort /btw /history /undo /restore /tools /skills /buddy /memory /sessions /model /compact /diff /git /features /keybindings /clear /help /quit\n`);
        return true;
      case "/cost":
        addOutput("\n" + state.router.getCostSummary() + "\n");
        return true;
      case "/clear":
        state.history.length = 0;
        addOutput(theme.secondary("\n  Conversation cleared.\n"));
        return true;
      case "/quit":
      case "/exit":
      case "/q":
        addOutput("\n" + state.router.getCostSummary());
        saveBuddy(state.buddy).then(() => process.exit(0));
        return true;
      case "/buddy":
        addOutput(`\n  ${state.buddy.name} (${state.buddy.species}) — mood: ${state.buddy.mood}\n  Sessions: ${state.buddy.totalSessions} · Tool calls: ${state.buddy.toolCalls}\n`);
        return true;
      case "/tools":
        const tools = state.registry.getAll();
        addOutput(`\n  ${tools.length} tools: ${tools.map(t => t.name).join(", ")}\n`);
        return true;
      case "/skills":
        const skills = state.skillRegistry.getAll();
        addOutput(`\n  ${skills.length} skills: ${skills.map(s => s.trigger).join(", ")}\n`);
        return true;
      case "/model":
        if (arg) {
          const aliases: Record<string, string> = {
            "grok-fast": "grok-4-1-fast-reasoning", "grok-4": "grok-4-0314",
            "grok-3": "grok-3-fast", "sonnet": "claude-sonnet-4-6-20250514",
            "opus": "claude-opus-4-6-20250514", "llama": "llama3.2", "local": "llama3.2",
          };
          state.router.currentProvider.config.model = aliases[arg] ?? arg;
          addOutput(theme.success(`\n  Model: ${state.router.currentProvider.config.model}\n`));
        } else {
          addOutput(`\n  ${state.router.currentProvider.name}:${state.router.currentProvider.config.model}\n`);
        }
        return true;
      case "/effort": {
        if (arg && ["low", "normal", "high"].includes(arg)) {
          setEffort(arg as EffortLevel);
          addOutput(theme.success(`\n  Effort: ${getEffortEmoji()} ${arg}\n`));
        } else {
          const next = cycleEffort();
          addOutput(theme.success(`\n  Effort: ${getEffortEmoji()} ${next}\n`));
        }
        return true;
      }
      case "/autopilot": {
        const subCmd = arg?.split(" ")[0];

        if (!subCmd || subCmd === "scan") {
          // Run scan
          addOutput(theme.accent("\n  🔍 Scanning codebase for work items...\n"));
          isProcessing = true;
          spinnerText = "Scanning";
          update();

          try {
            const scanCtx = {
              cwd: state.toolContext.cwd,
              runCommand: async (cmd: string) => {
                const proc = Bun.spawn(["bash", "-c", cmd], {
                  cwd: state.toolContext.cwd, stdout: "pipe", stderr: "pipe",
                });
                return await new Response(proc.stdout).text();
              },
              searchFiles: async (pattern: string, path?: string) => {
                const fg = await import("fast-glob");
                const files = await fg.default(pattern, {
                  cwd: path ? `${state.toolContext.cwd}/${path}` : state.toolContext.cwd,
                  absolute: false, ignore: ["**/node_modules/**", "**/.git/**"],
                });
                return files.join("\n");
              },
              grepContent: async (pattern: string, glob?: string) => {
                const args = ["bash", "-c", `grep -rn '${pattern}' ${state.toolContext.cwd} ${glob ? `--include='${glob}'` : ""} 2>/dev/null | head -50`];
                const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
                return await new Response(proc.stdout).text();
              },
            };

            const discovered = await scanCodebase(scanCtx, DEFAULT_CONFIG.scanTypes);
            const added = workQueue.addItems(discovered);
            await workQueue.save();

            const stats = workQueue.getStats();
            addOutput(theme.success(`  ✓ Scan complete: ${discovered.length} issues found, ${added} new\n`));

            // Show summary by type
            const byType = new Map<string, number>();
            for (const item of discovered) {
              byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
            }
            for (const [type, count] of byType) {
              addOutput(theme.secondary(`    ${type}: ${count}`));
            }

            addOutput(theme.tertiary(`\n  Queue: ${stats.discovered ?? 0} pending · ${stats.approved ?? 0} approved · ${stats.completed ?? 0} done`));
            addOutput(theme.tertiary(`  Use /autopilot queue to see items, /autopilot approve all to approve\n`));

          } catch (err) {
            addOutput(theme.error(`  Scan failed: ${err instanceof Error ? err.message : String(err)}\n`));
          }

          isProcessing = false;
          update();
          return true;
        }

        if (subCmd === "queue" || subCmd === "status") {
          const pending = workQueue.getByStatus("discovered");
          const approved = workQueue.getByStatus("approved");
          const stats = workQueue.getStats();

          addOutput(theme.accent(`\n  📋 Autopilot Queue\n`));
          addOutput(theme.tertiary(`  ${stats.discovered ?? 0} discovered · ${stats.approved ?? 0} approved · ${stats.in_progress ?? 0} in progress · ${stats.completed ?? 0} done\n`));

          if (pending.length > 0) {
            addOutput(theme.primary("  Pending (needs approval):"));
            for (const item of pending.slice(0, 15)) {
              const pColor = item.priority === "critical" ? theme.error : item.priority === "high" ? theme.warning : theme.secondary;
              addOutput(`  ${pColor(`[${item.priority}]`)} ${theme.accent(item.id)} ${item.title}`);
            }
            if (pending.length > 15) addOutput(theme.tertiary(`  ... and ${pending.length - 15} more`));
          }

          if (approved.length > 0) {
            addOutput(theme.primary("\n  Approved (ready to execute):"));
            for (const item of approved.slice(0, 10)) {
              addOutput(`  ${theme.success("✓")} ${theme.accent(item.id)} ${item.title}`);
            }
          }

          addOutput(theme.tertiary(`\n  /autopilot approve <id> — approve one`));
          addOutput(theme.tertiary(`  /autopilot approve all — approve all`));
          addOutput(theme.tertiary(`  /autopilot run — execute next approved item\n`));
          return true;
        }

        if (subCmd === "approve") {
          const target = arg?.split(" ").slice(1).join(" ");
          if (target === "all") {
            const count = workQueue.approveAll();
            await workQueue.save();
            addOutput(theme.success(`\n  ✓ Approved ${count} items\n`));
          } else if (target) {
            const ok = workQueue.approve(target);
            await workQueue.save();
            addOutput(ok ? theme.success(`\n  ✓ Approved ${target}\n`) : theme.error(`\n  Item ${target} not found or already approved\n`));
          } else {
            addOutput(theme.tertiary("\n  Usage: /autopilot approve <id> or /autopilot approve all\n"));
          }
          return true;
        }

        if (subCmd === "run") {
          const next = workQueue.getNextApproved();
          if (!next) {
            addOutput(theme.tertiary("\n  No approved items to execute. Run /autopilot scan then /autopilot approve all\n"));
            return true;
          }

          workQueue.startItem(next.id);
          await workQueue.save();
          addOutput(theme.accent(`\n  🚀 Executing: ${next.title}\n`));

          // Execute through the agent loop
          const prompt = `Fix this issue:\n\nType: ${next.type}\nFile: ${next.file}${next.line ? `:${next.line}` : ""}\nDescription: ${next.description}\n\nMake the fix, then verify it works.`;
          await runTurnInk(prompt);

          workQueue.completeItem(next.id);
          await workQueue.save();
          addOutput(theme.success(`  ✓ Completed: ${next.title}\n`));

          // Check for more
          const remaining = workQueue.getByStatus("approved").length;
          if (remaining > 0) {
            addOutput(theme.tertiary(`  ${remaining} more approved items. /autopilot run to continue\n`));
          }
          return true;
        }

        if (subCmd === "auto") {
          // Full autonomous loop: scan → approve → fix → test → commit → PR → merge
          addOutput(theme.accent("\n  🚀 AUTOPILOT AUTO MODE — fully autonomous\n"));
          addOutput(theme.warning("  Scanning → fixing → testing → committing → PR → merge\n"));
          isProcessing = true;
          update();

          try {
            const cwd = state.toolContext.cwd;
            // Safe shell runner — returns stdout + exit code
            const run = async (cmd: string): Promise<{ out: string; code: number }> => {
              const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
              const out = await new Response(proc.stdout).text();
              const code = await proc.exited;
              return { out: out.trim(), code };
            };
            // Safe git commands using argument arrays (no shell injection)
            const git = async (...args: string[]): Promise<string> => {
              const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
              const out = await new Response(proc.stdout).text();
              await proc.exited;
              return out.trim();
            };

            // 1. Create autopilot branch
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const branch = `autopilot/${timestamp}`;
            await git("checkout", "-b", branch);
            addOutput(theme.secondary(`  Branch: ${branch}`));

            // 2. Scan
            addOutput(theme.accent("\n  🔍 Scanning...\n"));
            const scanCtx = {
              cwd,
              runCommand: async (cmd: string) => (await run(cmd)).out,
              searchFiles: async (pattern: string) => {
                const fg = await import("fast-glob");
                const files = await fg.default(pattern, { cwd, absolute: false, ignore: ["**/node_modules/**", "**/.git/**"] });
                return files.join("\n");
              },
              grepContent: async (pattern: string, glob?: string) => {
                const args = ["grep", "-rn", pattern, cwd];
                if (glob) args.push(`--include=${glob}`);
                const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
                const out = await new Response(proc.stdout).text();
                return out.split("\n").slice(0, 50).join("\n");
              },
            };
            const discovered = await scanCodebase(scanCtx, DEFAULT_CONFIG.scanTypes);
            workQueue.addItems(discovered);
            const totalApproved = workQueue.approveAll();
            await workQueue.save();
            addOutput(theme.success(`  Found ${discovered.length} issues, approved ${totalApproved}\n`));

            if (totalApproved === 0) {
              addOutput(theme.success("  ✨ Codebase is clean! Nothing to fix.\n"));
              await run("git checkout main 2>/dev/null || git checkout master");
              await run(`git branch -D ${branch} 2>/dev/null`);
              isProcessing = false;
              update();
              return true;
            }

            // 3. Fix each item
            let fixed = 0;
            let failed = 0;
            let consecutiveFails = 0;
            const maxFails = 3;

            while (true) {
              const next = workQueue.getNextApproved();
              if (!next || consecutiveFails >= maxFails) break;

              workQueue.startItem(next.id);
              addOutput(theme.accent(`\n  [${fixed + failed + 1}/${totalApproved}] ${next.title}`));
              spinnerText = next.title;
              update();

              try {
                // Execute fix
                const prompt = `Fix this issue:\nType: ${next.type}\nFile: ${next.file}${next.line ? `:${next.line}` : ""}\nDescription: ${next.description}\n\nMake the minimal fix. Do not change unrelated code.`;
                await runTurnInk(prompt);

                // Run tests — check exit code, not string matching
                const testResult = await run("bun test 2>&1");
                const testsPass = testResult.code === 0;

                if (testsPass) {
                  // Commit the fix (safe — no shell interpolation of title)
                  await git("add", "-A");
                  await git("commit", "-m", `fix(autopilot): ${next.title}`);
                  workQueue.completeItem(next.id);
                  fixed++;
                  consecutiveFails = 0;
                  addOutput(theme.success(`  ✓ Fixed and committed`));
                } else {
                  // Revert and skip
                  await run("git checkout -- . && git clean -fd 2>/dev/null || true");
                  workQueue.failItem(next.id, "Tests failed after fix");
                  failed++;
                  consecutiveFails++;
                  addOutput(theme.error(`  ✗ Tests failed, reverted`));
                }
              } catch (err) {
                await run("git checkout -- . 2>/dev/null || true");
                workQueue.failItem(next.id, String(err));
                failed++;
                consecutiveFails++;
                addOutput(theme.error(`  ✗ Execution failed`));
              }

              await workQueue.save();
              update();
            }

            // 4. Create PR and auto-merge
            if (fixed > 0) {
              addOutput(theme.accent("\n  📋 Creating PR...\n"));
              // Push the branch to remote first (PR needs remote commits)
              await git("push", "-u", "origin", branch);

              const prTitle = `fix(autopilot): ${fixed} automated fixes`;
              const prBody = `## Autopilot Fixes\n\nFixed ${fixed} issues automatically:\n${workQueue.getByStatus("completed").slice(-fixed).map(i => `- ${i.title}`).join("\n")}\n\nGenerated by AshlrCode Autopilot.`;
              // Use Bun.spawn for safe PR creation (no shell injection from titles)
              const prProc = Bun.spawn(["gh", "pr", "create", "--title", prTitle, "--body", prBody], { cwd, stdout: "pipe", stderr: "pipe" });
              const prResult = (await new Response(prProc.stdout).text()).trim();
              await prProc.exited;

              if (prResult.includes("github.com")) {
                addOutput(theme.success(`  PR created: ${prResult.split("\n").pop()}`));

                // Auto-merge if tests pass
                const mergeProc = Bun.spawn(["gh", "pr", "merge", "--auto", "--squash"], { cwd, stdout: "pipe", stderr: "pipe" });
                const mergeResult = (await new Response(mergeProc.stdout).text()).trim();
                await mergeProc.exited;
                if (mergeResult.includes("auto-merge")) {
                  addOutput(theme.success(`  Auto-merge enabled — will merge when checks pass`));
                } else {
                  addOutput(theme.secondary(`  PR ready for review (auto-merge not available)`));
                }
              } else {
                addOutput(theme.secondary(`  PR creation: ${prResult.slice(0, 200)}`));
              }
            }

            // 5. Switch back to main + clean up branch
            await run("git checkout main 2>/dev/null || git checkout master 2>/dev/null || true");
            await run(`git branch -D ${branch} 2>/dev/null || true`);

            // Summary
            addOutput(theme.accent(`\n  ═══ Autopilot Summary ═══`));
            addOutput(theme.success(`  Fixed: ${fixed}`));
            if (failed > 0) addOutput(theme.error(`  Failed: ${failed}`));
            addOutput(theme.secondary(`  Skipped: ${totalApproved - fixed - failed}`));
            if (consecutiveFails >= maxFails) {
              addOutput(theme.warning(`  Stopped after ${maxFails} consecutive failures`));
            }
            addOutput("");

          } catch (err) {
            addOutput(theme.error(`\n  Autopilot error: ${err instanceof Error ? err.message : String(err)}\n`));
            // Try to get back to main
            try {
              const proc = Bun.spawn(["bash", "-c", "git checkout main 2>/dev/null || git checkout master"], { cwd: state.toolContext.cwd, stdout: "pipe", stderr: "pipe" });
              await proc.exited;
            } catch {}
          }

          isProcessing = false;
          update();
          return true;
        }

        // Help
        addOutput(theme.accent("\n  🤖 Autopilot — autonomous work discovery\n"));
        addOutput(theme.secondary("  /autopilot scan         — scan codebase for issues"));
        addOutput(theme.secondary("  /autopilot queue        — show work queue"));
        addOutput(theme.secondary("  /autopilot approve all  — approve all discovered items"));
        addOutput(theme.secondary("  /autopilot run          — execute next approved item"));
        addOutput(theme.secondary("  /autopilot auto         — FULL AUTO: scan → fix → test → PR → merge"));
        addOutput(theme.tertiary("\n  Manual: scan → queue → approve → run"));
        addOutput(theme.tertiary("  Auto:   /autopilot auto (does everything)\n"));
        return true;
      }

      case "/keybindings": {
        const binds = getBindings();
        const kbLines = binds.map(b =>
          `  ${b.key.padEnd(18)} ${b.action.padEnd(16)} ${b.description ?? ""}`
        );
        addOutput(`\n  Keybindings:\n${kbLines.join("\n")}\n`);
        addOutput(theme.tertiary("  Customize: ~/.ashlrcode/keybindings.json\n"));
        return true;
      }

      case "/features": {
        const flags = listFeatures();
        const lines = Object.entries(flags).map(([k, v]) =>
          `  ${v ? theme.success("✓") : theme.error("✗")} ${k}`
        );
        addOutput(`\n  Feature Flags:\n${lines.join("\n")}\n`);
        return true;
      }

      case "/undo": {
        const fh = getFileHistory();
        if (!fh || fh.undoCount === 0) {
          addOutput(theme.tertiary("\n  Nothing to undo.\n"));
          return true;
        }
        const result = await fh.undoLast();
        if (result) {
          addOutput(theme.success(`\n  Restored: ${result.filePath}\n`));
          addOutput(theme.tertiary(`  ${fh.undoCount} more undo(s) available\n`));
        }
        return true;
      }

      case "/history": {
        const fhHist = getFileHistory();
        if (!fhHist || fhHist.undoCount === 0) {
          addOutput(theme.tertiary("\n  No file history.\n"));
          return true;
        }
        const snaps = fhHist.getHistory();
        addOutput(theme.secondary("\n  File History (newest first):\n"));
        for (const snap of snaps.slice(0, 20)) {
          const time = new Date(snap.timestamp).toLocaleTimeString();
          const label = snap.content === "" ? "(new file)" : "(modified)";
          addOutput(`  ${theme.tertiary(time)} ${snap.tool.padEnd(6)} ${label} ${snap.filePath}\n`);
        }
        if (snaps.length > 20) {
          addOutput(theme.tertiary(`  ... and ${snaps.length - 20} more\n`));
        }
        addOutput(theme.tertiary(`\n  ${fhHist.undoCount} undo(s) available. Use /undo to restore.\n`));
        return true;
      }

      default:
        if (cmd?.startsWith("/")) {
          addOutput(theme.tertiary(`\n  Unknown command: ${cmd}\n`));
          return true;
        }
        return false;
    }
  }

  async function runTurnInk(input: string, displayText?: string) {
    isProcessing = true;
    spinnerText = "Thinking";
    update();

    // Echo — use displayText for smart paste collapse
    const echo = displayText ?? input;
    addOutput("\n" + theme.accent("  ❯ ") + theme.primary(echo.length > 200 ? echo.slice(0, 197) + "..." : echo) + "\n");

    try {
      const effortConfig = getEffortConfig();
      const systemPrompt = state.baseSystemPrompt + getPlanModePrompt() + effortConfig.systemPromptSuffix;
      const systemTokens = Math.ceil(systemPrompt.length / 4);
      const contextLimit = getProviderContextLimit(state.router.currentProvider.name);

      if (needsCompaction(state.history, systemTokens, { maxContextTokens: contextLimit })) {
        addOutput(theme.tertiary("  [compacting context...]"));
        state.history = contextCollapse(state.history);
        state.history = snipCompact(state.history);
        state.history = await autoCompact(state.history, state.router);

        // Persist compact boundary to session log
        const summary = state.history.slice(-5).map(m => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `${m.role}: ${c.slice(0, 150)}`;
        }).join("\n");
        await state.session.insertCompactBoundary(summary, state.history.length).catch(() => {});
      }

      resetMarkdown();
      const preTurnMessageCount = state.history.length;

      // Update turn number on context so file snapshots track which turn modified them
      state.toolContext.turnNumber = turnCount;

      let responseText = "";

      const result = await runAgentLoop(input, state.history, {
        systemPrompt,
        maxIterations: effortConfig.maxIterations,
        router: state.router,
        toolRegistry: state.registry,
        toolContext: state.toolContext,
        readOnly: isPlanMode(),
        onText: (text) => {
          isProcessing = false;
          responseText += text;
          // Only flush COMPLETE lines to Static (they can't be re-rendered)
          const lines = responseText.split("\n");
          if (lines.length > 1) {
            for (let i = 0; i < lines.length - 1; i++) {
              addOutput(lines[i]!);
            }
            responseText = lines[lines.length - 1]!;
          }
          // Partial line stays in spinnerText for live display (re-renderable)
          spinnerText = responseText;
          update();
        },
        onToolStart: (name, toolInput) => {
          isProcessing = true;
          spinnerText = name;
          recordThinking(state.buddy);
          const preview = typeof toolInput.command === "string" ? `$ ${toolInput.command}` :
            typeof toolInput.file_path === "string" ? String(toolInput.file_path) :
            typeof toolInput.pattern === "string" ? `/${toolInput.pattern}/` :
            typeof toolInput.question === "string" ? toolInput.question.toString().slice(0, 60) :
            typeof toolInput.query === "string" ? toolInput.query.toString().slice(0, 60) :
            typeof toolInput.description === "string" ? toolInput.description.toString().slice(0, 60) :
            "";
          addOutput(`\n  ${theme.toolIcon("◆")} ${theme.toolName(name)}`);
          addOutput(theme.tertiary(`    ${preview}`));
          if (isFirstToolCall()) {
            addOutput(getBuddyReaction(state.buddy, "first_tool"));
          }
          update();
        },
        onToolEnd: (_name, result, isError) => {
          isProcessing = false;
          lastToolName = _name;
          lastToolResult = result.slice(0, 50);
          if (isError) { recordError(state.buddy); lastHadError = true; }
          else recordToolCallSuccess(state.buddy);
          const status = isError ? theme.error("  ✗") : theme.success("  ✓");
          const lines = result.split("\n");
          const preview = lines[0]?.slice(0, 90) ?? "";
          const extra = lines.length > 1 ? theme.tertiary(` (+${lines.length - 1} lines)`) : "";
          addOutput(`${status} ${theme.toolResult(preview)}${extra}`);
          if (isError) addOutput(getBuddyReaction(state.buddy, "error"));
          update();
        },
      });

      // Flush remaining text
      if (responseText) addOutput(responseText);

      // Update history
      state.history.length = 0;
      state.history.push(...result.messages);

      // Persist
      const newMessages = result.messages.slice(preTurnMessageCount);
      if (newMessages.length > 0) {
        await state.session.appendMessages(newMessages);
      }

      // Turn separator
      turnCount++;
      cachedQuip = getQuip(state.buddy.mood); // Update quip once per turn, not per render
      currentQuipType = "quip";
      const tc = state.history.filter(m => m.role === "user" && typeof m.content === "string").length;
      addOutput(theme.muted(`\n  ── turn ${tc} · $${state.router.costs.totalCostUSD.toFixed(4)} · ${state.buddy.name} ──\n`));

      // Speech bubble — render buddy + bubble as Static output so it scrolls up with history
      const bubbleLines = renderBuddyWithBubble(cachedQuip, getBuddyArt(state.buddy), state.buddy.name);
      addOutput(theme.accentDim(bubbleLines.join("\n")));

      // AI-powered buddy comment (every 5th turn, fire-and-forget)
      if (shouldUseAI(turnCount, lastHadError) && !aiCommentInFlight) {
        const gen = ++aiCommentGen;
        aiCommentInFlight = true;
        generateBuddyComment(
          { lastTool: lastToolName, lastResult: lastToolResult, mood: state.buddy.mood, errorOccurred: lastHadError },
          state.router.currentProvider.config.apiKey,
          state.router.currentProvider.config.baseURL
        ).then((comment) => {
          if (gen !== aiCommentGen) return; // Stale — a newer turn started
          currentQuipType = comment.type;
          cachedQuip = comment.text;
          const pool = QUIPS[state.buddy.mood] ?? [];
          if (!pool.includes(comment.text)) {
            QUIPS[state.buddy.mood] = [...pool, comment.text];
          }
          update();
        }).catch(() => {}).finally(() => { aiCommentInFlight = false; });
      }
      lastHadError = false;

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const categorized = categorizeError(error);
      addOutput(theme.error(`\n  Error: ${categorized.message}\n`));
      lastHadError = true;
    }

    isProcessing = false;
    update();
  }

  async function handleExit() {
    idleDetector.stop();
    stopBuddyAnimation();
    state.buddy.mood = "sleepy";
    // Generate final dream on exit
    if (state.history.length > 4) {
      await generateDream(state.history, state.session.id).catch(() => {});
    }
    await saveBuddy(state.buddy).catch(() => {});
    await shutdownLSP().catch(() => {});
    console.log("\n" + state.router.getCostSummary());
    process.exit(0);
  }

  // Keybinding action callbacks
  const handleModeSwitch = () => { cycleMode(); update(); };
  const handleUndo = () => { handleCommand("/undo").catch(() => {}); };
  const handleEffortCycle = () => { cycleEffort(); update(); };
  const handleCompact = () => { handleCommand("/compact").catch(() => {}); };
  const handleClearScreen = () => { items = []; update(); };

  function appProps() {
    return {
      onSubmit: handleSubmit,
      onExit: handleExit,
      onModeSwitch: handleModeSwitch,
      onUndo: handleUndo,
      onEffortCycle: handleEffortCycle,
      onCompact: handleCompact,
      onClearScreen: handleClearScreen,
      inputHistory,
      ...getDisplayProps(),
    };
  }

  // Initial render
  const { rerender } = render(<App {...appProps()} />);

  function update() {
    rerender(<App {...appProps()} />);
  }
}
