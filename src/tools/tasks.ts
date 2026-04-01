/**
 * Task management tools — let the model track its own work.
 *
 * Tasks are stored in memory during a session.
 * Pattern from Claude Code's TaskCreate/TaskUpdate/TaskList.
 */

import type { Tool, ToolContext } from "./types.ts";

interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
}

let tasks: Task[] = [];
let nextId = 1;

export function resetTasks() {
  tasks = [];
  nextId = 1;
}

export const taskCreateTool: Tool = {
  name: "TaskCreate",

  prompt() {
    return "Create a task to track your work. Use for multi-step tasks to show progress. Tasks have a subject, description, and status.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "Brief title for the task",
        },
        description: {
          type: "string",
          description: "What needs to be done",
        },
      },
      required: ["subject", "description"],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    if (!input.subject) return "subject is required";
    return null;
  },

  async call(input, _context) {
    const task: Task = {
      id: nextId++,
      subject: input.subject as string,
      description: (input.description as string) ?? "",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    return `Task #${task.id} created: ${task.subject}`;
  },
};

export const taskUpdateTool: Tool = {
  name: "TaskUpdate",

  prompt() {
    return "Update a task's status. Use to mark tasks as in_progress when starting or completed when done.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        taskId: {
          type: "number",
          description: "ID of the task to update",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "New status",
        },
      },
      required: ["taskId", "status"],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    if (!input.taskId) return "taskId is required";
    if (!input.status) return "status is required";
    return null;
  },

  async call(input, _context) {
    const id = input.taskId as number;
    const status = input.status as Task["status"];
    const task = tasks.find((t) => t.id === id);
    if (!task) return `Task #${id} not found`;
    task.status = status;
    return `Task #${id} updated to ${status}`;
  },
};

export const taskListTool: Tool = {
  name: "TaskList",

  prompt() {
    return "List all tasks and their current status. Use to check progress and find your next task.";
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

  async call(_input, _context) {
    if (tasks.length === 0) return "No tasks.";

    const lines = tasks.map((t) => {
      const icon =
        t.status === "completed"
          ? "✓"
          : t.status === "in_progress"
            ? "●"
            : "○";
      return `${icon} #${t.id} [${t.status}] ${t.subject}`;
    });

    const pending = tasks.filter((t) => t.status === "pending").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const completed = tasks.filter((t) => t.status === "completed").length;

    return `${lines.join("\n")}\n\n${completed}/${tasks.length} completed, ${inProgress} in progress, ${pending} pending`;
  },
};
