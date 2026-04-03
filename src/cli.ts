#!/usr/bin/env bun

/**
 * AshlrCode (ac) — Multi-provider AI coding agent CLI.
 *
 * Entry point: sets up providers, tools, sessions, plan mode, context
 * management, and runs the interactive REPL.
 */

import { readFile } from "fs/promises";
import { resolve, join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import { createInterface } from "readline";

import { ProviderRouter } from "./providers/router.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { runAgentLoop } from "./agent/loop.ts";
import { loadSettings } from "./config/settings.ts";
import { initRemoteSettings, startPolling, loadCachedSettings, stopPolling } from "./config/remote-settings.ts";
import { Session, listSessions, resumeSession, getLastSessionForCwd, forkSession } from "./persistence/session.ts";
import {
  needsCompaction,
  autoCompact,
  snipCompact,
  estimateTokens,
  getProviderContextLimit,
} from "./agent/context.ts";
import {
  isPlanMode,
  getPlanModePrompt,
  getPlanState,
  exitPlanMode,
} from "./planning/plan-mode.ts";
import type { Message } from "./providers/types.ts";
import type { ToolContext } from "./tools/types.ts";

// Tools
import { bashTool } from "./tools/bash.ts";
import { fileReadTool } from "./tools/file-read.ts";
import { fileWriteTool } from "./tools/file-write.ts";
import { fileEditTool } from "./tools/file-edit.ts";
import { globTool } from "./tools/glob.ts";
import { grepTool } from "./tools/grep.ts";
import { askUserTool } from "./tools/ask-user.ts";
import { webFetchTool } from "./tools/web-fetch.ts";
import { enterPlanTool, exitPlanTool, planWriteTool } from "./planning/plan-tools.ts";
import { agentTool, initAgentTool } from "./tools/agent.ts";
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from "./tools/tasks.ts";
import { loadMemories, formatMemoriesForPrompt } from "./persistence/memory.ts";
import {
  loadPermissions,
  checkPermission,
  recordPermission,
  allowForSession,
  setBypassMode,
  setAutoAcceptEdits,
  isBypassMode,
  setRules,
} from "./config/permissions.ts";
import { Spinner, getToolPhrase } from "./ui/spinner.ts";
import { renderMarkdownDelta, flushMarkdown, resetMarkdown } from "./ui/markdown.ts";
import { printBanner, printTurnSeparator, printInputLine, printStatusLine } from "./ui/banner.ts";
import { getCurrentMode, setMode, cycleMode, getPromptForMode, type Mode } from "./ui/mode.ts";
import { renderContextBar } from "./ui/context-bar.ts";
import { loadBuddy, printBuddy, saveBuddy, startSession, recordToolCallSuccess, recordThinking, recordError, getBuddyReaction, isFirstToolCall, type BuddyData } from "./ui/buddy.ts";
import { theme, styleCost, styleTokens } from "./ui/theme.ts";
import { lsTool } from "./tools/ls.ts";
import { configTool } from "./tools/config.ts";
import { enterWorktreeTool, exitWorktreeTool } from "./tools/worktree.ts";
import { webSearchTool } from "./tools/web-search.ts";
import { toolSearchTool, initToolSearch } from "./tools/tool-search.ts";
import { powershellTool } from "./tools/powershell.ts";
import { getGitContext, formatGitPrompt } from "./config/git.ts";
import { loadHooksFromSettings } from "./config/hooks.ts";
import { fileHistory } from "./state/file-history.ts";
import { memorySaveTool, memoryListTool, memoryDeleteTool } from "./tools/memory.ts";
import { notebookEditTool } from "./tools/notebook-edit.ts";
import { sendMessageTool } from "./tools/send-message.ts";
import { sleepTool } from "./tools/sleep.ts";
import { todoWriteTool } from "./tools/todo-write.ts";
import { diffTool } from "./tools/diff.ts";
import { lspTool, shutdownLSP } from "./tools/lsp.ts";
import { teamCreateTool, teamDeleteTool, teamListTool, teamDispatchTool, initTeamTools } from "./tools/team.ts";
import { MCPManager } from "./mcp/manager.ts";
import { createMCPTool } from "./tools/mcp-tool.ts";
import { listMcpResourcesTool, setMCPManager } from "./tools/mcp-resources.ts";
import { initTasks } from "./tools/tasks.ts";
import { loadSkills } from "./skills/loader.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { categorizeError } from "./agent/error-handler.ts";
import { buildSystemPrompt } from "./agent/system-prompt.ts";
import { runSetupWizard, needsSetup } from "./setup.ts";
import { loadProjectConfig } from "./config/project-config.ts";
import { startInkRepl } from "./repl.tsx";
import { VERSION } from "./version.ts";
let maxCostUSD = Infinity;

interface AppState {
  router: ProviderRouter;
  registry: ToolRegistry;
  toolContext: ToolContext;
  session: Session;
  history: Message[];
  baseSystemPrompt: string;
  skillRegistry: SkillRegistry;
  buddy: BuddyData;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`AshlrCode v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Load settings and permissions
  let settings = await loadSettings();
  await loadPermissions();

  // Wire up permission rules from settings
  if (settings.permissionRules) {
    setRules(settings.permissionRules);
  }

  // Initialize remote managed settings
  const remoteUrl = process.env.AC_REMOTE_SETTINGS_URL ?? settings.remoteSettingsUrl;
  if (remoteUrl) {
    initRemoteSettings(remoteUrl, settings.providers.primary.apiKey);
    await loadCachedSettings();
    startPolling();
  }

  // Parse mode flags
  const dangerouslySkipPermissions = args.includes("--dangerously-skip-permissions") || args.includes("--yolo");
  const autoAcceptEditsFlag = args.includes("--auto-accept-edits");
  const printMode = args.includes("--print");
  const maxCostArg = getArg(args, "--max-cost");
  maxCostUSD = maxCostArg ? parseFloat(maxCostArg) : Infinity;

  if (dangerouslySkipPermissions) {
    setBypassMode(true);
  }
  if (autoAcceptEditsFlag) {
    setAutoAcceptEdits(true);
  }

  if (needsSetup(settings)) {
    const newSettings = await runSetupWizard();
    settings = newSettings;
  }

  // Initialize provider router
  const router = new ProviderRouter(settings.providers);

  // Initialize tool registry
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(askUserTool);
  registry.register(webFetchTool);
  registry.register(enterPlanTool);
  registry.register(exitPlanTool);
  registry.register(planWriteTool);
  registry.register(agentTool);
  registry.register(taskCreateTool);
  registry.register(taskUpdateTool);
  registry.register(taskListTool);
  registry.register(taskGetTool);
  registry.register(lsTool);
  registry.register(configTool);
  registry.register(enterWorktreeTool);
  registry.register(exitWorktreeTool);
  registry.register(webSearchTool);
  registry.register(toolSearchTool);
  registry.register(memorySaveTool);
  registry.register(memoryListTool);
  registry.register(memoryDeleteTool);
  registry.register(notebookEditTool);
  registry.register(sendMessageTool);
  registry.register(sleepTool);
  registry.register(todoWriteTool);
  registry.register(diffTool);
  registry.register(lspTool);
  registry.register(teamCreateTool);
  registry.register(teamDeleteTool);
  registry.register(teamListTool);
  registry.register(teamDispatchTool);
  if (process.platform === "win32") {
    registry.register(powershellTool);
  }
  initToolSearch(registry);

  // Set up hooks from settings — toolHooks (new format) takes priority, falls back to hooks (legacy)
  if (settings.toolHooks) {
    const hooksConfig = loadHooksFromSettings(settings.toolHooks);
    registry.setHooks(hooksConfig);
  } else if (settings.hooks) {
    registry.setHooks(settings.hooks);
  }

  // Connect MCP servers in background (don't block startup)
  const mcpManager = new MCPManager();
  if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
    setMCPManager(mcpManager);
    registry.register(listMcpResourcesTool);
    mcpManager.connectAll(settings.mcpServers).then(() => {
      for (const { serverName, tool } of mcpManager.getAllTools()) {
        registry.register(createMCPTool(serverName, tool, mcpManager));
      }
    }).catch(() => {});
  }

  // Load system prompt via builder (knowledge files, memory, git context)
  const rawSystemPrompt = await loadSystemPrompt();
  const cwd = process.cwd();

  // Build prompt using SystemPromptBuilder — but skip addToolDescriptions()
  // because tools are already sent via the API's `tools` parameter.
  const { SystemPromptBuilder } = await import("./agent/system-prompt.ts");
  const promptBuilder = new SystemPromptBuilder();
  promptBuilder.addCoreInstructions(rawSystemPrompt);
  promptBuilder.addPermissionContext(getCurrentMode());

  if (isPlanMode()) {
    promptBuilder.addPlanMode();
  }

  await promptBuilder.addKnowledgeFiles(cwd);
  await promptBuilder.addMemoryFiles();

  // Append legacy memories (from persistence/memory.ts) for backward compat
  const memories = await loadMemories(cwd);
  if (memories.length > 0) {
    promptBuilder.addSection("legacy-memories", formatMemoriesForPrompt(memories), 45);
  }

  // Git context via builder method (richer than legacy formatGitPrompt)
  await promptBuilder.addGitContext(cwd);

  const assembled = promptBuilder.build(8000);
  let baseSystemPrompt = assembled.text;

  // Initialize agent tool with router/registry references
  initAgentTool(router, registry, baseSystemPrompt);
  initTeamTools(router, registry, baseSystemPrompt);

  // Tool context
  const toolContext: ToolContext = {
    cwd,
    requestPermission: async (tool, description) => {
      return await askPermission(tool, description);
    },
  };

  // Session handling
  let session: Session;
  let history: Message[] = [];

  const resumeId = getArg(args, "--resume");
  const forkId = getArg(args, "--fork-session");
  const continueFlag = args.includes("--continue") || args.includes("-c");

  if (resumeId) {
    const resumed = await resumeSession(resumeId);
    if (resumed) {
      session = resumed.session;
      history = resumed.messages;
      console.log(chalk.dim(`Resumed session ${resumeId} (${history.length} messages)`));
    } else {
      console.error(chalk.red(`Session ${resumeId} not found`));
      process.exit(1);
    }
  } else if (continueFlag) {
    const lastId = await getLastSessionForCwd(cwd);
    if (lastId) {
      const resumed = await resumeSession(lastId);
      if (resumed) {
        session = resumed.session;
        history = resumed.messages;
        console.log(chalk.dim(`Continued session ${lastId} (${history.length} messages)`));
      } else {
        session = new Session();
        await session.init(router.currentProvider.name, router.currentProvider.config.model);
      }
    } else {
      session = new Session();
      await session.init(router.currentProvider.name, router.currentProvider.config.model);
    }
  } else if (forkId) {
    const forked = await forkSession(forkId, router.currentProvider.name, router.currentProvider.config.model);
    if (forked) {
      session = forked.session;
      history = forked.messages;
      console.log(chalk.dim(`Forked session ${forkId} → ${session.id} (${history.length} messages)`));
    } else {
      console.error(chalk.red(`Session ${forkId} not found`));
      process.exit(1);
    }
  } else {
    session = new Session();
    await session.init(router.currentProvider.name, router.currentProvider.config.model);
  }

  // Initialize task persistence
  await initTasks(session.id);

  // Load skills
  const skillRegistry = new SkillRegistry();
  const skills = await loadSkills(cwd);
  skillRegistry.registerAll(skills);
  // Skills loaded silently — use /skills to list them

  // Load buddy (don't reset mood — let it carry from last session)
  const buddy = await loadBuddy();
  await startSession(buddy);

  const state: AppState = {
    router,
    registry,
    toolContext,
    session,
    history,
    baseSystemPrompt,
    skillRegistry,
    buddy,
  };

  // Set initial mode based on flags
  if (dangerouslySkipPermissions) setMode("yolo");
  else if (autoAcceptEditsFlag) setMode("accept-edits");

  // Header (suppress in print mode)
  if (!printMode) {
    const startMode = dangerouslySkipPermissions ? "yolo" : autoAcceptEditsFlag ? "accept-edits" : undefined;
    printBanner(VERSION, router.currentProvider.name, router.currentProvider.config.model, startMode);
    printBuddy(buddy);
    console.log(theme.tertiary(`  ${cwd}`));
    if (buddy.totalSessions <= 1) {
      // First-time quick-start
      console.log(theme.accent("\n  Welcome! Here are some things to try:"));
      console.log(theme.secondary(`    "fix the login bug"`) + theme.tertiary(`          — describe any task`));
      console.log(theme.secondary(`    /explore`) + theme.tertiary(`                        — analyze this codebase`));
      console.log(theme.secondary(`    /commit`) + theme.tertiary(`                         — commit your changes`));
      console.log(theme.secondary(`    /buddy`) + theme.tertiary(`                          — meet ${buddy.name}!`));
      console.log(theme.tertiary(`\n  Shift+Tab switches modes. /help for all commands.\n`));
    } else {
      console.log(theme.tertiary(`  Shift+Tab to switch modes. /help for commands. Ctrl+C to exit.\n`));
    }
  }

  // Graceful Ctrl+C — only for non-interactive paths (--print, single-shot)
  // In Ink mode, repl.tsx handleExit() manages cleanup + process.exit
  // Only register SIGINT for non-Ink paths. Ink handles its own exit.
  const isNonInteractive = printMode || args.some(a => !a.startsWith("-") && !a.startsWith("--"));
  if (isNonInteractive) process.on("SIGINT", async () => {
    try {
      if (state.history.length > 0) {
        await state.session.appendMessages(state.history.slice(-2));
      }
      state.buddy.mood = "sleepy";
      await saveBuddy(state.buddy);
    } catch {}
    if (!printMode) {
      console.log(chalk.dim(`\n${router.getCostSummary()}`));
    }
    mcpManager.disconnectAll().catch(() => {});
    shutdownLSP().catch(() => {});
    stopPolling();
    process.exit(0);
  });

  // Check for inline command
  const inlineMessage = args
    .filter((a) => !a.startsWith("-") && !a.startsWith("--"))
    .join(" ");

  if (inlineMessage) {
    await runTurn(inlineMessage, state, printMode);
    if (!printMode) {
      console.log(chalk.dim(`\n${router.getCostSummary()}`));
    }
    process.exit(0);
  }

  // Interactive REPL — use Ink for proper cursor positioning
  startInkRepl(state, maxCostUSD);
}

function getPrompt(): string {
  return getPromptForMode();
}

async function handleCommand(
  input: string,
  state: AppState,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const [cmd, ...rest] = input.split(" ");
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/quit":
    case "/exit":
    case "/q":
      console.log(chalk.dim(state.router.getCostSummary()));
      process.exit(0);

    case "/cost":
      console.log(theme.secondary(state.router.getCostSummary()));
      console.log(
        theme.tertiary(
          `Context: ~${estimateTokens(state.history).toLocaleString()} tokens, ${state.history.length} messages`
        )
      );
      // Cost nudge
      if (state.router.costs.totalCostUSD > 5) {
        console.log(theme.warning(`\n  💡 Expensive session ($${state.router.costs.totalCostUSD.toFixed(2)}). Consider:`));
        console.log(theme.tertiary(`     /model grok-3  — 80% cheaper for exploration`));
        console.log(theme.tertiary(`     /compact       — reduce context size`));
        console.log(theme.tertiary(`     /effort fast   — shorter responses`));
      } else if (state.router.costs.totalCostUSD > 1) {
        console.log(theme.tertiary(`\n  💡 Tip: /model grok-3 for cheaper exploration tasks`));
      }
      break;

    case "/clear":
      state.history.length = 0;
      if (isPlanMode()) exitPlanMode();
      console.log(chalk.dim("Conversation cleared."));
      break;

    case "/plan":
      if (isPlanMode()) {
        const planState = getPlanState();
        console.log(chalk.magenta("Plan mode is active."));
        console.log(chalk.dim(`Plan file: ${planState.planFilePath}`));
        console.log(chalk.dim(`Started: ${planState.startedAt}`));
      } else {
        console.log(
          chalk.dim(
            "Plan mode is not active. The model can enter plan mode by calling EnterPlan."
          )
        );
        console.log(
          chalk.dim(
            'Tip: Ask the model to "plan first" and it will use plan mode.'
          )
        );
      }
      break;

    case "/sessions": {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log(chalk.dim("No saved sessions."));
      } else {
        console.log(chalk.bold("Recent sessions:"));
        for (const s of sessions) {
          const age = timeSince(new Date(s.updatedAt));
          const title = s.title ?? s.cwd.split("/").pop() ?? s.id;
          const current = s.id === state.session.id ? chalk.cyan(" (current)") : "";
          console.log(
            `  ${chalk.bold(s.id)}${current} — ${title} (${s.messageCount} msgs, ${age} ago)`
          );
        }
        console.log(chalk.dim("\nResume with: ac --resume <id>"));
      }
      break;
    }

    case "/model":
      if (arg) {
        // Model switching
        const models: Record<string, string> = {
          "grok-fast": "grok-4-1-fast-reasoning",
          "grok-4": "grok-4-0314",
          "grok-3": "grok-3-fast",
          "sonnet": "claude-sonnet-4-6-20250514",
          "opus": "claude-opus-4-6-20250514",
          "haiku": "claude-haiku-4-5-20251001",
        };
        const resolved = models[arg] ?? arg;
        state.router.currentProvider.config.model = resolved;
        console.log(chalk.dim(`Switched to model: ${resolved}`));
      } else {
        console.log(chalk.bold("Current:"));
        console.log(chalk.dim(`  Provider: ${state.router.currentProvider.name}`));
        console.log(chalk.dim(`  Model: ${state.router.currentProvider.config.model}`));
        console.log(chalk.bold("\nAliases:"));
        console.log(chalk.dim("  grok-fast  → grok-4-1-fast-reasoning"));
        console.log(chalk.dim("  grok-4     → grok-4-0314"));
        console.log(chalk.dim("  grok-3     → grok-3-fast"));
        console.log(chalk.dim("  sonnet     → claude-sonnet-4-6-20250514"));
        console.log(chalk.dim("  opus       → claude-opus-4-6-20250514"));
        console.log(chalk.dim("\nUsage: /model <alias or model-id>"));
      }
      break;

    case "/compact": {
      const before = estimateTokens(state.history);
      state.history = snipCompact(state.history);
      state.history = await autoCompact(state.history, state.router);
      const after = estimateTokens(state.history);
      console.log(
        chalk.dim(
          `Compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`
        )
      );
      break;
    }

    case "/history": {
      if (state.history.length === 0) {
        console.log(chalk.dim("No messages yet."));
      } else {
        let turnNum = 0;
        for (const msg of state.history) {
          if (msg.role === "user" && typeof msg.content === "string") {
            turnNum++;
            const preview = msg.content.length > 80 ? msg.content.slice(0, 77) + "..." : msg.content;
            console.log(chalk.cyan(`  ${turnNum}. `) + preview);
          } else if (msg.role === "assistant" && typeof msg.content === "string") {
            const preview = msg.content.length > 80 ? msg.content.slice(0, 77) + "..." : msg.content;
            console.log(chalk.dim(`     → ${preview}`));
          }
        }
      }
      break;
    }

    case "/undo": {
      // Remove last user + assistant turn
      if (state.history.length < 2) {
        console.log(chalk.dim("Nothing to undo."));
      } else {
        // Find and remove the last user message and everything after
        let lastUserIdx = -1;
        for (let i = state.history.length - 1; i >= 0; i--) {
          if (state.history[i]!.role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          const removed = state.history.length - lastUserIdx;
          state.history.splice(lastUserIdx);
          console.log(chalk.dim(`Undid last turn (removed ${removed} messages).`));
        }
      }
      break;
    }

    case "/restore": {
      if (!arg) {
        const snapshots = fileHistory.getSnapshotFiles();
        if (snapshots.length === 0) {
          console.log(chalk.dim("No file snapshots available."));
        } else {
          console.log(chalk.bold("Files with snapshots:"));
          for (const s of snapshots) {
            console.log(chalk.dim(`  ${s.path} (${s.count} snapshot(s))`));
          }
          console.log(chalk.dim("\nUsage: /restore <file-path>"));
        }
      } else {
        const restored = await fileHistory.restore(arg);
        if (restored) {
          console.log(chalk.green(`Restored: ${arg}`));
        } else {
          console.log(chalk.red(`No snapshot found for: ${arg}`));
        }
      }
      break;
    }

    case "/memory": {
      const mems = await loadMemories(process.cwd());
      if (mems.length === 0) {
        console.log(chalk.dim("No memories for this project. The model can save memories using MemorySave."));
      } else {
        console.log(chalk.bold(`${mems.length} project memories:`));
        for (const m of mems) {
          console.log(chalk.dim(`  ${chalk.bold(m.name)} (${m.type}): ${m.description || m.content.slice(0, 60)}`));
        }
      }
      break;
    }

    case "/skills": {
      const allSkills = state.skillRegistry.getAll();
      if (allSkills.length === 0) {
        console.log(chalk.dim("No skills loaded. Add .md files to ~/.ashlrcode/skills/"));
      } else {
        console.log(chalk.bold(`${allSkills.length} skills:`));
        for (const s of allSkills) {
          console.log(chalk.dim(`  ${chalk.bold(s.trigger)} — ${s.description}`));
        }
      }
      break;
    }

    case "/tools": {
      const tools = state.registry.getAll();
      console.log(chalk.bold(`${tools.length} tools registered:`));
      for (const tool of tools) {
        const flags = [
          tool.isReadOnly() ? chalk.green("read-only") : chalk.yellow("write"),
          tool.isConcurrencySafe() ? "parallel" : "serial",
        ].join(", ");
        console.log(chalk.dim(`  ${chalk.bold(tool.name)} (${flags})`));
      }
      break;
    }

    case "/diff": {
      const proc = Bun.spawn(["git", "diff", "--stat"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      if (stdout.trim()) {
        console.log(stdout);
      } else {
        console.log(chalk.dim("No uncommitted changes."));
      }
      break;
    }

    case "/git": {
      const gitInfo = await getGitContext(process.cwd());
      if (!gitInfo.isRepo) {
        console.log(chalk.dim("Not a git repository."));
      } else {
        console.log(chalk.bold("Git:"));
        console.log(chalk.dim(`  Branch: ${gitInfo.branch}`));
        console.log(chalk.dim(`  Remote: ${gitInfo.remoteUrl ?? "none"}`));
        const changes = gitInfo.status?.split("\n").filter(Boolean).length ?? 0;
        console.log(chalk.dim(`  Changes: ${changes > 0 ? changes : "clean"}`));
      }
      break;
    }

    case "/buddy": {
      if (arg === "name" || arg?.startsWith("name ")) {
        const newName = arg.replace("name", "").trim();
        if (newName) {
          state.buddy.name = newName;
          await saveBuddy(state.buddy);
          console.log(theme.success(`  Buddy renamed to ${newName}!`));
        } else {
          console.log(theme.tertiary("  Usage: /buddy name <new-name>"));
        }
      } else {
        printBuddy(state.buddy);
        const b = state.buddy;
        const shinyStr = b.shiny ? " ✨ SHINY" : "";
        console.log(theme.primary(`  ${b.name} the ${b.species}${shinyStr}`));
        console.log(theme.primary(`  Rarity: ${b.rarity.toUpperCase()} · Level ${b.level} · Hat: ${b.hat}`));
        console.log(theme.primary(`  Stats: 🐛${b.stats.debugging} 🧘${b.stats.patience} 🌀${b.stats.chaos} 🦉${b.stats.wisdom} 😏${b.stats.snark}`));
        console.log(theme.primary(`  Mood: ${b.mood}`));
        console.log(theme.tertiary(`  Sessions: ${b.totalSessions} · Tool calls: ${b.toolCalls}`));
        console.log(theme.tertiary(`\n  Rename: /buddy name <new-name>`));
      }
      break;
    }

    case "/effort": {
      const levels = ["fast", "balanced", "thorough"];
      if (!arg) {
        console.log(theme.primary("Effort: " + (state.router.currentProvider.config.maxTokens === 4096 ? "fast" : state.router.currentProvider.config.maxTokens === 16384 ? "thorough" : "balanced")));
        console.log(theme.tertiary("  fast      — shorter responses, fewer tokens"));
        console.log(theme.tertiary("  balanced  — default behavior"));
        console.log(theme.tertiary("  thorough  — deeper analysis, more tokens"));
        console.log(theme.tertiary("  Usage: /effort <level>"));
      } else if (levels.includes(arg)) {
        const tokenMap: Record<string, number> = { fast: 4096, balanced: 8192, thorough: 16384 };
        state.router.currentProvider.config.maxTokens = tokenMap[arg]!;
        console.log(theme.success(`  Effort set to: ${arg} (${tokenMap[arg]} max tokens)`));
      } else {
        console.log(theme.error(`  Unknown effort level. Choose: ${levels.join(", ")}`));
      }
      break;
    }

    case "/btw": {
      if (!arg) {
        console.log(theme.tertiary("  Ask a quick side question: /btw <question>"));
      } else {
        await runTurn(`[Side question — answer briefly, don't change the main task] ${arg}`, state);
      }
      break;
    }

    case "/status": {
      const taskList = await import("./tools/tasks.ts");
      console.log(theme.primary("Session: ") + theme.accent(state.session.id));
      console.log(theme.primary("Provider: ") + theme.accent(state.router.currentProvider.name + ":" + state.router.currentProvider.config.model));
      console.log(theme.primary("Messages: ") + theme.tokens(String(state.history.length)));
      console.log(theme.primary("Cost: ") + styleCost(state.router.costs.totalCostUSD));
      const ctxLimit = getProviderContextLimit(state.router.currentProvider.name);
      const ctxUsed = estimateTokens(state.history);
      console.log(theme.primary("Context: ") + styleTokens(ctxUsed) + theme.tertiary(" / ") + styleTokens(ctxLimit) + theme.tertiary(` (${Math.round((ctxUsed / ctxLimit) * 100)}%)`));
      break;
    }

    case "/help":
      printCommands();
      break;

    default:
      console.log(theme.tertiary(`Unknown command: ${cmd}. Type /help for available commands.`));
  }
}

async function runTurn(input: string, state: AppState, printMode = false): Promise<void> {
  const spinner = printMode ? null : new Spinner("Thinking");
  let firstTextReceived = false;

  try {
    // Ultrathink: if user includes "ultrathink" in message, use max tokens for this turn
    const isUltrathink = input.toLowerCase().includes("ultrathink");
    const savedMaxTokens = state.router.currentProvider.config.maxTokens;
    if (isUltrathink) {
      state.router.currentProvider.config.maxTokens = 32768;
      if (!printMode) console.log(theme.accent("  ⚡ Ultrathink mode — deep reasoning enabled\n"));
    }

    // Check cost budget
    if (maxCostUSD < Infinity && state.router.costs.totalCostUSD >= maxCostUSD) {
      console.error(chalk.yellow(`\n  Cost limit reached ($${state.router.costs.totalCostUSD.toFixed(4)} >= $${maxCostUSD}). Use --max-cost to increase.`));
      return;
    }

    // Build system prompt (base + plan mode if active)
    const systemPrompt =
      state.baseSystemPrompt + getPlanModePrompt();

    // Check if context needs compaction before this turn
    const systemTokens = Math.ceil(systemPrompt.length / 4);
    const contextLimit = getProviderContextLimit(state.router.currentProvider.name);

    // Warn at 50% and 75% of context limit
    const currentTokens = estimateTokens(state.history) + systemTokens;
    if (!printMode && currentTokens > contextLimit * 0.85) {
      console.log(theme.error(`  ⚠ Context at ${Math.round((currentTokens / contextLimit) * 100)}% — approaching limit!`));
      console.log(theme.tertiary(`  💡 Run /compact to shrink context, or start fresh with ac --continue`));
    } else if (!printMode && currentTokens > contextLimit * 0.75) {
      console.log(theme.warning(`  ⚠ Context at ${Math.round((currentTokens / contextLimit) * 100)}% of ${contextLimit.toLocaleString()} token limit`));
    } else if (!printMode && currentTokens > contextLimit * 0.5) {
      console.log(theme.tertiary(`  Context at ${Math.round((currentTokens / contextLimit) * 100)}% of limit`));
    }

    if (needsCompaction(state.history, systemTokens, { maxContextTokens: contextLimit })) {
      if (!printMode) console.log(chalk.dim("  [compacting context...]"));
      state.history = snipCompact(state.history);
      state.history = await autoCompact(state.history, state.router);
    }

    // Start spinner (not in print mode)
    spinner?.start();
    resetMarkdown();

    // Auto-title session from first message
    if (state.history.length === 0) {
      const title = input.length > 60 ? input.slice(0, 57) + "..." : input;
      await state.session.setTitle(title);
    }

    // Capture message count AFTER compaction (not before)
    const preTurnMessageCount = state.history.length;

    // Echo user input as a styled message (so it stays visible during output)
    if (!printMode) {
      console.log("\n" + theme.accent("  ❯ ") + theme.primary(input.length > 100 ? input.slice(0, 97) + "..." : input));
      console.log("");
    }

    const result = await runAgentLoop(input, state.history, {
      systemPrompt,
      router: state.router,
      toolRegistry: state.registry,
      toolContext: state.toolContext,
      readOnly: isPlanMode(),
      onText: (text) => {
        if (!firstTextReceived) {
          spinner?.stop();
          firstTextReceived = true;
          if (!printMode) console.log(""); // breathing room before response
        }
        if (printMode) {
          process.stdout.write(text);
        } else {
          const rendered = renderMarkdownDelta(text);
          process.stdout.write(rendered);
        }
      },
      onToolStart: (name, toolInput) => {
        if (printMode) return;
        spinner?.stop();
        firstTextReceived = false;
        recordThinking(state.buddy);
        const icon = isPlanMode() ? theme.plan("◆") : theme.toolIcon("◆");
        const preview = formatToolPreview(name, toolInput);
        console.log(`\n  ${icon} ${theme.toolName(name)}`);
        console.log(theme.tertiary(`    ${preview}`));
        if (isFirstToolCall()) {
          console.log(getBuddyReaction(state.buddy, "first_tool"));
        }
        spinner?.start(getToolPhrase(name));
      },
      onToolEnd: (_name, result, isError) => {
        if (printMode) return;
        spinner?.stop();
        if (isError) {
          recordError(state.buddy);
        } else {
          recordToolCallSuccess(state.buddy);
        }
        const status = isError ? theme.error("  ✗") : theme.success("  ✓");
        const lines = result.split("\n");
        const preview = lines[0]?.slice(0, 90) ?? "";
        const extra =
          lines.length > 1
            ? theme.tertiary(` (+${lines.length - 1} lines)`)
            : "";
        console.log(`${status} ${theme.toolResult(preview)}${extra}`);
        if (isError) {
          console.log(getBuddyReaction(state.buddy, "error"));
        }
        console.log("");
      },
    });

    spinner?.stop();

    // Flush any remaining markdown buffer
    const remaining = flushMarkdown();
    if (remaining) process.stdout.write(remaining);

    // Update history
    state.history.length = 0;
    state.history.push(...result.messages);

    // Persist all new messages from this turn (not just last 2)
    const newMessages = result.messages.slice(preTurnMessageCount);
    if (newMessages.length > 0) {
      await state.session.appendMessages(newMessages);
    }

    // Restore max tokens if ultrathink was used
    if (isUltrathink && savedMaxTokens !== undefined) {
      state.router.currentProvider.config.maxTokens = savedMaxTokens;
    }
  } catch (err) {
    spinner?.stop();
    resetMarkdown(); // Ensure markdown state is clean after errors

    const error = err instanceof Error ? err : new Error(String(err));
    const categorized = categorizeError(error);

    switch (categorized.category) {
      case "rate_limit":
        console.error(chalk.yellow(`\nRate limited. The router will try the next provider automatically.`));
        break;
      case "auth":
        console.error(chalk.red(`\nAuth error: ${categorized.message}`));
        console.error(chalk.dim("Check your API key (XAI_API_KEY or ANTHROPIC_API_KEY)"));
        break;
      case "network":
        console.error(chalk.red(`\nNetwork error: ${categorized.message}`));
        break;
      default:
        console.error(chalk.red(`\nError: ${categorized.message}`));
    }
  }
}

async function loadSystemPrompt(): Promise<string> {
  // Load base system prompt
  const promptPath = resolve(import.meta.dir, "../../prompts/system.md");
  let prompt = "";
  if (existsSync(promptPath)) {
    prompt = await readFile(promptPath, "utf-8");
  }

  const projectConfig = await loadProjectConfig(process.cwd());
  if (projectConfig.instructions) {
    prompt += `\n\n# Project Instructions\n\n${projectConfig.instructions}`;
  }

  // Add environment context
  prompt += `\n\n# Environment
- Working directory: ${process.cwd()}
- Platform: ${process.platform}
- Date: ${new Date().toISOString().split("T")[0]}
`;

  return prompt;
}

async function askPermission(
  tool: string,
  description: string
): Promise<boolean> {
  // In plan mode, block non-read-only tools silently
  if (isPlanMode()) {
    return false;
  }

  // Check permission system
  const perm = checkPermission(tool);
  if (perm === "allow") return true;
  if (perm === "deny") return false;

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      chalk.yellow(`  Allow ${chalk.bold(tool)}? `) +
        chalk.dim(description) +
        chalk.yellow("\n  [y]es / [a]lways / [n]o / [d]eny always: "),
      async (answer) => {
        rl.close();
        const choice = answer.toLowerCase().trim();
        switch (choice) {
          case "y":
          case "yes":
            resolve(true);
            break;
          case "a":
          case "always":
            await recordPermission(tool, "always_allow");
            console.log(chalk.dim(`    ${tool} will be auto-allowed from now on.`));
            resolve(true);
            break;
          case "d":
          case "deny":
            await recordPermission(tool, "always_deny");
            console.log(chalk.dim(`    ${tool} will be auto-denied from now on.`));
            resolve(false);
            break;
          default:
            resolve(false);
            break;
        }
      }
    );
  });
}

function formatToolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `$ ${input.command}`;
    case "Read":
      return `${input.file_path}${input.offset ? `:${input.offset}` : ""}`;
    case "Write":
      return `→ ${input.file_path}`;
    case "Edit":
      return `${input.file_path}`;
    case "Glob":
      return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
    case "Grep":
      return `/${input.pattern}/${input.path ? ` in ${input.path}` : ""}`;
    case "WebFetch":
      return `${input.url}`;
    case "Agent":
      return `${input.description}`;
    case "LS":
      return input.path ? `${input.path}` : ".";
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function printCommands() {
  console.log(`
${theme.accent("Commands:")}
  ${theme.toolName("/plan")}           ${theme.secondary("Plan mode status")}
  ${theme.toolName("/cost")}           ${theme.secondary("Token usage and costs")}
  ${theme.toolName("/status")}         ${theme.secondary("Full session status")}
  ${theme.toolName("/effort")} ${theme.tertiary("<lvl>")}   ${theme.secondary("Set reasoning effort (fast/balanced/thorough)")}
  ${theme.toolName("/btw")} ${theme.tertiary("<q>")}      ${theme.secondary("Quick side question")}
  ${theme.toolName("/history")}        ${theme.secondary("Conversation turns")}
  ${theme.toolName("/undo")}           ${theme.secondary("Remove last turn")}
  ${theme.toolName("/restore")} ${theme.tertiary("<f>")}   ${theme.secondary("Undo file edit")}
  ${theme.toolName("/diff")}           ${theme.secondary("Git diff --stat")}
  ${theme.toolName("/git")}            ${theme.secondary("Branch, remote, changes")}
  ${theme.toolName("/compact")}        ${theme.secondary("Compress context")}
  ${theme.toolName("/tools")}          ${theme.secondary("List all tools")}
  ${theme.toolName("/skills")}         ${theme.secondary("List all skills")}
  ${theme.toolName("/memory")}         ${theme.secondary("Project memories")}
  ${theme.toolName("/sessions")}       ${theme.secondary("Saved sessions")}
  ${theme.toolName("/buddy")}          ${theme.secondary("Meet your companion")}
  ${theme.toolName("/model")} ${theme.tertiary("<name>")}  ${theme.secondary("Show/switch model")}
  ${theme.toolName("/clear")}          ${theme.secondary("Clear conversation")}
  ${theme.toolName("/help")}           ${theme.secondary("Show this help")}
  ${theme.toolName("/quit")}           ${theme.secondary("Exit")}

${theme.accent("Tips:")}
  ${theme.tertiary("Shift+Tab")}       ${theme.secondary("Cycle mode: Normal → Plan → Edits → YOLO")}
  ${theme.tertiary("line ending \\\\")}  ${theme.secondary("Multi-line input")}
  ${theme.tertiary("[y/a/n/d]")}       ${theme.secondary("Permission: yes / always / no / deny-always")}
`);
}

function printHelp() {
  console.log(`
${chalk.bold.cyan("AshlrCode")} ${chalk.dim(`v${VERSION}`)} — Multi-provider AI coding agent

${chalk.bold("USAGE")}
  ac [message]              Run with a single message (non-interactive)
  ac                        Start interactive REPL
  ac --resume <id>          Resume a previous session

${chalk.bold("OPTIONS")}
  -h, --help                          Show this help
  -v, --version                       Show version
  -c, --continue                      Resume last session in this directory
  --resume <id>                       Resume a specific session
  --fork-session <id>                 Copy session into new session
  --dangerously-skip-permissions      Auto-approve all tool calls (alias: --yolo)
  --auto-accept-edits                 Auto-approve Write/Edit (Bash still asks)
  --print                             Output only text (for piping)
  --max-cost <dollars>                Stop when cost exceeds limit

${chalk.bold("COMMANDS")} (in REPL)
  /plan                     Show plan mode status
  /cost                     Show token usage and costs
  /compact                  Compress conversation context
  /sessions                 List saved sessions
  /model                    Show current model
  /clear                    Clear conversation
  /help                     Show available commands
  /quit                     Exit

${chalk.bold("TOOLS")} (available to the AI)
  Bash                      Execute shell commands
  Read                      Read files with line numbers
  Write                     Create/overwrite files
  Edit                      Exact string replacement
  Glob                      Find files by pattern
  Grep                      Search file contents
  WebFetch                  Fetch URLs
  AskUser                   Ask questions with structured options
  Agent                     Spawn sub-agents for exploration
  TaskCreate/Update/List    Track work progress
  EnterPlan                 Enter plan mode (read-only exploration)
  PlanWrite                 Write to plan file
  ExitPlan                  Exit plan mode

${chalk.bold("ENVIRONMENT")}
  XAI_API_KEY               xAI API key (primary provider)
  ANTHROPIC_API_KEY         Anthropic API key (fallback provider)
  AC_MODEL                  Override default model

${chalk.bold("CONFIG")}
  ~/.ashlrcode/settings.json    Provider configuration
  ~/.ashlrcode/sessions/        Saved sessions (JSONL)
  ~/.ashlrcode/plans/           Plan files
  ./ASHLR.md                    Project-level instructions
  ./CLAUDE.md                   Also supported for compatibility
`);
}

// Run
main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
