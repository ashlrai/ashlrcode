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
import { estimateTokens, getProviderContextLimit, needsCompaction, autoCompact, snipCompact } from "./agent/context.ts";
import { renderMarkdownDelta, flushMarkdown, resetMarkdown } from "./ui/markdown.ts";
import { getBuddyReaction, getBuddyArt, isFirstToolCall, recordThinking, recordToolCallSuccess, recordError, saveBuddy } from "./ui/buddy.ts";
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
import { setBypassMode } from "./config/permissions.ts";

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
  // IMPORTANT: Ink takes ownership of stdin in raw mode.
  // readline-based permission prompts (askPermission, askUserTool) will deadlock.
  // Enable bypass mode so all tools are auto-approved in Ink mode.
  // TODO: Build Ink-native permission prompt component.
  setBypassMode(true);
  let items: Array<{ id: number; text: string }> = [];
  let nextId = 0;
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

    return {
      mode,
      modeColor: modeColors[mode] ?? "green",
      contextPercent: ctxPct,
      contextUsed: formatTk(ctxUsed),
      contextLimit: formatTk(ctxLimit),
      buddyName: state.buddy.name,
      buddyQuip: getQuip(state.buddy.mood),
      buddyArt: getBuddyArt(state.buddy),
      items,
      isProcessing,
      spinnerText,
    };
  }

  async function handleSubmit(input: string) {
    // Prevent concurrent turns
    if (isProcessing) return;

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
      const handled = handleCommand(input);
      if (handled) return;
    }

    await runTurnInk(input);
  }

  function handleCommand(input: string): boolean {
    const [cmd, ...rest] = input.split(" ");
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "/help":
        addOutput(`\nCommands: /plan /cost /status /effort /btw /history /undo /restore /tools /skills /buddy /memory /sessions /model /compact /diff /git /clear /help /quit\n`);
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
      default:
        if (cmd?.startsWith("/")) {
          addOutput(theme.tertiary(`\n  Unknown command: ${cmd}\n`));
          return true;
        }
        return false;
    }
  }

  async function runTurnInk(input: string) {
    isProcessing = true;
    spinnerText = "Thinking";
    update();

    // Echo user input
    addOutput("\n" + theme.accent("  ❯ ") + theme.primary(input) + "\n");

    try {
      const systemPrompt = state.baseSystemPrompt + getPlanModePrompt();
      const systemTokens = Math.ceil(systemPrompt.length / 4);
      const contextLimit = getProviderContextLimit(state.router.currentProvider.name);

      if (needsCompaction(state.history, systemTokens, { maxContextTokens: contextLimit })) {
        addOutput(theme.tertiary("  [compacting context...]"));
        state.history = snipCompact(state.history);
        state.history = await autoCompact(state.history, state.router);
      }

      resetMarkdown();
      const preTurnMessageCount = state.history.length;

      let responseText = "";

      const result = await runAgentLoop(input, state.history, {
        systemPrompt,
        router: state.router,
        toolRegistry: state.registry,
        toolContext: state.toolContext,
        readOnly: isPlanMode(),
        onText: (text) => {
          isProcessing = false;
          responseText += text;
          // Flush complete lines immediately
          const lines = responseText.split("\n");
          if (lines.length > 1) {
            for (let i = 0; i < lines.length - 1; i++) {
              addOutput(lines[i]!);
            }
            responseText = lines[lines.length - 1]!;
          }
          // Also flush partial text after 200ms of no newlines (live streaming feel)
          if (responseText.length > 0) {
            addOutput(responseText);
            responseText = "";
          }
          update();
        },
        onToolStart: (name, toolInput) => {
          isProcessing = true;
          spinnerText = name;
          recordThinking(state.buddy);
          const preview = typeof toolInput.command === "string" ? `$ ${toolInput.command}` :
            typeof toolInput.file_path === "string" ? String(toolInput.file_path) :
            typeof toolInput.pattern === "string" ? `/${toolInput.pattern}/` :
            JSON.stringify(toolInput).slice(0, 80);
          addOutput(`\n  ${theme.toolIcon("◆")} ${theme.toolName(name)}`);
          addOutput(theme.tertiary(`    ${preview}`));
          if (isFirstToolCall()) {
            addOutput(getBuddyReaction(state.buddy, "first_tool"));
          }
          update();
        },
        onToolEnd: (_name, result, isError) => {
          isProcessing = false;
          if (isError) recordError(state.buddy);
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
      const turnCount = state.history.filter(m => m.role === "user" && typeof m.content === "string").length;
      addOutput(theme.muted(`\n  ── turn ${turnCount} · $${state.router.costs.totalCostUSD.toFixed(4)} · ${state.buddy.name} ──\n`));

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const categorized = categorizeError(error);
      addOutput(theme.error(`\n  Error: ${categorized.message}\n`));
    }

    isProcessing = false;
    update();
  }

  async function handleExit() {
    state.buddy.mood = "sleepy";
    await saveBuddy(state.buddy).catch(() => {});
    console.log("\n" + state.router.getCostSummary());
    process.exit(0);
  }

  // Initial render
  const { rerender } = render(
    <App
      onSubmit={handleSubmit}
      onExit={handleExit}
      {...getDisplayProps()}
    />
  );

  function update() {
    rerender(
      <App
        onSubmit={handleSubmit}
        onExit={handleExit}
        {...getDisplayProps()}
      />
    );
  }
}
