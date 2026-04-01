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
import { Session, listSessions, resumeSession } from "./persistence/session.ts";
import {
  needsCompaction,
  autoCompact,
  snipCompact,
  estimateTokens,
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
import { taskCreateTool, taskUpdateTool, taskListTool } from "./tools/tasks.ts";
import { loadMemories, formatMemoriesForPrompt } from "./persistence/memory.ts";
import {
  loadPermissions,
  checkPermission,
  recordPermission,
  allowForSession,
} from "./config/permissions.ts";
import { Spinner } from "./ui/spinner.ts";
import { renderMarkdownDelta, flushMarkdown, resetMarkdown } from "./ui/markdown.ts";
import { lsTool } from "./tools/ls.ts";
import { getGitContext, formatGitPrompt } from "./config/git.ts";

const VERSION = "0.5.0";

interface AppState {
  router: ProviderRouter;
  registry: ToolRegistry;
  toolContext: ToolContext;
  session: Session;
  history: Message[];
  baseSystemPrompt: string;
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
  const settings = await loadSettings();
  await loadPermissions();

  if (!settings.providers.primary.apiKey) {
    console.error(
      chalk.red("No API key configured.\n") +
        chalk.dim(
          "Set XAI_API_KEY environment variable or configure ~/.ashlrcode/settings.json"
        )
    );
    process.exit(1);
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
  registry.register(lsTool);

  // Load system prompt + project memories + git context
  let baseSystemPrompt = await loadSystemPrompt();

  const memories = await loadMemories(process.cwd());
  if (memories.length > 0) {
    baseSystemPrompt += formatMemoriesForPrompt(memories);
  }

  const gitCtx = await getGitContext(process.cwd());
  if (gitCtx.isRepo) {
    baseSystemPrompt += "\n\n" + formatGitPrompt(gitCtx);
  }

  // Initialize agent tool with router/registry references
  initAgentTool(router, registry, baseSystemPrompt);

  // Tool context
  const cwd = process.cwd();
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
  if (resumeId) {
    const resumed = await resumeSession(resumeId);
    if (resumed) {
      session = resumed.session;
      history = resumed.messages;
      console.log(
        chalk.dim(`Resumed session ${resumeId} (${history.length} messages)`)
      );
    } else {
      console.error(chalk.red(`Session ${resumeId} not found`));
      process.exit(1);
    }
  } else {
    session = new Session();
    await session.init(router.currentProvider.name, router.currentProvider.config.model);
  }

  const state: AppState = {
    router,
    registry,
    toolContext,
    session,
    history,
    baseSystemPrompt,
  };

  // Header
  const providerInfo = `${router.currentProvider.name}:${router.currentProvider.config.model}`;
  console.log(
    chalk.bold.cyan("AshlrCode") +
      chalk.dim(` v${VERSION}`) +
      chalk.dim(` | ${providerInfo}`) +
      chalk.dim(` | session:${session.id}`)
  );
  console.log(chalk.dim(`${cwd}`));
  console.log(
    chalk.dim('Commands: /plan /cost /sessions /model /clear /quit\n')
  );

  // Check for inline command
  const inlineMessage = args
    .filter((a) => !a.startsWith("-") && !a.startsWith("--"))
    .join(" ");

  if (inlineMessage) {
    await runTurn(inlineMessage, state);
    console.log(chalk.dim(`\n${router.getCostSummary()}`));
    process.exit(0);
  }

  // Interactive REPL with multi-line support
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(),
  });

  let multiLineBuffer = "";

  rl.prompt();

  rl.on("line", async (line) => {
    // Multi-line: if line ends with \, buffer and continue
    if (line.endsWith("\\")) {
      multiLineBuffer += line.slice(0, -1) + "\n";
      rl.setPrompt(chalk.dim("... "));
      rl.prompt();
      return;
    }

    const input = (multiLineBuffer + line).trim();
    multiLineBuffer = "";

    if (!input) {
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    // Handle commands
    if (input.startsWith("/")) {
      await handleCommand(input, state, rl);
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    await runTurn(input, state);
    console.log("");
    rl.setPrompt(getPrompt());
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(chalk.dim(`\n${router.getCostSummary()}`));
    process.exit(0);
  });
}

function getPrompt(): string {
  if (isPlanMode()) {
    return chalk.magenta("[plan] ❯ ");
  }
  return chalk.green("❯ ");
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
      console.log(chalk.dim(state.router.getCostSummary()));
      console.log(
        chalk.dim(
          `Context: ~${estimateTokens(state.history).toLocaleString()} tokens, ${state.history.length} messages`
        )
      );
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

    case "/help":
      printCommands();
      break;

    default:
      console.log(chalk.dim(`Unknown command: ${cmd}. Type /help for available commands.`));
  }
}

async function runTurn(input: string, state: AppState): Promise<void> {
  const spinner = new Spinner("Thinking");
  let firstTextReceived = false;

  try {
    // Build system prompt (base + plan mode if active)
    const systemPrompt =
      state.baseSystemPrompt + getPlanModePrompt();

    // Check if context needs compaction before this turn
    const systemTokens = Math.ceil(systemPrompt.length / 4);
    if (needsCompaction(state.history, systemTokens)) {
      console.log(chalk.dim("  [compacting context...]"));
      state.history = snipCompact(state.history);
      state.history = await autoCompact(state.history, state.router);
    }

    // Start spinner
    spinner.start();
    resetMarkdown();

    // Auto-title session from first message
    if (state.history.length === 0) {
      const title = input.length > 60 ? input.slice(0, 57) + "..." : input;
      await state.session.setTitle(title);
    }

    const result = await runAgentLoop(input, state.history, {
      systemPrompt,
      router: state.router,
      toolRegistry: state.registry,
      toolContext: state.toolContext,
      readOnly: isPlanMode(),
      onText: (text) => {
        if (!firstTextReceived) {
          spinner.stop();
          firstTextReceived = true;
        }
        // Render markdown formatting
        const rendered = renderMarkdownDelta(text);
        process.stdout.write(rendered);
      },
      onToolStart: (name, toolInput) => {
        spinner.stop();
        firstTextReceived = false;
        const icon = isPlanMode() ? chalk.magenta("◆") : chalk.yellow("●");
        console.log(chalk.dim(`\n  ${icon} ${chalk.bold(name)}`));
        const preview = formatToolPreview(name, toolInput);
        console.log(chalk.dim(`    ${preview}`));
        spinner.start(`Running ${name}`);
      },
      onToolEnd: (_name, result, isError) => {
        spinner.stop();
        const status = isError ? chalk.red("✗") : chalk.green("✓");
        const lines = result.split("\n");
        const preview = lines[0]?.slice(0, 100) ?? "";
        const extra =
          lines.length > 1
            ? chalk.dim(` (+${lines.length - 1} lines)`)
            : "";
        console.log(chalk.dim(`    ${status} ${preview}${extra}\n`));
      },
    });

    spinner.stop();

    // Flush any remaining markdown buffer
    const remaining = flushMarkdown();
    if (remaining) process.stdout.write(remaining);

    // Update history
    state.history.length = 0;
    state.history.push(...result.messages);

    // Persist to session
    await state.session.appendMessages(result.messages.slice(-2)); // last user + assistant pair
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\nError: ${message}`));

    spinner.stop();

    // If it's a rate limit, suggest fallback
    if (message.includes("429") || message.includes("rate_limit")) {
      console.error(
        chalk.yellow(
          "Rate limited. The router will automatically try the next provider on the next request."
        )
      );
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

  // Load project-level ASHLR.md
  const projectConfig = join(process.cwd(), "ASHLR.md");
  if (existsSync(projectConfig)) {
    const projectPrompt = await readFile(projectConfig, "utf-8");
    prompt += `\n\n# Project Instructions (ASHLR.md)\n\n${projectPrompt}`;
  }

  // Also support CLAUDE.md for compatibility
  const claudeConfig = join(process.cwd(), "CLAUDE.md");
  if (existsSync(claudeConfig)) {
    const claudePrompt = await readFile(claudeConfig, "utf-8");
    prompt += `\n\n# Project Instructions (CLAUDE.md)\n\n${claudePrompt}`;
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
${chalk.bold("Commands:")}
  /plan           Show plan mode status
  /cost           Show token usage and costs
  /history        Show conversation history
  /undo           Undo last turn
  /diff           Show git diff --stat
  /git            Show git repo info
  /compact        Compress conversation context
  /sessions       List saved sessions
  /model [name]   Show/switch model
  /clear          Clear conversation
  /help           Show this help
  /quit           Exit

${chalk.bold("Tips:")}
  End a line with \\ for multi-line input
  Permissions: [y]es [a]lways [n]o [d]eny-always
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
  -h, --help                Show this help
  -v, --version             Show version
  --resume <id>             Resume a saved session

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
