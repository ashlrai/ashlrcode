/**
 * Coordinate tool — break complex tasks into subtasks and dispatch to sub-agents.
 * Allows the LLM itself to invoke multi-agent coordination.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  coordinate,
  formatCoordinatorReport,
} from "../agent/coordinator.ts";

let _router: ProviderRouter | null = null;
let _registry: ToolRegistry | null = null;
let _systemPrompt: string = "";

export function initCoordinateTool(
  router: ProviderRouter,
  registry: ToolRegistry,
  systemPrompt: string,
): void {
  _router = router;
  _registry = registry;
  _systemPrompt = systemPrompt;
}

export const coordinateTool: Tool = {
  name: "Coordinate",

  prompt() {
    return `Break a complex task into independent subtasks and dispatch them to multiple sub-agents working in parallel. Use when:
- A task has 3+ independent parts that can be parallelized
- You need different specialists (explorer, implementer, test-writer, reviewer)
- The task would benefit from divide-and-conquer
The coordinator plans subtasks, dispatches in waves of 3, and optionally verifies results.`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The complex task to break down and coordinate",
        },
        teamId: {
          type: "string",
          description: "Optional team ID to use existing team members",
        },
        autoVerify: {
          type: "boolean",
          description: "Run verification after all agents complete (default: true)",
        },
      },
      required: ["goal"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return false; },
  isConcurrencySafe() { return false; },

  validateInput(input) {
    if (!input.goal || typeof input.goal !== "string") return "goal is required";
    if (!_router || !_registry) return "Coordinate tool not initialized";
    return null;
  },

  async call(input, context) {
    if (!_router || !_registry) return "Coordinate tool not initialized";

    const goal = input.goal as string;
    const teamId = input.teamId as string | undefined;
    const autoVerify = (input.autoVerify as boolean) ?? true;

    const result = await coordinate(goal, {
      router: _router,
      toolRegistry: _registry,
      toolContext: context,
      systemPrompt: _systemPrompt,
      teamId,
      autoVerify,
    });

    return formatCoordinatorReport(result);
  },
};
