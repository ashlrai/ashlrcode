/**
 * Ink-based REPL — replaces readline for interactive mode.
 *
 * Manages display state and bridges between the agent loop callbacks
 * and the Ink React component tree.
 */

import chalk from "chalk";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { render } from "ink";
import { join } from "path";
import React from "react";
import { type AgentContext, runWithAgentContext } from "./agent/async-context.ts";
import { type AutopilotLoop, createAutopilotLoop } from "./agent/autopilot-loop.ts";
import {
  autoCompact,
  contextCollapse,
  estimateTokens,
  getProviderContextLimit,
  needsCompaction,
  snipCompact,
} from "./agent/context.ts";
import { createTrigger, deleteTrigger, listTriggers, TriggerRunner, toggleTrigger } from "./agent/cron.ts";
import { formatDreamsForPrompt, generateDream, IdleDetector, loadRecentDreams } from "./agent/dream.ts";
import { categorizeError, type ErrorCategory } from "./agent/error-handler.ts";
import { startIPCServer, stopIPCServer } from "./agent/ipc.ts";
import { cmuxSessionStart, cmuxSessionEnd, cmuxAgentIdle, cmuxToolStart, cmuxToolEnd, cmuxPromptSubmit, cmuxError } from "./cmux/hooks.ts";
import { detectTerminalFocus, KairosLoop } from "./agent/kairos.ts";
import { runAgentLoop } from "./agent/loop.ts";
import { SpeculationCache } from "./agent/speculation.ts";
import { setSpeculationCache } from "./agent/tool-executor.ts";
import { createVision, loadVision, saveVision, type Vision } from "./agent/vision.ts";
import { WorkQueue } from "./autopilot/queue.ts";
import { scanCodebase } from "./autopilot/scanner.ts";
import { DEFAULT_CONFIG } from "./autopilot/types.ts";
import { getBridgePort, startBridgeServer, stopBridgeServer } from "./bridge/bridge-server.ts";
import { feature, listFeatures } from "./config/features.ts";
import {
  answerPendingPermission,
  checkPermission,
  hasPendingPermission,
  requestPermissionInk,
} from "./config/permissions.ts";
import { getRemoteSettings, stopPolling as stopRemotePolling } from "./config/remote-settings.ts";
import { getConfigDir } from "./config/settings.ts";
import { exportSettings, getSyncStatus, importSettings } from "./config/settings-sync.ts";
import { checkForUpgrade } from "./config/upgrade-notice.ts";
import type { Session } from "./persistence/session.ts";
import { getPlanModePrompt, isPlanMode } from "./planning/plan-mode.ts";
import type { ProviderRouter } from "./providers/router.ts";
import type { Message } from "./providers/types.ts";
import type { SkillRegistry } from "./skills/registry.ts";
import { FileHistoryStore, getFileHistory, setFileHistory } from "./state/file-history.ts";
import { formatEvents, initTelemetry, logEvent, readRecentEvents } from "./telemetry/event-log.ts";
import { answerPendingQuestion, getPendingOptions, hasPendingQuestion, setAskUserCallbacks } from "./tools/ask-user.ts";
import { shutdownLSP } from "./tools/lsp.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";
import { shutdownBrowser } from "./tools/web-browser.ts";
import { App } from "./ui/App.tsx";
import type { BuddyData } from "./ui/buddy.ts";
import {
  getBuddyArt,
  getBuddyReaction,
  isFirstToolCall,
  recordError,
  recordThinking,
  recordToolCallSuccess,
  saveBuddy,
  startBuddyAnimation,
  stopBuddyAnimation,
} from "./ui/buddy.ts";
import { type BuddyCommentType, generateBuddyComment, shouldUseAI } from "./ui/buddy-ai.ts";
import { cycleEffort, type EffortLevel, getEffort, getEffortConfig, getEffortEmoji, setEffort } from "./ui/effort.ts";
import { getBindings, InputHistory, loadKeybindings } from "./ui/keybindings.ts";
import { flushMarkdown, renderMarkdownDelta, resetMarkdown } from "./ui/markdown.ts";
import { formatToolExecution, formatTurnSeparator } from "./ui/message-renderer.ts";
import { cycleMode, getCurrentMode } from "./ui/mode.ts";
import { notifyError, notifyTurnComplete } from "./ui/notifications.ts";
import { formatPermissionBox, formatPermissionOptions } from "./ui/PermissionPrompt.tsx";
import builtinQuips from "./ui/quips.json";
import { renderBuddyWithBubble } from "./ui/speech-bubble.ts";
import { theme } from "./ui/theme.ts";
import { VERSION } from "./version.ts";
import { createCommandRegistry } from "./commands/index.ts";
import type { CommandContext } from "./commands/types.ts";
import {
  checkVoiceAvailability,
  isRecording,
  startRecording,
  stopRecording,
  transcribeRecording,
  type VoiceConfig,
} from "./voice/voice-mode.ts";

// Buddy quips — loaded from ~/.ashlrcode/quips.json if present, otherwise built-in
function loadQuips(): Record<string, string[]> {
  const userQuipsPath = join(getConfigDir(), "quips.json");
  if (existsSync(userQuipsPath)) {
    try {
      const raw = readFileSync(userQuipsPath, "utf-8");
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      // Fall back to built-in on parse error
    }
  }
  return builtinQuips as Record<string, string[]>;
}

const QUIPS: Record<string, string[]> = loadQuips();
let quipIdx = 0;
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

/** Recovery hints shown below error messages to help users recover. */
const ERROR_RECOVERY_HINTS: Record<ErrorCategory, string> = {
  rate_limit: "Hint: Wait a moment or switch providers with /model",
  auth: "Hint: Check your API key. Run the setup wizard with /config or set XAI_API_KEY",
  network: "Hint: Check your internet connection. The agent will auto-retry.",
  tool_failure: "Hint: Try /undo to revert the last change",
  server: "Hint: Provider may be down. Try /model to switch providers",
  validation: "Hint: Check the input format and try again",
  unknown: "",
};

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
    // Show boxed permission prompt inline in the output stream
    _addOutput(formatPermissionBox(toolName, description));
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
  startIPCServer(state.session.id, state.toolContext.cwd, (msg) => {
    // Process incoming IPC messages from peer instances
    switch (msg.type) {
      case "ping":
        // Auto-reply with pong (peer discovery)
        import("./agent/ipc.ts").then(({ sendToPeer }) => sendToPeer(msg.from, "pong", "alive").catch(() => {}));
        break;
      case "message":
        // Show peer messages in the output
        addOutput(theme.accent(`\n  📨 From peer ${msg.from}: ${msg.payload}\n`));
        update();
        break;
      case "task":
        // Queue task from peer for execution
        addOutput(theme.accent(`\n  📋 Task from peer ${msg.from}: ${msg.payload}\n`));
        update();
        break;
      case "result":
        addOutput(theme.success(`\n  ✓ Result from peer ${msg.from}: ${msg.payload.slice(0, 200)}\n`));
        update();
        break;
    }
  }).catch(() => {});

  // cmux integration — report session lifecycle to cmux sidebar
  cmuxSessionStart(state.session.id, state.toolContext.cwd);

  // Speculation cache — pre-fetches likely read-only tool results
  const speculationCache = new SpeculationCache(100, 30_000);
  setSpeculationCache(speculationCache);

  // Command registry — replaces the old handleCommand switch statement
  const commandRegistry = createCommandRegistry({
    saveBuddy: saveBuddy as (b: unknown) => Promise<void>,
    speculationCache,
    VERSION,
    getFileHistory: () => getFileHistory(),
    scanCodebase,
    DEFAULT_CONFIG,
    createAutopilotLoop,
    createVision,
    loadVision,
  });

  // KAIROS autonomous mode — lazy-initialized when /kairos is used
  let kairos: KairosLoop | null = null;
  let productAgent: import("./agent/product-agent.ts").ProductAgent | null = null;

  // Background operation tracking — allows /cancel to list and stop active ops
  const backgroundOps = new Map<string, { name: string; startedAt: number; cancel: () => void }>();

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
  loadRecentDreams(3)
    .then((dreams) => {
      if (dreams.length > 0) {
        const dreamContext = formatDreamsForPrompt(dreams);
        state.baseSystemPrompt += "\n\n" + dreamContext;
      }
    })
    .catch(() => {});

  // Idle detector — generate dream when user is idle for 2 minutes
  const idleDetector = new IdleDetector(async () => {
    if (state.history.length > 4) {
      await generateDream(state.history, state.session.id, state.router).catch(() => {});
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
  let lastFullToolOutput: string | null = null;
  let lastHadError = false;
  let toolStartTime = 0;
  let turnToolCount = 0;
  let currentToolInput: Record<string, unknown> = {};
  let aiCommentGen = 0; // Guards against stale AI callbacks overwriting mid-turn
  let aiCommentInFlight = false;
  let isProcessing = false;
  let currentAbortController: AbortController | null = null;
  const messageQueue: string[] = [];
  let spinnerText = "Thinking";
  let isUltrathinkTurn = false;

  // Unified autopilot state
  let autopilotLoop: AutopilotLoop | null = null;
  let autopilotRunning = false;
  let tokenStats = "";
  let turnStreamStart = 0;
  let turnOutputTokens = 0;
  let turnInputTokens = 0;
  let turnCharCount = 0;

  /** Mark turn complete and drain any queued messages. */
  function finishProcessing() {
    isProcessing = false;
    cmuxAgentIdle();
    update();
    // Drain message queue — process next queued message
    if (messageQueue.length > 0) {
      const next = messageQueue.shift()!;
      addOutput(chalk.dim(`  ⏩ Processing queued: "${next.length > 60 ? next.slice(0, 57) + "..." : next}"`));
      update();
      // Use setTimeout to avoid stack depth issues
      setTimeout(() => handleSubmit(next), 0);
    }
  }

  function formatTk(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return `${n}`;
  }

  function computeTokenStats(tokens: number, approximate: boolean): string {
    const elapsed = turnStreamStart ? (Date.now() - turnStreamStart) / 1000 : 0;
    const tokSec = elapsed > 0.5 ? Math.round(tokens / elapsed) : 0;
    if (tokSec <= 0) return "";
    const prefix = approximate ? "~" : "";
    return `${prefix}${tokens} tokens · ${tokSec} tok/s`;
  }

  const MAX_ITEMS = 2000;

  function addOutput(text: string) {
    // Prevent consecutive empty lines from stacking up (ghost separators)
    if (text === "" && items.length > 0 && items[items.length - 1]!.text === "") return;
    items = [...items.slice(-MAX_ITEMS), { id: nextId++, text }];
    update();
  }
  // Patch the deferred wrapper so permission prompts can use addOutput
  _addOutput = addOutput;

  // Wire AskUser to use REPL output and processing state
  setAskUserCallbacks(addOutput, (processing) => {
    isProcessing = processing;
    update();
  });

  // Wire Agent tool to use REPL output (avoids console.log conflicting with Ink)
  import("./tools/agent.ts").then(({ setAgentOutputFn }) => setAgentOutputFn(addOutput));

  // Check for upgrades (fire and forget)
  checkForUpgrade(VERSION)
    .then((newVersion) => {
      if (newVersion) {
        addOutput(
          theme.warning(
            `\n  ⬆ AshlrCode ${newVersion} available (current: ${VERSION}). Run: bun update -g ashlrcode\n`,
          ),
        );
      }
    })
    .catch(() => {});

  function getDisplayProps() {
    const ctxLimit = getProviderContextLimit(state.router.currentProvider.name);
    const ctxUsed = estimateTokens(state.history);
    const ctxPct = Math.round((ctxUsed / ctxLimit) * 100);
    const mode = getCurrentMode();
    const modeColors: Record<string, string> = {
      normal: "green",
      plan: "magenta",
      "accept-edits": "yellow",
      yolo: "red",
    };

    const effort = getEffort();
    const effortDisplay = effort !== "normal" ? ` ${getEffortEmoji()} ${effort}` : "";

    return {
      mode: mode + effortDisplay,
      modeColor: modeColors[mode] ?? "green",
      contextPercent: ctxPct,
      contextUsed: formatTk(ctxUsed),
      contextLimit: formatTk(ctxLimit),
      modelName: state.router.currentProvider.config.model.replace(/^(models\/|accounts\/[^/]+\/models\/)/, ""),
      buddy: state.buddy,
      buddyQuip: cachedQuip,
      buddyQuipType: currentQuipType,
      items,
      isProcessing,
      spinnerText,
      tokenStats,
      commands: [
        ...commandRegistry.getAutocompleteList(),
        ...state.skillRegistry.getAll().map((s) => (s.trigger.startsWith("/") ? s.trigger : `/${s.trigger}`)),
      ].filter((cmd, i, arr) => arr.indexOf(cmd) === i),
      cwd: state.toolContext.cwd,
      pendingQuestionOptionCount: hasPendingQuestion() ? getPendingOptions().length : 0,
      pendingQuestionLabels: hasPendingQuestion() ? getPendingOptions().map((o) => o.label) : [],
    };
  }

  async function handleSubmit(input: string) {
    idleDetector.ping();
    inputHistory.push(input);
    cmuxPromptSubmit();
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
      // Unrecognized key — remind user of valid options with boxed display
      addOutput(formatPermissionOptions());
      return;
    }

    // Route messages to autopilot if running and not a slash command
    if (autopilotRunning && autopilotLoop && !input.startsWith("/")) {
      autopilotLoop.queueUserMessage(input);
      addOutput(
        chalk.dim(`  ⏳ Message sent to autopilot: "${input.length > 60 ? input.slice(0, 57) + "..." : input}"`),
      );
      update();
      return;
    }

    // Queue messages while processing — drain after turn completes
    if (isProcessing) {
      messageQueue.push(input);
      addOutput(chalk.dim(`  ⏳ Queued: "${input.length > 60 ? input.slice(0, 57) + "..." : input}"`));
      update();
      return;
    }

    // Detect image file paths (drag-and-drop inserts path as text)
    const imageMatch =
      input.match(/(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp))(?:\s|$)/i) ??
      input.match(/(?:^|\s)([^\s]+\.(?:png|jpg|jpeg|gif|webp))(?:\s|$)/i);

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

    // Smart paste: show truncated preview for multi-line text
    const lines = input.split("\n");
    let displayInput = input;
    if (lines.length > 3) {
      // Build a truncated preview: first 3 lines + count of remaining
      const preview = lines
        .slice(0, 3)
        .map((l: string, i: number) => {
          const trimmed = l.length > 80 ? l.slice(0, 77) + "..." : l;
          return i === 0 ? trimmed : "  │ " + trimmed;
        })
        .join("\n");
      const remaining = lines.length - 3;
      displayInput =
        remaining > 0 ? `${preview}\n  │ ... ${remaining} more line${remaining === 1 ? "" : "s"}` : preview;

      // Add type hint for special content
      let typeHint = "";
      try {
        JSON.parse(input);
        typeHint = " (JSON)";
      } catch {}
      if (input.includes("at ") && (input.includes("Error:") || input.includes("error:"))) {
        typeHint = " (stack trace)";
      }
      if (input.startsWith("diff ") || input.startsWith("---") || lines.some((l: string) => l.startsWith("@@"))) {
        typeHint = " (diff)";
      }
      if (typeHint) {
        displayInput += `  ${typeHint}`;
      }
    }

    // Handle built-in commands
    if (input.startsWith("/")) {
      // Skills first
      if (state.skillRegistry.isSkill(input.split(" ")[0]!)) {
        const expanded = state.skillRegistry.expand(input);
        if (expanded) {
          addOutput(theme.accent(`\n  ⚡ Running skill: ${input.split(" ")[0]}\n`));
          await runTurnInk(expanded);
          return;
        }
      }

      // Command registry
      const handled = await commandRegistry.dispatch(input, buildCommandContext());
      if (handled) return;
    }

    await runTurnInk(input, displayInput);
  }

  /** Run with image attachment */
  async function runTurnInkWithImage(text: string, imageDataUrl: string) {
    isProcessing = true;
    spinnerText = "Analyzing image";
    update();
    try {
      const { getUndercoverPrompt } = await import("./config/undercover.ts");
      const { getModelPatches: getPatches } = await import("./agent/model-patches.ts");
      const imgModelPatches = getPatches(state.router.currentProvider.config.model).combinedSuffix;
      const systemPrompt = state.baseSystemPrompt + getPlanModePrompt() + imgModelPatches + getUndercoverPrompt();
      const userMsg: import("./providers/types.ts").Message = {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          { type: "text", text },
        ],
      };
      const preTurn = state.history.length;
      state.history.push(userMsg);
      const result = await runAgentLoop("", state.history, {
        systemPrompt,
        router: state.router,
        toolRegistry: state.registry,
        toolContext: state.toolContext,
        readOnly: isPlanMode(),
        onText: (t) => {
          isProcessing = false;
          addOutput(t);
          update();
        },
        onToolStart: (name) => {
          isProcessing = true;
          spinnerText = name;
          update();
        },
        onToolEnd: (_n, r, e) => {
          isProcessing = false;
          addOutput((e ? theme.error("  ✗ ") : theme.success("  ✓ ")) + r.split("\n")[0]?.slice(0, 90));
          update();
        },
      });
      state.history.length = 0;
      state.history.push(...result.messages);
      const newMsgs = result.messages.slice(preTurn);
      if (newMsgs.length > 0) await state.session.appendMessages(newMsgs);
      lastPersistedCount = state.history.length;
    } catch (err) {
      addOutput(theme.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`));
    }
    isProcessing = false;
    update();
  }

  function stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*m/g, "");
  }

  /** Build a compact summary of recent messages for session boundary markers. */
  function buildCompactSummary(): string {
    return state.history
      .slice(-5)
      .map((m) => {
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${c.slice(0, 150)}`;
      })
      .join("\n");
  }

  function formatTimeAgo(date: Date): string {
    const ms = Date.now() - date.getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  }

  function buildCommandContext(): CommandContext {
    return {
      addOutput,
      update,
      state,
      getProcessing: () => isProcessing,
      setProcessing: (v) => { isProcessing = v; },
      getSpinnerText: () => spinnerText,
      setSpinnerText: (v) => { spinnerText = v; },
      runTurnInk,
      getItems: () => items,
      backgroundOps,
      getAutopilotLoop: () => autopilotLoop as any,
      setAutopilotLoop: (loop) => { autopilotLoop = loop as any; },
      getAutopilotRunning: () => autopilotRunning,
      setAutopilotRunning: (v) => { autopilotRunning = v; },
      getWorkQueue: () => workQueue as any,
      getKairos: () => kairos as any,
      setKairos: (k) => { kairos = k as any; },
      getProductAgent: () => productAgent as any,
      setProductAgent: (p) => { productAgent = p as any; },
      getLastFullToolOutput: () => lastFullToolOutput,
      stripAnsi,
      buildCompactSummary,
      formatTimeAgo,
    };
  }

  // handleCommand replaced by commandRegistry — see buildCommandContext() above

  async function runTurnInk(input: string, displayText?: string) {
    const turnStartTime = Date.now();
    turnStreamStart = turnStartTime;
    turnOutputTokens = 0;
    turnInputTokens = 0;
    turnCharCount = 0;
    tokenStats = "";
    isProcessing = true;
    isUltrathinkTurn = input.toLowerCase().includes("ultrathink");
    spinnerText = isUltrathinkTurn ? "Deep reasoning" : "Thinking";
    update();

    // Ultrathink banner
    if (isUltrathinkTurn) {
      const banner =
        chalk.bold.magentaBright("  ⚡ ULTRATHINK ") +
        chalk.magenta("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      addOutput(banner);
      addOutput(chalk.magentaBright("  Deep reasoning enabled — extended thinking budget\n"));
    }

    // Echo — use displayText for smart paste collapse
    const echo = displayText ?? input;
    addOutput(
      "\n" + theme.accent("  ❯ ") + theme.primary(echo.length > 200 ? echo.slice(0, 197) + "..." : echo) + "\n",
    );

    try {
      const effortConfig = getEffortConfig();
      const { getUndercoverPrompt: getUcPrompt } = await import("./config/undercover.ts");
      const { getModelPatches: getMPatches } = await import("./agent/model-patches.ts");
      const turnModelPatches = getMPatches(state.router.currentProvider.config.model).combinedSuffix;
      const systemPrompt =
        state.baseSystemPrompt +
        getPlanModePrompt() +
        effortConfig.systemPromptSuffix +
        turnModelPatches +
        getUcPrompt();
      const systemTokens = Math.ceil(systemPrompt.length / 4);
      const contextLimit = getProviderContextLimit(state.router.currentProvider.name);

      // Use actual provider-reported token count when available (more accurate than chars/4 heuristic)
      const actualTokens = turnInputTokens > 0 ? turnInputTokens + turnOutputTokens : undefined;
      if (needsCompaction(state.history, systemTokens, { maxContextTokens: contextLimit }, actualTokens)) {
        const beforeCount = state.history.length;
        const estTokensBefore = estimateTokens(state.history);
        addOutput(
          theme.tertiary(
            `  [auto-compacting: ${beforeCount} messages, ~${Math.round(estTokensBefore / 1000)}K tokens → summarizing...]`,
          ),
        );
        update();
        state.history = contextCollapse(state.history);
        state.history = snipCompact(state.history);
        state.history = await autoCompact(state.history, state.router);
        const afterCount = state.history.length;
        const estTokensAfter = estimateTokens(state.history);
        addOutput(
          theme.tertiary(
            `  [compacted: ${beforeCount} → ${afterCount} messages, ~${Math.round(estTokensBefore / 1000)}K → ~${Math.round(estTokensAfter / 1000)}K tokens]`,
          ),
        );

        // Persist compact boundary to session log
        await state.session.insertCompactBoundary(buildCompactSummary(), state.history.length).catch(() => {});
      }

      resetMarkdown();
      const preTurnMessageCount = state.history.length;
      turnToolCount = 0;

      // Update turn number on context so file snapshots track which turn modified them
      state.toolContext.turnNumber = turnCount;

      let responseText = "";

      // Set up abort controller for Ctrl+C interrupt
      const abortController = new AbortController();
      currentAbortController = abortController;

      // Wrap agent loop in AsyncLocalStorage root context for sub-agent isolation
      const rootCtx: AgentContext = {
        agentId: `root-${state.session.id}-${turnCount}`,
        agentName: "main",
        cwd: state.toolContext.cwd,
        readOnly: isPlanMode(),
        depth: 0,
        startedAt: new Date().toISOString(),
      };

      // Race the agent loop against the abort signal so Ctrl+C actually stops it
      const abortPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener("abort", () => reject(new Error("Interrupted by user")));
      });

      const result = await runWithAgentContext(rootCtx, () =>
        Promise.race([
          runAgentLoop(input, state.history, {
            systemPrompt,
            maxIterations: effortConfig.maxIterations,
            router: state.router,
            toolRegistry: state.registry,
            toolContext: state.toolContext,
            readOnly: isPlanMode(),
            onUsage: (usage) => {
              if (usage.inputTokens) turnInputTokens = usage.inputTokens;
              if (usage.outputTokens) turnOutputTokens = usage.outputTokens;
              const tokens = turnOutputTokens || Math.round(turnCharCount / 4);
              tokenStats = computeTokenStats(tokens, false);
              update();
            },
            onText: (text) => {
              isProcessing = false;
              if (!turnStreamStart) turnStreamStart = Date.now();
              turnCharCount += text.length;
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
              // Update token stats from char estimate if no actual usage yet
              if (!turnOutputTokens) {
                tokenStats = computeTokenStats(Math.round(turnCharCount / 4), true);
              }
              spinnerText = responseText;
              update();
            },
            onToolStart: (name, toolInput) => {
              isProcessing = true;
              spinnerText = name;
              toolStartTime = Date.now();
              currentToolInput = toolInput as Record<string, unknown>;
              recordThinking(state.buddy);
              cmuxToolStart(name);
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
              lastFullToolOutput = result; // Store full output for /expand
              cmuxToolEnd();
              logEvent(isError ? "tool_error" : "tool_end", { tool: _name }).catch(() => {});
              if (isError) {
                recordError(state.buddy);
                lastHadError = true;
              } else recordToolCallSuccess(state.buddy);

              // Use message renderer for formatted output
              addOutput(""); // spacing before tool block
              const rendered = formatToolExecution(_name, currentToolInput, result, isError, durationMs);
              for (const line of rendered) addOutput(line);

              if (isError) addOutput(getBuddyReaction(state.buddy, "error"));
              toolStartTime = 0;
              currentToolInput = {};
              update();
            },
          }),
          abortPromise,
        ]),
      );

      currentAbortController = null;

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

      // Clear token stats
      tokenStats = "";

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
      const tc = state.history.filter((m) => m.role === "user" && typeof m.content === "string").length;
      const budgetInfo = {
        budgetUSD: state.router.costTracker.budgetUSD,
        percentUsed: state.router.costTracker.getBudgetPercent(),
      };
      const turnDurationMs = Date.now() - turnStartTime;
      addOutput(
        formatTurnSeparator(
          tc,
          state.router.costs.totalCostUSD,
          state.buddy.name,
          turnToolCount,
          speculationCache.getStats(),
          budgetInfo,
          { ultrathink: isUltrathinkTurn, durationMs: turnDurationMs },
        ),
      );

      // Suggest verification after multi-file changes
      const { shouldAutoVerify, getModifiedFiles, clearModifiedFiles } = await import("./agent/verification.ts");
      if (shouldAutoVerify()) {
        const modCount = getModifiedFiles().length;
        addOutput(theme.tertiary(`  💡 ${modCount} files modified — run /verify to validate changes\n`));
      }
      clearModifiedFiles(); // Reset for next turn

      // Desktop notification when terminal is not focused
      detectTerminalFocus()
        .then((focus) => {
          if (focus === "unfocused") {
            notifyTurnComplete(turnToolCount, Date.now() - turnStartTime).catch(() => {});
          }
        })
        .catch(() => {});

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
          state.router.currentProvider.config.baseURL,
        )
          .then((comment) => {
            if (gen !== aiCommentGen) return; // Stale — a newer turn started
            currentQuipType = comment.type;
            cachedQuip = comment.text;
            const pool = QUIPS[state.buddy.mood] ?? [];
            if (!pool.includes(comment.text)) {
              QUIPS[state.buddy.mood] = [...pool, comment.text];
            }
            update();
          })
          .catch(() => {})
          .finally(() => {
            aiCommentInFlight = false;
          });
      }
      lastHadError = false;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      currentAbortController = null;

      // Don't show error for user-initiated interrupts
      if (error.message === "Interrupted by user") {
        // Interrupt is already reported by handleInterrupt()
      } else {
        const categorized = categorizeError(error);
        const hint = ERROR_RECOVERY_HINTS[categorized.category];
        addOutput(theme.error(`\n  Error: ${categorized.message}\n`) + (hint ? theme.muted(`  ${hint}\n`) : ""));
        logEvent("error", { message: categorized.message }).catch(() => {});
        notifyError(categorized.message).catch(() => {});
        lastHadError = true;
      }
    }

    finishProcessing();
  }

  // Wire deferred trigger callback now that runTurnInk is defined
  _triggerCallback = runTurnInk;

  async function handleExit() {
    cmuxSessionEnd();
    idleDetector.stop();
    triggerRunner.stop();
    stopRemotePolling();
    stopBridgeServer();
    stopBuddyAnimation();

    // Clean up orphaned worktrees (>24h old)
    import("./agent/worktree-manager.ts")
      .then(({ cleanupOrphanedWorktrees }) => cleanupOrphanedWorktrees())
      .catch(() => {});
    if (kairos?.isRunning()) await kairos.stop().catch(() => {});
    productAgent?.stop();
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
      await generateDream(state.history, state.session.id, state.router).catch(() => {});
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
  const handleModeSwitch = () => {
    cycleMode();
    update();
  };
  const handleUndo = () => {
    commandRegistry.dispatch("/undo", buildCommandContext()).catch(() => {});
  };
  const handleEffortCycle = () => {
    cycleEffort();
    update();
  };
  const handleCompact = () => {
    commandRegistry.dispatch("/compact", buildCommandContext()).catch(() => {});
  };
  const handleClearScreen = () => {
    items = [];
    update();
  };
  const handleVoiceToggle = () => {
    commandRegistry.dispatch("/voice", buildCommandContext()).catch(() => {});
  };

  function handleInterrupt() {
    if (!isProcessing) return;
    // Abort the running agent loop — the catch block in runTurnInk
    // will call finishProcessing(). isProcessing stays true until then
    // so double-Ctrl+C can still trigger force exit.
    currentAbortController?.abort();
    addOutput(chalk.yellow("\n  ⚡ Interrupted — stopping current turn") + chalk.dim("  (Ctrl+C again to exit)\n"));
    messageQueue.length = 0;
  }

  function appProps() {
    return {
      onSubmit: handleSubmit,
      onExit: handleExit,
      onInterrupt: handleInterrupt,
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
