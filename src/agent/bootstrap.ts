/**
 * Minimal coordinator bootstrap — shared init path for REPL and autopilot CLI.
 *
 * Previously `cli.ts` owned ~100 lines of init that built the router, tool
 * registry, tool context, and system prompt. The `ac-autopilot` CLI couldn't
 * reuse any of that (it only supported `--mock`), so real coordinator
 * dispatch was limited to the REPL's `/autopilot --until-empty`.
 *
 * This module exposes two helpers:
 *   - `registerStandardTools(registry)` — the tool-registration list shared
 *     by every entry point. `cli.ts` uses this directly because it layers
 *     plan-mode / buddy / dream sections on top of the base system prompt.
 *   - `buildMinimalCoordinatorContext(cwd, opts)` — full bootstrap returning
 *     router + registry + tool context + system prompt + cleanup. Intended
 *     for unattended callers like `ac-autopilot --until-empty`.
 *
 * For autopilot we default to `mode: "yolo"` — the drain runs without a TTY
 * and cannot block on per-tool permission prompts.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";

import { ProviderRouter } from "../providers/router.ts";
import { ToolRegistry, setDefaultToolTimeout } from "../tools/registry.ts";
import { loadSettings } from "../config/settings.ts";
import { loadPermissions, checkPermission, setBypassMode, setRules } from "../config/permissions.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import type { ToolContext } from "../tools/types.ts";

// Tools
import { bashTool } from "../tools/bash.ts";
import { fileReadTool } from "../tools/file-read.ts";
import { fileWriteTool } from "../tools/file-write.ts";
import { fileEditTool } from "../tools/file-edit.ts";
import { globTool } from "../tools/glob.ts";
import { grepTool } from "../tools/grep.ts";
import { askUserTool } from "../tools/ask-user.ts";
import { webFetchTool } from "../tools/web-fetch.ts";
import { enterPlanTool, exitPlanTool, planWriteTool } from "../planning/plan-tools.ts";
import { agentTool, initAgentTool } from "../tools/agent.ts";
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from "../tools/tasks.ts";
import { lsTool } from "../tools/ls.ts";
import { configTool } from "../tools/config.ts";
import { enterWorktreeTool, exitWorktreeTool } from "../tools/worktree.ts";
import { webSearchTool } from "../tools/web-search.ts";
import { toolSearchTool, initToolSearch } from "../tools/tool-search.ts";
import { powershellTool } from "../tools/powershell.ts";
import { memorySaveTool, memoryListTool, memoryDeleteTool } from "../tools/memory.ts";
import { notebookEditTool } from "../tools/notebook-edit.ts";
import { sendMessageTool, checkMessagesTool } from "../tools/send-message.ts";
import { sleepTool } from "../tools/sleep.ts";
import { todoWriteTool } from "../tools/todo-write.ts";
import { diffTool } from "../tools/diff.ts";
import { lspTool, shutdownLSP } from "../tools/lsp.ts";
import { shutdownBrowser, webBrowserTool } from "../tools/web-browser.ts";
import { verifyTool, initVerifyTool } from "../tools/verify.ts";
import { coordinateTool, initCoordinateTool } from "../tools/coordinate.ts";
import { teamCreateTool, teamDeleteTool, teamListTool, teamDispatchTool, initTeamTools } from "../tools/team.ts";
import { workflowTool, initWorkflowTool } from "../tools/workflow.ts";
import { listPeersTool } from "../tools/peers.ts";
import { feature } from "../config/features.ts";

export interface BuildMinimalCoordinatorContextOpts {
  provider?: string;
  model?: string;
  /** "yolo" skips per-tool prompts — required for unattended drains. Default "yolo". */
  mode?: "yolo" | "safe";
  /** Override the assembled system prompt entirely (tests + specialty harnesses). */
  systemPromptOverride?: string;
}

export interface MinimalCoordinatorContext {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  /** Dispose of any open handles (LSP, browser, etc). Idempotent. */
  cleanup: () => Promise<void>;
}

/**
 * Register the standard tool set on an existing registry. Extracted so
 * `cli.ts` (which builds its own system prompt with buddy/plan-mode layers)
 * can share the list instead of duplicating ~40 register() calls.
 */
export function registerStandardTools(registry: ToolRegistry): void {
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
  registry.register(checkMessagesTool);
  registry.register(sleepTool);
  registry.register(todoWriteTool);
  registry.register(diffTool);
  registry.register(lspTool);
  registry.register(teamCreateTool);
  registry.register(teamDeleteTool);
  registry.register(teamListTool);
  registry.register(teamDispatchTool);
  registry.register(workflowTool);
  registry.register(listPeersTool);
  registry.register(verifyTool);
  registry.register(coordinateTool);
  if (process.platform === "win32") registry.register(powershellTool);
  if (feature("BROWSER_TOOL")) registry.register(webBrowserTool);
  initToolSearch(registry);
}

/**
 * Build a coordinator-ready context from `cwd`, reusing the same init path
 * as the REPL. Intended for unattended / non-interactive callers such as
 * `ac-autopilot --until-empty`.
 *
 * Defaults to `mode: "yolo"` — the drain runs without a TTY, so permission
 * prompts would block indefinitely.
 */
export async function buildMinimalCoordinatorContext(
  cwd: string,
  opts: BuildMinimalCoordinatorContextOpts = {},
): Promise<MinimalCoordinatorContext> {
  const mode = opts.mode ?? "yolo";

  const settings = await loadSettings();
  await loadPermissions();
  if (settings.permissionRules) setRules(settings.permissionRules);

  if (mode === "yolo") setBypassMode(true);

  if (settings.toolTimeoutMs) setDefaultToolTimeout(settings.toolTimeoutMs);

  // Provider router — reuse settings unless caller overrides
  const providerSettings = { ...settings.providers };
  if (opts.provider) {
    providerSettings.primary = { ...providerSettings.primary, provider: opts.provider as any };
  }
  if (opts.model) {
    providerSettings.primary = { ...providerSettings.primary, model: opts.model };
  }
  const router = new ProviderRouter(providerSettings);

  const registry = new ToolRegistry();
  registerStandardTools(registry);

  if (settings.toolHooks) {
    const { loadHooksFromSettings } = await import("../config/hooks.ts");
    registry.setHooks(loadHooksFromSettings(settings.toolHooks));
  } else if (settings.hooks) {
    registry.setHooks(settings.hooks);
  }

  const toolContext: ToolContext = {
    cwd,
    requestPermission: async (tool) => {
      if (mode === "yolo") return true;
      const perm = checkPermission(tool);
      return perm === "allow";
    },
  };

  let systemPrompt: string;
  if (opts.systemPromptOverride) {
    systemPrompt = opts.systemPromptOverride;
  } else {
    const rawSystemPrompt = await loadBaseSystemPrompt(cwd);
    const { SystemPromptBuilder } = await import("./system-prompt.ts");
    const builder = new SystemPromptBuilder();
    builder.addCoreInstructions(rawSystemPrompt);
    builder.addPermissionContext(mode === "yolo" ? "yolo" : "safe");
    try {
      await builder.addKnowledgeFiles(cwd);
      await builder.addMemoryFiles();
      await builder.addGitContext(cwd);
    } catch {
      /* best-effort */
    }
    systemPrompt = builder.build(50_000).text;
  }

  // Wire agent/team/verify/coordinate/workflow inits
  initAgentTool(router, registry, systemPrompt);
  initTeamTools(router, registry, systemPrompt);
  initVerifyTool(router, registry, systemPrompt);
  initCoordinateTool(router, registry, systemPrompt);
  initWorkflowTool(router, registry, systemPrompt);

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([shutdownLSP(), shutdownBrowser()]);
  };

  return { router, toolRegistry: registry, toolContext, systemPrompt, cleanup };
}

async function loadBaseSystemPrompt(cwd: string): Promise<string> {
  const promptPath = resolve(import.meta.dir, "../../prompts/system.md");
  let prompt = "";
  if (existsSync(promptPath)) {
    prompt = await readFile(promptPath, "utf-8");
  }
  const projectConfig = await loadProjectConfig(cwd);
  if (projectConfig.instructions) {
    prompt += `\n\n# Project Instructions\n\n${projectConfig.instructions}`;
  }
  prompt += `\n\n# Environment
- Working directory: ${cwd}
- Platform: ${process.platform}
- Date: ${new Date().toISOString().split("T")[0]}
`;
  return prompt;
}
