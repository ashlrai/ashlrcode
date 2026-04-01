/**
 * Plan mode tools — EnterPlan, ExitPlan, PlanWrite.
 */

import type { Tool, ToolContext } from "../tools/types.ts";
import {
  enterPlanMode,
  exitPlanMode,
  isPlanMode,
  getPlanFilePath,
  writePlan,
  readPlan,
} from "./plan-mode.ts";

export const enterPlanTool: Tool = {
  name: "EnterPlan",

  prompt() {
    return "Enter plan mode. In plan mode, only read-only tools are available. Use this when you need to explore a codebase and design an approach before making changes. Creates a plan file for writing your plan.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {},
      required: [],
    };
  },

  isReadOnly() {
    return true;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput() {
    if (isPlanMode()) return "Already in plan mode";
    return null;
  },

  async call(_input, _context) {
    const planFile = await enterPlanMode();
    return `Plan mode activated. Write your plan to: ${planFile}\n\nAvailable tools: Read, Glob, Grep, WebFetch, AskUser, PlanWrite, ExitPlan\nBlocked tools: Write, Edit, Bash (anything that modifies files)`;
  },
};

export const exitPlanTool: Tool = {
  name: "ExitPlan",

  prompt() {
    return "Exit plan mode. Call this when your plan is complete and ready for user approval. The plan file will be presented to the user for review.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {},
      required: [],
    };
  },

  isReadOnly() {
    return true;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput() {
    if (!isPlanMode()) return "Not in plan mode";
    return null;
  },

  async call(_input, _context) {
    const plan = await readPlan();
    const planFile = getPlanFilePath();
    exitPlanMode();

    if (!plan) {
      return "Plan mode exited. Warning: No plan was written to the plan file.";
    }

    return `Plan mode exited. Plan saved to: ${planFile}\n\n--- Plan Preview ---\n${plan.slice(0, 2000)}${plan.length > 2000 ? "\n\n[... truncated ...]" : ""}`;
  },
};

export const planWriteTool: Tool = {
  name: "PlanWrite",

  prompt() {
    return "Write content to the plan file. Use this in plan mode to record your implementation plan. Can be called multiple times to build the plan incrementally.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The plan content (markdown format)",
        },
      },
      required: ["content"],
    };
  },

  isReadOnly() {
    return true; // Writing to the plan file is allowed in plan mode
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    if (!isPlanMode()) return "Not in plan mode. Call EnterPlan first.";
    if (!input.content || typeof input.content !== "string") {
      return "content is required";
    }
    return null;
  },

  async call(input, _context) {
    const content = input.content as string;
    await writePlan(content);
    const lines = content.split("\n").length;
    return `Plan updated (${lines} lines). Call ExitPlan when ready for user review.`;
  },
};
