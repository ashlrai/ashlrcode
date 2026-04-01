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

export interface SubAgentConfig {
  name: string;
  prompt: string;
  systemPrompt: string;
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  /** Only allow read-only tools */
  readOnly?: boolean;
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
}

/**
 * Run a sub-agent with its own fresh message context.
 */
export async function runSubAgent(config: SubAgentConfig): Promise<SubAgentResult> {
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
}

/**
 * Run multiple sub-agents in parallel.
 */
export async function runSubAgentsParallel(
  configs: SubAgentConfig[]
): Promise<SubAgentResult[]> {
  return Promise.all(configs.map(runSubAgent));
}
