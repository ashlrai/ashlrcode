/**
 * TodoWrite — write a structured todo/plan list to a file.
 * Equivalent to Claude Code's TodoWriteTool.
 */

import { writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";

export const todoWriteTool: Tool = {
  name: "TodoWrite",

  prompt() {
    return "Write a structured todo list or plan to a file. Use this to create implementation checklists, track work items, or document a plan. The file is written in markdown format with checkboxes.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to write the todo file (e.g., PLAN.md, TODO.md)",
        },
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "Task description" },
              completed: { type: "boolean", description: "Whether the task is done" },
              subtasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    task: { type: "string" },
                    completed: { type: "boolean" },
                  },
                },
              },
            },
            required: ["task"],
          },
          description: "List of todo items",
        },
      },
      required: ["file_path", "todos"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return false; },
  isConcurrencySafe() { return false; },

  validateInput(input) {
    if (!input.file_path) return "file_path is required";
    if (!Array.isArray(input.todos) || input.todos.length === 0) {
      return "todos must be a non-empty array";
    }
    return null;
  },

  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path as string);
    const todos = input.todos as Array<{
      task: string;
      completed?: boolean;
      subtasks?: Array<{ task: string; completed?: boolean }>;
    }>;

    const lines: string[] = ["# Plan\n"];

    for (const todo of todos) {
      const check = todo.completed ? "x" : " ";
      lines.push(`- [${check}] ${todo.task}`);

      if (todo.subtasks) {
        for (const sub of todo.subtasks) {
          const subCheck = sub.completed ? "x" : " ";
          lines.push(`  - [${subCheck}] ${sub.task}`);
        }
      }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const total = todos.length;
    const completed = todos.filter((t) => t.completed).length;
    return `Wrote ${total} todos (${completed} completed) to ${filePath}`;
  },
};
