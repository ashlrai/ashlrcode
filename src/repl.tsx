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
import { getCurrentMode, cycleMode } from "./ui/mode.ts";
import { getEffort, setEffort, cycleEffort, getEffortConfig, getEffortEmoji, type EffortLevel } from "./ui/effort.ts";
import { estimateTokens, getProviderContextLimit, needsCompaction, autoCompact, snipCompact, contextCollapse } from "./agent/context.ts";
import { runWithAgentContext, type AgentContext } from "./agent/async-context.ts";
import { resetMarkdown, renderMarkdownDelta, flushMarkdown } from "./ui/markdown.ts";
import { getBuddyReaction, getBuddyArt, isFirstToolCall, recordThinking, recordToolCallSuccess, recordError, saveBuddy, startBuddyAnimation, stopBuddyAnimation } from "./ui/buddy.ts";
import { renderBuddyWithBubble } from "./ui/speech-bubble.ts";
import { isPlanMode, getPlanModePrompt } from "./planning/plan-mode.ts";
import { categorizeError } from "./agent/error-handler.ts";
import { theme } from "./ui/theme.ts";
import { getRemoteSettings, stopPolling as stopRemotePolling } from "./config/remote-settings.ts";
import { exportSettings, importSettings, getSyncStatus } from "./config/settings-sync.ts";
import { join } from "path";
import { formatToolExecution, formatTurnSeparator } from "./ui/message-renderer.ts";
import chalk from "chalk";
import type { ProviderRouter } from "./providers/router.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";
import type { Message } from "./providers/types.ts";
import type { Session } from "./persistence/session.ts";
import type { SkillRegistry } from "./skills/registry.ts";
import type { BuddyData } from "./ui/buddy.ts";
import { shutdownLSP } from "./tools/lsp.ts";
import { shutdownBrowser } from "./tools/web-browser.ts";
import { startIPCServer, stopIPCServer } from "./agent/ipc.ts";
import { checkPermission, hasPendingPermission, answerPendingPermission, requestPermissionInk } from "./config/permissions.ts";
import { feature, listFeatures } from "./config/features.ts";
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
import { KairosLoop, detectTerminalFocus } from "./agent/kairos.ts";
import { notifyTurnComplete, notifyError } from "./ui/notifications.ts";
import { initTelemetry, logEvent, readRecentEvents, formatEvents } from "./telemetry/event-log.ts";
import { createTrigger, listTriggers, deleteTrigger, toggleTrigger, TriggerRunner } from "./agent/cron.ts";
import { startRecording, stopRecording, isRecording, transcribeRecording, checkVoiceAvailability, type VoiceConfig } from "./voice/voice-mode.ts";
import { checkForUpgrade } from "./config/upgrade-notice.ts";
import { VERSION } from "./version.ts";
import { startBridgeServer, stopBridgeServer, getBridgePort } from "./bridge/bridge-server.ts";
import { randomBytes } from "crypto";

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
  // We need addOutput before overriding requestPermission, but addOutput is
  // defined later. Use a deferred wrapper that gets patched after addOutput exists.
  let _addOutput: (text: string) => void = () => {};

  // Override requestPermission to use Ink-native prompts instead of readline.
  // This replaces the old setBypassMode(true) which disabled ALL permission checks.
  state.toolContext.requestPermission = async (toolName: string, description: string) => {
    const perm = checkPermission(toolName);
    if (perm === "allow") return true;
    if (perm === "deny") return false;
    // Show permission prompt inline in the output stream
    _addOutput(`\n  ⚡ ${theme.warning("Permission:")} ${theme.primary(toolName)}`);
    _addOutput(theme.tertiary(`    ${description}`));
    _addOutput(theme.tertiary(`    [y] allow  [a] always  [n] deny  [d] always deny\n`));
    return requestPermissionInk(toolName, description);
  };

  startBuddyAnimation();

  // Track how many messages have been persisted to avoid data loss on exit
  let lastPersistedCount = state.history.length;

  // Autopilot work queue
  const workQueue = new WorkQueue(state.toolContext.cwd);
  workQueue.load().catch(() => {});

  // File history for undo support
  const fileHistoryStore = new FileHistoryStore(state.session.id);
  setFileHistory(fileHistoryStore);
  fileHistoryStore.loadFromDisk().catch(() => {});

  // IPC server — enables peer discovery and inter-process messaging
  startIPCServer(state.session.id, state.toolContext.cwd).catch(() => {});

  // Speculation cache — pre-fetches likely read-only tool results
  const speculationCache = new SpeculationCache(100, 30_000);
  setSpeculationCache(speculationCache);

  // KAIROS autonomous mode — lazy-initialized when /kairos is used
  let kairos: KairosLoop | null = null;

  // Cron trigger runner — background polling for due triggers
  // Uses deferred callback since runTurnInk is defined later
  let _triggerCallback: ((prompt: string) => Promise<void>) | null = null;
  const triggerRunner = new TriggerRunner(async (trigger) => {
    if (isProcessing) return; // Don't fire during active turn
    addOutput(theme.accent(`\n  ⏰ Trigger: ${trigger.name} (${trigger.schedule})\n`));
    if (_triggerCallback) await _triggerCallback(trigger.prompt);
  });
  triggerRunner.start(15_000);

  // Initialize local event telemetry
  initTelemetry(state.session.id);
  logEvent("session_start", { cwd: state.toolContext.cwd }).catch(() => {});

  // Bridge server — expose API for IDE extensions and remote clients
  const bridgePort = parseInt(process.env.AC_BRIDGE_PORT ?? "", 10);
  if (bridgePort > 0) {
    const bridgeToken = process.env.AC_BRIDGE_TOKEN ?? randomBytes(16).toString("hex");
    startBridgeServer({
      port: bridgePort,
      authToken: bridgeToken,
      onSubmit: async (prompt) => {
        if (_triggerCallback) await _triggerCallback(prompt);
        return "Submitted";
      },
      getStatus: () => ({
        mode: getCurrentMode(),
        contextPercent: Math.round(
          (estimateTokens(state.history) / getProviderContextLimit(state.router.currentProvider.name)) * 100,
        ),
        isProcessing,
        sessionId: state.session.id,
      }),
      getHistory: () =>
        state.history.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 200),
        })),
    });
  }

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
    { id: 0, text: theme.accent("  Ready. Permission prompts enabled.") },
  ];
  let nextId = 1;
  let turnCount = 0;
  let currentQuipType: BuddyCommentType = "quip";
  let cachedQuip = getQuip(state.buddy.mood); // Cache quip — don't regenerate on every render
  let lastToolName = "";
  let lastToolResult = "";
  let lastHadError = false;
  let toolStartTime = 0;
  let turnToolCount = 0;
  let currentToolInput: Record<string, unknown> = {};
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
  // Patch the deferred wrapper so permission prompts can use addOutput
  _addOutput = addOutput;

  // Check for upgrades (fire and forget)
  checkForUpgrade(VERSION).then(newVersion => {
    if (newVersion) {
      addOutput(theme.warning(`\n  ⬆ AshlrCode ${newVersion} available (current: ${VERSION}). Run: bun update -g ashlrcode\n`));
    }
  }).catch(() => {});

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
      buddy: state.buddy,
      buddyQuip: cachedQuip,
      buddyQuipType: currentQuipType,
      items,
      isProcessing,
      spinnerText,
      commands: [
        "/help", "/cost", "/status", "/effort", "/btw", "/history", "/undo",
        "/restore", "/tools", "/skills", "/buddy", "/memory", "/sessions",
        "/model", "/compact", "/diff", "/git", "/clear", "/quit", "/bug",
        "/autopilot", "/autopilot scan", "/autopilot queue", "/autopilot auto",
        "/autopilot approve all", "/autopilot run", "/features", "/keybindings",
        "/kairos", "/kairos stop", "/telemetry", "/voice",
        ...state.skillRegistry.getAll().map(s => s.trigger),
      ],
    };
  }

  async function handleSubmit(input: string) {
    idleDetector.ping();
    inputHistory.push(input);
    logEvent("turn_start", { input: input.slice(0, 100) }).catch(() => {});

    // If the AskUser tool is waiting for an answer, route the input there
    // instead of starting a new agent turn.
    if (hasPendingQuestion()) {
      answerPendingQuestion(input);
      return;
    }

    // If a permission prompt is waiting, route the input there
    if (hasPendingPermission()) {
      const handled = answerPendingPermission(input.trim());
      if (handled) {
        addOutput(theme.success(`  ✓ ${input.trim()}`));
        return;
      }
      // Unrecognized key — remind user of valid options
      addOutput(theme.warning("  Type y/a/n/d to answer the permission prompt."));
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

    // Smart paste detection — categorize pasted content for better display
    if (lines.length > 3) {
      // Detect JSON
      try {
        JSON.parse(input);
        displayInput = `[Pasted JSON — ${input.length} chars]`;
      } catch {}

      // Detect stack trace
      if (input.includes("at ") && (input.includes("Error:") || input.includes("error:"))) {
        displayInput = `[Stack trace — ${lines.length} lines]`;
      }

      // Detect diff/patch
      if (input.startsWith("diff ") || input.startsWith("---") || lines.some(l => l.startsWith("@@"))) {
        displayInput = `[Pasted diff — ${lines.length} lines]`;
      }
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
      const { getUndercoverPrompt } = await import("./config/undercover.ts");
      const { getModelPatches: getPatches } = await import("./agent/model-patches.ts");
      const imgModelPatches = getPatches(state.router.currentProvider.config.model).combinedSuffix;
      const systemPrompt = state.baseSystemPrompt + getPlanModePrompt() + imgModelPatches + getUndercoverPrompt();
      const userMsg: import("./providers/types.ts").Message = { role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text }] };
      const preTurn = state.history.length;
      state.history.push(userMsg);
      const result = await runAgentLoop("", state.history, { systemPrompt, router: state.router, toolRegistry: state.registry, toolContext: state.toolContext, readOnly: isPlanMode(), onText: (t) => { isProcessing = false; addOutput(t); update(); }, onToolStart: (name) => { isProcessing = true; spinnerText = name; update(); }, onToolEnd: (_n, r, e) => { isProcessing = false; addOutput((e ? theme.error("  ✗ ") : theme.success("  ✓ ")) + r.split("\n")[0]?.slice(0, 90)); update(); } });
      state.history.length = 0; state.history.push(...result.messages);
      const newMsgs = result.messages.slice(preTurn);
      if (newMsgs.length > 0) await state.session.appendMessages(newMsgs);
      lastPersistedCount = state.history.length;
    } catch (err) { addOutput(theme.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`)); }
    isProcessing = false; update();
  }

  async function handleCommand(input: string): Promise<boolean> {
    const [cmd, ...rest] = input.split(" ");
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "/help":
        addOutput(`\nCommands: /plan /cost /status /effort /btw /history /undo /restore /tools /skills /buddy /memory /sessions /model /compact /diff /git /sync /features /keybindings /undercover /patches /kairos /trigger /telemetry /voice /clear /help /quit\n`);
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
      case "/bug":
        addOutput(theme.accent("\n  Report issues: https://github.com/ashlrai/ashlrcode/issues\n"));
        return true;
      case "/buddy": {
        const b = state.buddy;
        const shinyStr = b.shiny ? " ✨ SHINY" : "";
        addOutput(`\n  ${b.name} the ${b.species}${shinyStr}`);
        addOutput(`  Rarity: ${b.rarity.toUpperCase()} · Level ${b.level} · Hat: ${b.hat}`);
        addOutput(`  Stats: 🐛${b.stats.debugging} 🧘${b.stats.patience} 🌀${b.stats.chaos} 🦉${b.stats.wisdom} 😏${b.stats.snark}`);
        addOutput(`  Sessions: ${b.totalSessions} · Tool calls: ${b.toolCalls}\n`);
        return true;
      }
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


      case "/undercover": {
        const { isUndercoverMode, setUndercoverMode } = await import("./config/undercover.ts");
        setUndercoverMode(!isUndercoverMode());
        addOutput(isUndercoverMode() ? theme.warning("\n  🕶 Undercover mode ON\n") : theme.success("\n  Undercover mode OFF\n"));
        return true;
      }

      case "/patches": {
        const { listPatches, getModelPatches } = await import("./agent/model-patches.ts");
        const currentModel = state.router.currentProvider.config.model;
        const { names } = getModelPatches(currentModel);
        const allPatches = listPatches();
        const patchLines = allPatches.map(p => {
          const active = names.includes(p.name);
          return `  ${active ? theme.success("●") : theme.tertiary("○")} ${p.name} ${theme.tertiary(`(${p.pattern})`)}`;
        });
        addOutput(`\n  Model Patches (${currentModel}):\n${patchLines.join("\n")}\n`);
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

      case "/remote": {
        const rs = getRemoteSettings();
        if (!rs) {
          addOutput(theme.tertiary("\n  No remote settings configured.\n  Set AC_REMOTE_SETTINGS_URL env var or remoteSettingsUrl in settings.json.\n"));
          return true;
        }
        addOutput(`\n  Remote Settings (fetched ${new Date(rs.fetchedAt).toLocaleString()}):`);
        if (rs.features) addOutput(`  Features: ${JSON.stringify(rs.features)}`);
        if (rs.modelOverride) addOutput(`  Model override: ${rs.modelOverride}`);
        if (rs.effortOverride) addOutput(`  Effort override: ${rs.effortOverride}`);
        if (rs.killswitches) addOutput(`  Killswitches: ${JSON.stringify(rs.killswitches)}`);
        if (rs.message) addOutput(theme.warning(`  Message: ${rs.message}`));
        addOutput("");
        return true;
      }

      case "/telemetry": {
        const events = await readRecentEvents(20);
        addOutput(`\n  Recent events (${events.length}):\n${formatEvents(events)}\n`);
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

      case "/kairos": {
        if (!arg || arg === "stop") {
          if (kairos?.isRunning()) {
            await kairos.stop();
            kairos = null;
          } else {
            addOutput(theme.tertiary("\n  KAIROS not running\n"));
          }
          return true;
        }
        if (kairos?.isRunning()) {
          addOutput(theme.warning("\n  KAIROS already running. /kairos stop first.\n"));
          return true;
        }
        kairos = new KairosLoop({
          router: state.router,
          toolRegistry: state.registry,
          toolContext: state.toolContext,
          systemPrompt: state.baseSystemPrompt,
          heartbeatIntervalMs: 30_000,
          maxAutonomousIterations: 5,
          onOutput: (text) => { addOutput(text); },
          onToolStart: (name) => { addOutput(`  * ${name}`); update(); },
          onToolEnd: (_name, result, isError) => {
            addOutput(isError ? `  x ${result.slice(0, 80)}` : `  > ${result.split("\n")[0]?.slice(0, 80)}`);
            update();
          },
        });
        await kairos.start(arg);
        return true;
      }

      case "/trigger": {
        const [sub, ...triggerRest] = (arg ?? "").split(" ");

        if (sub === "add") {
          const [schedule, ...promptParts] = triggerRest;
          if (!schedule || promptParts.length === 0) {
            addOutput(theme.tertiary("\n  Usage: /trigger add <schedule> <prompt>\n  Schedule: 30s, 5m, 1h, 2d\n  Example: /trigger add 5m run tests\n"));
            return true;
          }
          try {
            const t = await createTrigger("trigger", schedule!, promptParts.join(" "), state.toolContext.cwd);
            addOutput(theme.success(`\n  Trigger created: ${t.id} (every ${t.schedule})\n`));
          } catch (e: any) {
            addOutput(theme.error(`\n  ${e.message}\n`));
          }
          return true;
        }

        if (sub === "list" || !sub) {
          const triggers = await listTriggers();
          if (triggers.length === 0) {
            addOutput(theme.tertiary("\n  No triggers. Use /trigger add <schedule> <prompt>\n"));
            return true;
          }
          addOutput(theme.secondary("\n  Scheduled Triggers:\n"));
          for (const t of triggers) {
            const status = t.enabled ? theme.success("●") : theme.error("○");
            const lastInfo = t.lastRun ? ` (ran ${t.runCount}x)` : " (never ran)";
            addOutput(`  ${status} ${t.id} — every ${t.schedule} — ${t.prompt.slice(0, 50)}${lastInfo}`);
          }
          addOutput("");
          return true;
        }

        if (sub === "delete" && triggerRest[0]) {
          const deleted = await deleteTrigger(triggerRest[0]!);
          if (deleted) {
            addOutput(theme.success(`\n  Deleted ${triggerRest[0]}\n`));
          } else {
            addOutput(theme.error(`\n  Trigger not found: ${triggerRest[0]}\n`));
          }
          return true;
        }

        if (sub === "toggle" && triggerRest[0]) {
          const toggled = await toggleTrigger(triggerRest[0]!);
          if (toggled) {
            addOutput(theme.success(`\n  ${toggled.id} is now ${toggled.enabled ? "enabled" : "disabled"}\n`));
          } else {
            addOutput(theme.error(`\n  Trigger not found: ${triggerRest[0]}\n`));
          }
          return true;
        }

        addOutput(theme.tertiary("\n  /trigger add <schedule> <prompt>\n  /trigger list\n  /trigger toggle <id>\n  /trigger delete <id>\n"));
        return true;
      }

      case "/btw": {
        if (!arg) { addOutput(theme.tertiary("\n  Usage: /btw <question>\n  Ask a side question without interrupting the current task.\n")); return true; }
        // Run the question in a sub-agent so it doesn't pollute main history
        const { runSubAgent } = await import("./agent/sub-agent.ts");
        addOutput(theme.accent(`\n  💬 Side question: ${arg}\n`));
        isProcessing = true; spinnerText = "Thinking (side)"; update();
        try {
          const result = await runSubAgent({
            name: "btw",
            prompt: arg,
            systemPrompt: state.baseSystemPrompt + "\n\nThis is a brief side question. Answer concisely (1-3 sentences). Do not modify any files.",
            router: state.router,
            toolRegistry: state.registry,
            toolContext: state.toolContext,
            readOnly: true,
            maxIterations: 5,
          });
          addOutput(result.text + "\n");
        } catch (err) {
          addOutput(theme.error(`  Error: ${err instanceof Error ? err.message : String(err)}\n`));
        }
        isProcessing = false; update();
        return true;
      }

      case "/voice": {
        if (!feature("VOICE_MODE")) {
          addOutput(theme.tertiary("\n  Voice mode disabled. Set AC_FEATURE_VOICE_MODE=true\n"));
          return true;
        }
        const check = await checkVoiceAvailability();
        if (!check.available) {
          addOutput(theme.error(`\n  ${check.details}\n`));
          return true;
        }

        if (isRecording()) {
          addOutput(theme.accent("  Transcribing...\n"));
          const voiceConfig: VoiceConfig = {
            sttProvider: process.env.OPENAI_API_KEY ? "whisper-api" : "whisper-local",
            whisperApiKey: process.env.OPENAI_API_KEY,
          };
          try {
            const text = await transcribeRecording(voiceConfig);
            if (text) {
              addOutput(theme.success(`  Voice: "${text}"\n`));
              await runTurnInk(text);
            } else {
              addOutput(theme.error("  Failed to transcribe\n"));
            }
          } catch (e: any) {
            addOutput(theme.error(`  Transcription error: ${e.message}\n`));
          }
        } else {
          await startRecording();
          addOutput(theme.accent("  Recording... /voice again to stop and transcribe\n"));
        }
        return true;
      }

      case "/compact": {
        addOutput(theme.tertiary("  [compacting context...]"));
        state.history = contextCollapse(state.history);
        state.history = snipCompact(state.history);
        state.history = await autoCompact(state.history, state.router);
        const summary = state.history.slice(-5).map(m => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `${m.role}: ${c.slice(0, 150)}`;
        }).join("\n");
        await state.session.insertCompactBoundary(summary, state.history.length).catch(() => {});
        addOutput(theme.success(`\n  ✓ Compacted to ${state.history.length} messages\n`));
        return true;
      }
      case "/status": {
        const ctxLimit = getProviderContextLimit(state.router.currentProvider.name);
        const ctxUsed = estimateTokens(state.history);
        addOutput(`\n  Provider: ${state.router.currentProvider.name}:${state.router.currentProvider.config.model}`);
        addOutput(`  Context: ${ctxUsed}/${ctxLimit} tokens (${Math.round(ctxUsed/ctxLimit*100)}%)`);
        addOutput(`  Session: ${state.session.id}`);
        addOutput(`  History: ${state.history.length} messages\n`);
        return true;
      }
      case "/sessions": {
        const { listSessions } = await import("./persistence/session.ts");
        const sessions = await listSessions(10);
        if (sessions.length === 0) { addOutput(theme.tertiary("\n  No sessions found.\n")); return true; }
        for (const s of sessions) {
          addOutput(`  ${s.id} — ${s.title ?? "(untitled)"} — ${new Date(s.updatedAt).toLocaleDateString()} — ${s.messageCount} msgs`);
        }
        addOutput("");
        return true;
      }
      case "/memory": {
        const { loadMemories } = await import("./persistence/memory.ts");
        const memories = await loadMemories(state.toolContext.cwd);
        if (memories.length === 0) { addOutput(theme.tertiary("\n  No memory files.\n")); return true; }
        for (const m of memories) { addOutput(`  [${m.type}] ${m.name} — ${m.description ?? m.filePath}`); }
        addOutput("");
        return true;
      }
      case "/diff": {
        const proc = Bun.spawn(["git", "diff", "--stat"], { cwd: state.toolContext.cwd, stdout: "pipe", stderr: "pipe" });
        const output = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        addOutput(output ? `\n${output}\n` : theme.tertiary("\n  No changes.\n"));
        return true;
      }
      case "/git": {
        const proc = Bun.spawn(["git", "log", "--oneline", "-10"], { cwd: state.toolContext.cwd, stdout: "pipe", stderr: "pipe" });
        const output = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        addOutput(output ? `\n${output}\n` : theme.tertiary("\n  Not a git repo.\n"));
        return true;
      }
      case "/plan": {
        const { cycleMode: cm } = await import("./ui/mode.ts");
        cm();
        update();
        return true;
      }
      case "/restore": {
        const fh = getFileHistory();
        if (!fh || fh.undoCount === 0) { addOutput(theme.tertiary("\n  Nothing to restore.\n")); return true; }
        addOutput(`\n  ${fh.undoCount} snapshots available. Use /undo to restore.\n`);
        return true;
      }

      case "/sync": {
        const [sub, ...syncRest] = (arg ?? "").split(" ");
        if (sub === "export") {
          const dir = syncRest[0] ?? join(state.toolContext.cwd, ".ashlrcode-sync");
          const manifest = await exportSettings(dir);
          addOutput(theme.success(`\n  ✓ Exported ${manifest.files.length} files to ${dir}\n`));
          return true;
        }
        if (sub === "import") {
          const dir = syncRest[0];
          if (!dir) {
            addOutput(theme.tertiary("\n  Usage: /sync import <path> [--overwrite] [--merge]\n"));
            return true;
          }
          const overwrite = syncRest.includes("--overwrite");
          const merge = syncRest.includes("--merge");
          const result = await importSettings(dir, { overwrite, merge });
          addOutput(theme.success(`\n  ✓ Imported: ${result.imported.length}, Skipped: ${result.skipped.length}\n`));
          if (result.imported.length > 0) addOutput(theme.secondary(`    ${result.imported.join(", ")}`));
          if (result.skipped.length > 0) addOutput(theme.tertiary(`    Skipped: ${result.skipped.join(", ")}`));
          addOutput("");
          return true;
        }
        // Default: show sync status
        const status = await getSyncStatus();
        addOutput(`\n  Syncable files:\n${status.files.map((f) => `    ${f}`).join("\n")}\n`);
        addOutput(theme.tertiary("  /sync export [path]  — export settings\n  /sync import <path>  — import settings\n"));
        return true;
      }

      case "/bridge": {
        const port = getBridgePort();
        if (port) {
          addOutput(`\n  Bridge active on http://localhost:${port}\n`);
        } else {
          addOutput(theme.tertiary("\n  Bridge not running. Set AC_BRIDGE_PORT=8743 to enable.\n"));
        }
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
    const turnStartTime = Date.now();
    isProcessing = true;
    spinnerText = "Thinking";
    update();

    // Echo — use displayText for smart paste collapse
    const echo = displayText ?? input;
    addOutput("\n" + theme.accent("  ❯ ") + theme.primary(echo.length > 200 ? echo.slice(0, 197) + "..." : echo) + "\n");

    try {
      const effortConfig = getEffortConfig();
      const { getUndercoverPrompt: getUcPrompt } = await import("./config/undercover.ts");
      const { getModelPatches: getMPatches } = await import("./agent/model-patches.ts");
      const turnModelPatches = getMPatches(state.router.currentProvider.config.model).combinedSuffix;
      const systemPrompt = state.baseSystemPrompt + getPlanModePrompt() + effortConfig.systemPromptSuffix + turnModelPatches + getUcPrompt();
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
      turnToolCount = 0;

      // Update turn number on context so file snapshots track which turn modified them
      state.toolContext.turnNumber = turnCount;

      let responseText = "";

      // Wrap agent loop in AsyncLocalStorage root context for sub-agent isolation
      const rootCtx: AgentContext = {
        agentId: `root-${state.session.id}-${turnCount}`,
        agentName: "main",
        cwd: state.toolContext.cwd,
        readOnly: isPlanMode(),
        depth: 0,
        startedAt: new Date().toISOString(),
      };

      const result = await runWithAgentContext(rootCtx, () => runAgentLoop(input, state.history, {
        systemPrompt,
        maxIterations: effortConfig.maxIterations,
        router: state.router,
        toolRegistry: state.registry,
        toolContext: state.toolContext,
        readOnly: isPlanMode(),
        onText: (text) => {
          isProcessing = false;
          responseText += text;
          // Use stateful markdown renderer (handles code blocks, headers, etc.)
          const rendered = renderMarkdownDelta(text);
          if (rendered) {
            // Rendered output is newline-terminated; split and indent each line
            const lines = rendered.replace(/\n$/, "").split("\n");
            for (const line of lines) {
              addOutput("  " + line);
            }
          }
          // Partial line stays in spinnerText for live display
          const allLines = responseText.split("\n");
          responseText = allLines[allLines.length - 1]!;
          spinnerText = responseText;
          update();
        },
        onToolStart: (name, toolInput) => {
          isProcessing = true;
          spinnerText = name;
          toolStartTime = Date.now();
          currentToolInput = toolInput as Record<string, unknown>;
          recordThinking(state.buddy);
          logEvent("tool_start", { tool: name }).catch(() => {});
          if (isFirstToolCall()) {
            addOutput(getBuddyReaction(state.buddy, "first_tool"));
          }
          update();
        },
        onToolEnd: (_name, result, isError) => {
          isProcessing = false;
          turnToolCount++;
          const durationMs = toolStartTime > 0 ? Date.now() - toolStartTime : undefined;
          lastToolName = _name;
          lastToolResult = result.slice(0, 50);
          logEvent(isError ? "tool_error" : "tool_end", { tool: _name }).catch(() => {});
          if (isError) { recordError(state.buddy); lastHadError = true; }
          else recordToolCallSuccess(state.buddy);

          // Use message renderer for formatted output
          addOutput(""); // spacing before tool block
          const rendered = formatToolExecution(_name, currentToolInput, result, isError, durationMs);
          for (const line of rendered) addOutput(line);

          if (isError) addOutput(getBuddyReaction(state.buddy, "error"));
          toolStartTime = 0;
          currentToolInput = {};
          update();
        },
      }));

      // Flush remaining markdown buffer
      const flushed = flushMarkdown();
      if (flushed) addOutput("  " + flushed);
      else if (responseText) addOutput("  " + responseText);

      // Update history
      state.history.length = 0;
      state.history.push(...result.messages);

      // Persist
      const newMessages = result.messages.slice(preTurnMessageCount);
      if (newMessages.length > 0) {
        await state.session.appendMessages(newMessages);
        lastPersistedCount = state.history.length;
      }

      // Turn separator
      turnCount++;
      logEvent("turn_end", { cost: state.router.costs.totalCostUSD, turn: turnCount }).catch(() => {});

      // Auto-generate session title from first user message
      if (turnCount === 1 && input.length > 0) {
        const title = input.slice(0, 60).replace(/\n/g, " ").trim();
        state.session.setTitle(title).catch(() => {});
      }
      cachedQuip = getQuip(state.buddy.mood); // Update quip once per turn, not per render
      currentQuipType = "quip";
      const tc = state.history.filter(m => m.role === "user" && typeof m.content === "string").length;
      addOutput(formatTurnSeparator(tc, state.router.costs.totalCostUSD, state.buddy.name, turnToolCount));

      // Desktop notification when terminal is not focused
      detectTerminalFocus().then(focus => {
        if (focus === "unfocused") {
          notifyTurnComplete(turnToolCount, Date.now() - turnStartTime).catch(() => {});
        }
      }).catch(() => {});

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
      logEvent("error", { message: categorized.message }).catch(() => {});
      notifyError(categorized.message).catch(() => {});
      lastHadError = true;
    }

    isProcessing = false;
    update();
  }

  // Wire deferred trigger callback now that runTurnInk is defined
  _triggerCallback = runTurnInk;

  async function handleExit() {
    idleDetector.stop();
    triggerRunner.stop();
    stopRemotePolling();
    stopBridgeServer();
    stopBuddyAnimation();
    if (kairos?.isRunning()) await kairos.stop().catch(() => {});
    const { stopRecording: stopRec, isRecording: isRec } = await import("./voice/voice-mode.ts");
    if (isRec()) await stopRec().catch(() => {});

    // Save any unsaved messages from the current turn to prevent data loss
    const unsaved = state.history.slice(lastPersistedCount);
    if (unsaved.length > 0) {
      await state.session.appendMessages(unsaved).catch(() => {});
    }

    state.buddy.mood = "sleepy";
    // Generate final dream on exit
    if (state.history.length > 4) {
      await generateDream(state.history, state.session.id).catch(() => {});
    }
    await saveBuddy(state.buddy).catch(() => {});
    console.log("\n" + state.router.getCostSummary());
    // Await all cleanup with a 3-second timeout to avoid orphaned processes
    const cleanup = Promise.all([
      stopIPCServer().catch(() => {}),
      shutdownLSP().catch(() => {}),
      shutdownBrowser().catch(() => {}),
    ]);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    await Promise.race([cleanup, timeout]);
    process.exit(0);
  }

  // Keybinding action callbacks
  const handleModeSwitch = () => { cycleMode(); update(); };
  const handleUndo = () => { handleCommand("/undo").catch(() => {}); };
  const handleEffortCycle = () => { cycleEffort(); update(); };
  const handleCompact = () => { handleCommand("/compact").catch(() => {}); };
  const handleClearScreen = () => { items = []; update(); };
  const handleVoiceToggle = () => { handleCommand("/voice").catch(() => {}); };

  function appProps() {
    return {
      onSubmit: handleSubmit,
      onExit: handleExit,
      onModeSwitch: handleModeSwitch,
      onUndo: handleUndo,
      onEffortCycle: handleEffortCycle,
      onCompact: handleCompact,
      onClearScreen: handleClearScreen,
      onVoiceToggle: handleVoiceToggle,
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
