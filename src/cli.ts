#!/usr/bin/env bun

/**
 * AshlrCode (ac) — Multi-provider AI coding agent CLI.
 *
 * Entry point: sets up providers, tools, and runs the interactive REPL.
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
import type { Message } from "./providers/types.ts";
import type { ToolContext } from "./tools/types.ts";

// Tools
import { bashTool } from "./tools/bash.ts";
import { fileReadTool } from "./tools/file-read.ts";
import { fileWriteTool } from "./tools/file-write.ts";
import { fileEditTool } from "./tools/file-edit.ts";
import { globTool } from "./tools/glob.ts";
import { grepTool } from "./tools/grep.ts";

const VERSION = "0.1.0";

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

  // Load settings
  const settings = await loadSettings();

  if (!settings.providers.primary.apiKey) {
    console.error(
      chalk.red("No API key configured.\n") +
        chalk.dim("Set XAI_API_KEY environment variable or configure ~/.ashlrcode/settings.json")
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

  // Load system prompt
  const systemPrompt = await loadSystemPrompt();

  // Tool context
  const cwd = process.cwd();
  const toolContext: ToolContext = {
    cwd,
    requestPermission: async (tool, description) => {
      return await askPermission(tool, description);
    },
  };

  console.log(
    chalk.bold.cyan("AshlrCode") +
      chalk.dim(` v${VERSION}`) +
      chalk.dim(` | ${router.currentProvider.name}:${router.currentProvider.config.model}`) +
      chalk.dim(` | ${cwd}`)
  );
  console.log(chalk.dim('Type your message. Use "/quit" to exit, "/cost" for usage stats.\n'));

  // Check for inline command
  const inlineMessage = args.filter((a) => !a.startsWith("-")).join(" ");

  const history: Message[] = [];

  if (inlineMessage) {
    // Single-shot mode
    await runTurn(inlineMessage, history, {
      systemPrompt,
      router,
      toolRegistry: registry,
      toolContext,
    });
    console.log(chalk.dim(`\n${router.getCostSummary()}`));
    process.exit(0);
  }

  // Interactive REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green("❯ "),
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit" || input === "/q") {
      console.log(chalk.dim(router.getCostSummary()));
      process.exit(0);
    }

    if (input === "/cost") {
      console.log(chalk.dim(router.getCostSummary()));
      rl.prompt();
      return;
    }

    if (input === "/clear") {
      history.length = 0;
      console.log(chalk.dim("Conversation cleared."));
      rl.prompt();
      return;
    }

    await runTurn(input, history, {
      systemPrompt,
      router,
      toolRegistry: registry,
      toolContext,
    });

    console.log(""); // blank line after response
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(chalk.dim(`\n${router.getCostSummary()}`));
    process.exit(0);
  });
}

async function runTurn(
  input: string,
  history: Message[],
  config: {
    systemPrompt: string;
    router: ProviderRouter;
    toolRegistry: ToolRegistry;
    toolContext: ToolContext;
  }
) {
  try {
    const result = await runAgentLoop(input, history, {
      systemPrompt: config.systemPrompt,
      router: config.router,
      toolRegistry: config.toolRegistry,
      toolContext: config.toolContext,
      onText: (text) => process.stdout.write(text),
      onToolStart: (name, input) => {
        console.log(chalk.dim(`\n  ┌ ${chalk.yellow(name)}`));
        const preview = JSON.stringify(input).slice(0, 120);
        console.log(chalk.dim(`  │ ${preview}`));
      },
      onToolEnd: (name, result, isError) => {
        const status = isError ? chalk.red("✗") : chalk.green("✓");
        const preview = result.split("\n")[0]?.slice(0, 100) ?? "";
        console.log(chalk.dim(`  └ ${status} ${preview}\n`));
      },
    });

    // Update history with new messages (skip the ones already in history)
    history.length = 0;
    history.push(...result.messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\nError: ${message}`));
  }
}

async function loadSystemPrompt(): Promise<string> {
  // Load base system prompt
  const promptPath = resolve(import.meta.dir, "../../prompts/system.md");
  let prompt = "";
  if (existsSync(promptPath)) {
    prompt = await readFile(promptPath, "utf-8");
  }

  // Load project-level ASHLR.md if it exists
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

  return prompt;
}

async function askPermission(tool: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      chalk.yellow(`\n  Allow ${tool}? `) +
        chalk.dim(description) +
        chalk.yellow(" [y/N] "),
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase().startsWith("y"));
      }
    );
  });
}

function printHelp() {
  console.log(`
${chalk.bold.cyan("AshlrCode")} ${chalk.dim(`v${VERSION}`)} — Multi-provider AI coding agent

${chalk.bold("USAGE")}
  ac [message]              Run with a single message (non-interactive)
  ac                        Start interactive REPL

${chalk.bold("OPTIONS")}
  -h, --help                Show this help
  -v, --version             Show version

${chalk.bold("COMMANDS")} (in REPL)
  /quit, /exit, /q          Exit
  /cost                     Show token usage and costs
  /clear                    Clear conversation history

${chalk.bold("ENVIRONMENT")}
  XAI_API_KEY               xAI API key (primary provider)
  ANTHROPIC_API_KEY         Anthropic API key (fallback provider)
  AC_MODEL                  Override default model (default: grok-4-1-fast-reasoning)

${chalk.bold("CONFIG")}
  ~/.ashlrcode/settings.json    Provider configuration
  ./ASHLR.md                    Project-level instructions
  ./CLAUDE.md                   Also supported for compatibility
`);
}

// Run
main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
