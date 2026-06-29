/**
 * Bootstrap — shared tool registration and minimal coordinator context.
 *
 * Exports:
 *   registerStandardTools(registry)  — registers the standard tool set used by
 *                                      the REPL and the autopilot loop. SnipTool
 *                                      is REPL-only (mutates live history) and is
 *                                      NOT registered here.
 *   buildMinimalCoordinatorContext() — bootstraps router + tools + system prompt
 *                                      for headless / autonomous execution paths
 *                                      (ac --autonomous, sub-agents, etc.)
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { ToolRegistry } from "../tools/registry.ts";
import { ProviderRouter } from "../providers/router.ts";
import { loadSettings } from "../config/settings.ts";
import { loadPermissions, setBypassMode, setAutoAcceptEdits } from "../config/permissions.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import type { ToolContext } from "../tools/types.ts";

// ── Standard tools ────────────────────────────────────────────────────────────

import { bashTool } from "../tools/bash.ts";
import { fileReadTool } from "../tools/file-read.ts";
import { fileWriteTool } from "../tools/file-write.ts";
import { fileEditTool } from "../tools/file-edit.ts";
import { globTool } from "../tools/glob.ts";
import { grepTool } from "../tools/grep.ts";
import { askUserTool } from "../tools/ask-user.ts";
import { webFetchTool } from "../tools/web-fetch.ts";
import { enterPlanTool, exitPlanTool, planWriteTool } from "../planning/plan-tools.ts";
import { agentTool } from "../tools/agent.ts";
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from "../tools/tasks.ts";
import { lsTool } from "../tools/ls.ts";
import { configTool } from "../tools/config.ts";
import { enterWorktreeTool, exitWorktreeTool } from "../tools/worktree.ts";
import { webSearchTool } from "../tools/web-search.ts";
import { toolSearchTool } from "../tools/tool-search.ts";
import { powershellTool } from "../tools/powershell.ts";
import { memorySaveTool, memoryListTool, memoryDeleteTool } from "../tools/memory.ts";
import { notebookEditTool } from "../tools/notebook-edit.ts";
import { sendMessageTool, checkMessagesTool } from "../tools/send-message.ts";
import { sleepTool } from "../tools/sleep.ts";
import { todoWriteTool } from "../tools/todo-write.ts";
import { diffTool } from "../tools/diff.ts";
import { lspTool } from "../tools/lsp.ts";
import { bulkEditTool } from "../tools/bulk-edit.ts";
import { webBrowserTool } from "../tools/web-browser.ts";
import { verifyTool } from "../tools/verify.ts";
import { coordinateTool } from "../tools/coordinate.ts";
import { teamCreateTool, teamDeleteTool, teamListTool, teamDispatchTool } from "../tools/team.ts";
import { workflowTool } from "../tools/workflow.ts";
import { listPeersTool } from "../tools/peers.ts";

/**
 * Register the standard tool set into a ToolRegistry.
 * This is the canonical list used by the REPL and the autopilot loop.
 * SnipTool is intentionally excluded — it mutates the live REPL history buffer
 * and must be registered by the caller (cli.ts) after initSnipTool() is wired.
 */
export function registerStandardTools(registry: ToolRegistry): void {
  // Core filesystem + shell
  registry.register(bashTool);
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(lsTool);
  registry.register(diffTool);

  // Web
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(webBrowserTool);

  // Planning
  registry.register(enterPlanTool);
  registry.register(exitPlanTool);
  registry.register(planWriteTool);

  // Agent orchestration
  registry.register(agentTool);
  registry.register(coordinateTool);
  registry.register(teamCreateTool);
  registry.register(teamDeleteTool);
  registry.register(teamListTool);
  registry.register(teamDispatchTool);
  registry.register(workflowTool);
  registry.register(listPeersTool);

  // Tasks + memory + config
  registry.register(taskCreateTool);
  registry.register(taskUpdateTool);
  registry.register(taskListTool);
  registry.register(taskGetTool);
  registry.register(memorySaveTool);
  registry.register(memoryListTool);
  registry.register(memoryDeleteTool);
  registry.register(configTool);
  registry.register(todoWriteTool);

  // Editing helpers
  registry.register(notebookEditTool);
  registry.register(lspTool);
  registry.register(bulkEditTool);

  // Worktree
  registry.register(enterWorktreeTool);
  registry.register(exitWorktreeTool);

  // Interaction
  registry.register(askUserTool);
  registry.register(sendMessageTool);
  registry.register(checkMessagesTool);
  registry.register(sleepTool);
  registry.register(toolSearchTool);
  registry.register(powershellTool);

  // Verification
  registry.register(verifyTool);
}

// ── MinimalCoordinatorContext ─────────────────────────────────────────────────

export interface MinimalCoordinatorContext {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  cleanup(): Promise<void>;
}

export interface BuildContextOptions {
  /** Permission mode. "yolo" bypasses all permission prompts. Default: "normal" */
  mode?: "normal" | "yolo" | "accept-edits";
}

/**
 * Bootstrap a minimal coordinator context suitable for headless execution
 * (autonomous mode, sub-agents, etc.).
 *
 * Loads settings + permissions, builds a ToolRegistry with the standard tools,
 * constructs the provider router, and assembles a system prompt.
 */
export async function buildMinimalCoordinatorContext(
  cwd: string,
  options: BuildContextOptions = {},
): Promise<MinimalCoordinatorContext> {
  const settings = await loadSettings();
  await loadPermissions();

  if (options.mode === "yolo") {
    setBypassMode(true);
  } else if (options.mode === "accept-edits") {
    setAutoAcceptEdits(true);
  }

  const router = new ProviderRouter(settings.providers);

  const toolRegistry = new ToolRegistry();
  registerStandardTools(toolRegistry);

  const toolContext: ToolContext = {
    cwd,
    requestPermission: async (_tool: string, _description: string): Promise<boolean> => {
      // In headless mode, bypass permission prompts (controlled by setBypassMode above)
      return true;
    },
  };

  // Load core system prompt instructions (mirrors cli.ts loadSystemPrompt())
  const promptPath = resolve(import.meta.dir, "../../prompts/system.md");
  let coreInstructions = existsSync(promptPath) ? await readFile(promptPath, "utf-8") : "";
  const projectConfig = await loadProjectConfig(cwd);
  if (projectConfig.instructions) {
    coreInstructions += `\n\n# Project Instructions\n\n${projectConfig.instructions}`;
  }
  coreInstructions += `\n\n# Environment\n- Working directory: ${cwd}\n- Platform: ${process.platform}\n- Date: ${new Date().toISOString().split("T")[0]}\n`;

  const assembled = await buildSystemPrompt({
    coreInstructions,
    toolRegistry,
    mode: options.mode ?? "normal",
    projectDir: cwd,
    modelName: settings.providers.primary?.model,
  });

  return {
    router,
    toolRegistry,
    toolContext,
    systemPrompt: assembled.text,
    async cleanup() {
      // Nothing to tear down for now; placeholder for future resource cleanup
      // (e.g. LSP shutdown, browser close) if callers need it.
    },
  };
}
