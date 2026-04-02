/**
 * Memory management tools — save, list, and delete project memories.
 *
 * Memories persist across sessions in ~/.ashlrcode/memory/<project-hash>/
 */

import type { Tool, ToolContext } from "./types.ts";
import {
  loadMemories,
  saveMemory,
  deleteMemory,
  type MemoryEntry,
} from "../persistence/memory.ts";

export const memorySaveTool: Tool = {
  name: "MemorySave",

  prompt() {
    return `Save a memory for this project. Memories persist across sessions and are loaded into context automatically.

Memory types:
- user: Information about the user (role, preferences, knowledge)
- feedback: Guidance on how to approach work (corrections, confirmations)
- project: Ongoing work context (goals, status, decisions)
- reference: Pointers to external resources (URLs, tools, docs)

Use when the user asks you to "remember" something, or when you learn important context that should persist.`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short name for the memory",
        },
        description: {
          type: "string",
          description: "One-line description (used to decide relevance in future)",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Memory type",
        },
        content: {
          type: "string",
          description: "The memory content (markdown)",
        },
      },
      required: ["name", "type", "content"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return false; },
  isConcurrencySafe() { return false; },

  validateInput(input) {
    if (!input.name) return "name is required";
    if (!input.type) return "type is required";
    if (!input.content) return "content is required";
    return null;
  },

  async call(input, context) {
    const filePath = await saveMemory(context.cwd, {
      name: input.name as string,
      description: (input.description as string) ?? "",
      type: input.type as MemoryEntry["type"],
      content: input.content as string,
    });
    return `Memory saved: ${input.name} → ${filePath}`;
  },
};

export const memoryListTool: Tool = {
  name: "MemoryList",

  prompt() {
    return "List all memories saved for this project. Shows name, type, and description.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {},
      required: [],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput() { return null; },

  async call(_input, context) {
    const memories = await loadMemories(context.cwd);
    if (memories.length === 0) {
      return "No memories saved for this project.";
    }

    const lines = memories.map((m) =>
      `- **${m.name}** (${m.type}): ${m.description || m.content.slice(0, 80)}`
    );
    return `${memories.length} memories:\n${lines.join("\n")}`;
  },
};

export const memoryDeleteTool: Tool = {
  name: "MemoryDelete",

  prompt() {
    return "Delete a memory by name.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the memory to delete",
        },
      },
      required: ["name"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return true; },
  isConcurrencySafe() { return false; },

  validateInput(input) {
    if (!input.name) return "name is required";
    return null;
  },

  async call(input, context) {
    const deleted = await deleteMemory(context.cwd, input.name as string);
    if (deleted) {
      return `Memory deleted: ${input.name}`;
    }
    return `Memory not found: ${input.name}`;
  },
};
