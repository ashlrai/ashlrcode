/**
 * Task management tools — let the model track its own work.
 *
 * Tasks are persisted to disk at ~/.ashlrcode/tasks/<session-id>.json.
 * Pattern from Claude Code's TaskCreate/TaskUpdate/TaskList.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";
import type { Tool, ToolContext } from "./types.ts";

interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
  owner?: string;
  blocks?: number[];
  blockedBy?: number[];
  completedAt?: string;
}

let tasks: Task[] = [];
let nextId = 1;
let sessionId: string | null = null;

function getTasksDir(): string {
  return join(getConfigDir(), "tasks");
}

function getTasksPath(): string | null {
  if (!sessionId) return null;
  return join(getTasksDir(), `${sessionId}.json`);
}

async function saveTasks(): Promise<void> {
  const path = getTasksPath();
  if (!path) return;
  await mkdir(getTasksDir(), { recursive: true });
  await writeFile(path, JSON.stringify({ tasks, nextId }, null, 2), "utf-8");
}

export async function initTasks(sid: string): Promise<void> {
  sessionId = sid;
  const path = getTasksPath();
  if (path && existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as { tasks: Task[]; nextId: number };
      tasks = data.tasks;
      nextId = data.nextId;
    } catch {
      tasks = [];
      nextId = 1;
    }
  }
}

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
        blockedBy: {
          type: "array",
          items: { type: "number" },
          description: "IDs of tasks that must complete before this one",
        },
        owner: {
          type: "string",
          description: "Agent name that owns this task",
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
    const blockedByIds = (input.blockedBy as number[] | undefined) ?? [];
    const owner = input.owner as string | undefined;

    const task: Task = {
      id: nextId++,
      subject: input.subject as string,
      description: (input.description as string) ?? "",
      status: "pending",
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      ...(blockedByIds.length > 0 ? { blockedBy: blockedByIds } : {}),
    };

    // Wire up the reverse side: each blocker now blocks this task
    for (const bid of blockedByIds) {
      const blocker = tasks.find((t) => t.id === bid);
      if (blocker) {
        blocker.blocks = blocker.blocks ?? [];
        if (!blocker.blocks.includes(task.id)) {
          blocker.blocks.push(task.id);
        }
      }
    }

    tasks.push(task);
    await saveTasks();
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
        owner: {
          type: "string",
          description: "Agent name that owns this task",
        },
        addBlocks: {
          type: "array",
          items: { type: "number" },
          description: "Task IDs that this task now blocks",
        },
        addBlockedBy: {
          type: "array",
          items: { type: "number" },
          description: "Task IDs that now block this task",
        },
      },
      required: ["taskId"],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    if (!input.taskId) return "taskId is required";
    return null;
  },

  async call(input, _context) {
    const id = input.taskId as number;
    const task = tasks.find((t) => t.id === id);
    if (!task) return `Task #${id} not found`;

    // Update status
    if (input.status) {
      const status = input.status as Task["status"];
      task.status = status;
      if (status === "completed") {
        task.completedAt = new Date().toISOString();
      }
    }

    // Update owner
    if (input.owner) {
      task.owner = input.owner as string;
    }

    // Add blocks: this task blocks the given IDs
    const addBlocks = (input.addBlocks as number[] | undefined) ?? [];
    for (const targetId of addBlocks) {
      task.blocks = task.blocks ?? [];
      if (!task.blocks.includes(targetId)) {
        task.blocks.push(targetId);
      }
      // Wire reverse: target is now blockedBy this task
      const target = tasks.find((t) => t.id === targetId);
      if (target) {
        target.blockedBy = target.blockedBy ?? [];
        if (!target.blockedBy.includes(id)) {
          target.blockedBy.push(id);
        }
      }
    }

    // Add blockedBy: this task is now blocked by the given IDs
    const addBlockedBy = (input.addBlockedBy as number[] | undefined) ?? [];
    for (const blockerId of addBlockedBy) {
      task.blockedBy = task.blockedBy ?? [];
      if (!task.blockedBy.includes(blockerId)) {
        task.blockedBy.push(blockerId);
      }
      // Wire reverse: blocker now blocks this task
      const blocker = tasks.find((t) => t.id === blockerId);
      if (blocker) {
        blocker.blocks = blocker.blocks ?? [];
        if (!blocker.blocks.includes(id)) {
          blocker.blocks.push(id);
        }
      }
    }

    await saveTasks();
    return `Task #${id} updated`;
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

      // Check if blocked by any incomplete task
      const isBlocked =
        t.blockedBy?.some((bid) => {
          const blocker = tasks.find((b) => b.id === bid);
          return blocker && blocker.status !== "completed";
        }) ?? false;

      let line = `${icon} #${t.id} [${t.status}]${isBlocked ? " (blocked)" : ""} ${t.subject}`;

      if (t.owner) line += ` @${t.owner}`;

      const deps: string[] = [];
      if (t.blocks?.length) deps.push(`→ blocks ${t.blocks.map((id) => `#${id}`).join(", ")}`);
      if (t.blockedBy?.length) deps.push(`← blocked by ${t.blockedBy.map((id) => `#${id}`).join(", ")}`);
      if (deps.length) line += `  ${deps.join("  ")}`;

      return line;
    });

    const pending = tasks.filter((t) => t.status === "pending").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const completed = tasks.filter((t) => t.status === "completed").length;

    return `${lines.join("\n")}\n\n${completed}/${tasks.length} completed, ${inProgress} in progress, ${pending} pending`;
  },
};

export const taskGetTool: Tool = {
  name: "TaskGet",

  prompt() {
    return "Get full details of a specific task by ID.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        taskId: {
          type: "number",
          description: "ID of the task to retrieve",
        },
      },
      required: ["taskId"],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    return input.taskId ? null : "taskId required";
  },

  async call(input, _context) {
    const task = tasks.find((t) => t.id === (input.taskId as number));
    if (!task) return `Task #${input.taskId} not found`;
    return JSON.stringify(task, null, 2);
  },
};
