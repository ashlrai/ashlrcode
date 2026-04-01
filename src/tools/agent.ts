/**
 * AgentTool — spawn sub-agents with isolated message context.
 *
 * Allows the model to delegate exploration, research, and analysis
 * to child agents that run with fresh context and report back.
 */

import chalk from "chalk";
import type { Tool, ToolContext } from "./types.ts";
import { runSubAgent, type SubAgentConfig } from "../agent/sub-agent.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";

// These get injected at registration time
let _router: ProviderRouter | null = null;
let _registry: ToolRegistry | null = null;
let _systemPrompt: string = "";

export function initAgentTool(
  router: ProviderRouter,
  registry: ToolRegistry,
  systemPrompt: string
) {
  _router = router;
  _registry = registry;
  _systemPrompt = systemPrompt;
}

export const agentTool: Tool = {
  name: "Agent",

  prompt() {
    return `Launch a sub-agent to handle a task autonomously. The sub-agent has its own fresh conversation context and access to read-only tools (Read, Glob, Grep, WebFetch).

Use this for:
- Exploring parts of the codebase in parallel
- Researching a specific question
- Analyzing files or patterns

The sub-agent's findings are returned as text. Provide a clear, specific prompt describing what to investigate.`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short description of what the agent will do (3-5 words)",
        },
        prompt: {
          type: "string",
          description:
            "Detailed task description for the sub-agent. Include file paths, search terms, and specific questions.",
        },
        readOnly: {
          type: "boolean",
          description: "Only allow read-only tools (default: true)",
        },
      },
      required: ["description", "prompt"],
    };
  },

  isReadOnly() {
    return true; // The agent tool itself is read-only; sub-agent tools are filtered
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return true;
  },

  validateInput(input) {
    if (!input.prompt || typeof input.prompt !== "string") {
      return "prompt is required";
    }
    if (!input.description || typeof input.description !== "string") {
      return "description is required";
    }
    if (!_router || !_registry) {
      return "AgentTool not initialized. Call initAgentTool() first.";
    }
    return null;
  },

  async call(input, context) {
    const description = input.description as string;
    const prompt = input.prompt as string;
    const readOnly = (input.readOnly as boolean) ?? true;

    console.log(chalk.dim(`  ◈ Spawning agent: ${description}`));

    const result = await runSubAgent({
      name: description,
      prompt,
      systemPrompt: _systemPrompt + "\n\nYou are a sub-agent. Be thorough but concise. Report your findings clearly with file paths and line numbers.",
      router: _router!,
      toolRegistry: _registry!,
      toolContext: context,
      readOnly,
      maxIterations: 15,
      onToolStart: (name) => {
        console.log(chalk.dim(`    ↳ ${name}`));
      },
      onToolEnd: (_name, _result, isError) => {
        if (isError) console.log(chalk.dim(`    ↳ ${chalk.red("error")}`));
      },
    });

    const toolSummary = result.toolCalls.length > 0
      ? `\n\nTools used: ${result.toolCalls.map((t) => t.name).join(", ")}`
      : "";

    console.log(chalk.dim(`  ◈ Agent "${description}" completed`));

    return `## Agent: ${description}\n\n${result.text}${toolSummary}`;
  },
};
