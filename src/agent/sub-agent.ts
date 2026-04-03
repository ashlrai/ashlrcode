/**
 * Sub-agent — spawn child agents with isolated message context.
 *
 * Pattern from Claude Code's AgentTool:
 * - Fresh messages[] per child agent
 * - Shared tool registry and provider router
 * - Results returned to parent
 */

import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { Message } from "../providers/types.ts";
import { runAgentLoop } from "./loop.ts";
import { createWorktree, removeWorktree } from "./worktree-manager.ts";
import { runWithAgentContext, createChildContext, getAgentContext } from "./async-context.ts";

export interface SubAgentConfig {
  name: string;
  prompt: string;
  systemPrompt: string;
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  /** Only allow read-only tools */
  readOnly?: boolean;
  /** Execution mode: in-process (default) or worktree-isolated */
  mode?: "in_process" | "worktree";
  /** Max iterations for this sub-agent */
  maxIterations?: number;
  /** Callback for streaming text */
  onText?: (text: string) => void;
  /** Callback for tool events */
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
}

export interface SubAgentResult {
  name: string;
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  messages: Message[];
  worktree?: { path: string; branch: string };
}

/**
 * Run a sub-agent in an isolated git worktree.
 * The worktree is created before the agent runs and preserved after
 * so the parent can inspect or merge the branch. On error, the
 * worktree is cleaned up automatically.
 */
async function runWorktreeSubAgent(config: SubAgentConfig): Promise<SubAgentResult> {
  const wt = await createWorktree(config.name);
  const worktreeContext: ToolContext = { ...config.toolContext, cwd: wt.path };

  const parentCtx = getAgentContext();
  const childCtx = createChildContext(parentCtx, config.name, wt.path, config.readOnly ?? true);

  return runWithAgentContext(childCtx, async () => {
    try {
      const result = await runAgentLoop(config.prompt, [], {
        systemPrompt: config.systemPrompt,
        router: config.router,
        toolRegistry: config.toolRegistry,
        toolContext: worktreeContext,
        readOnly: config.readOnly,
        maxIterations: config.maxIterations ?? 15,
        onText: config.onText,
        onToolStart: config.onToolStart,
        onToolEnd: config.onToolEnd,
      });

      return {
        name: config.name,
        text: result.finalText,
        toolCalls: result.toolCalls,
        messages: result.messages,
        worktree: { path: wt.path, branch: wt.branch },
      };
    } catch (err) {
      await removeWorktree(wt.path).catch(() => {});
      throw err;
    }
  });
}

/**
 * Run a sub-agent with its own fresh message context.
 */
export async function runSubAgent(config: SubAgentConfig): Promise<SubAgentResult> {
  if (config.mode === "worktree") return runWorktreeSubAgent(config);

  const parentCtx = getAgentContext();
  const childCtx = createChildContext(parentCtx, config.name, config.toolContext.cwd, config.readOnly ?? true);

  return runWithAgentContext(childCtx, async () => {
    const result = await runAgentLoop(config.prompt, [], {
      systemPrompt: config.systemPrompt,
      router: config.router,
      toolRegistry: config.toolRegistry,
      toolContext: config.toolContext,
      readOnly: config.readOnly,
      maxIterations: config.maxIterations ?? 15,
      onText: config.onText,
      onToolStart: config.onToolStart,
      onToolEnd: config.onToolEnd,
    });

    return {
      name: config.name,
      text: result.finalText,
      toolCalls: result.toolCalls,
      messages: result.messages,
    };
  });
}

/**
 * Run multiple sub-agents in parallel.
 */
export async function runSubAgentsParallel(
  configs: SubAgentConfig[]
): Promise<SubAgentResult[]> {
  return Promise.all(configs.map(runSubAgent));
}
