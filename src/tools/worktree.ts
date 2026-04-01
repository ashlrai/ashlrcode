/**
 * Worktree tools — git worktree isolation for safe parallel edits.
 */

import { randomUUID } from "crypto";
import type { Tool, ToolContext } from "./types.ts";

export const enterWorktreeTool: Tool = {
  name: "EnterWorktree",

  prompt() {
    return "Create an isolated git worktree for safe parallel editing. Returns the worktree path. Use with Agent tool for isolated sub-agent work.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name for the worktree branch (auto-generated if omitted)",
        },
      },
      required: [],
    };
  },

  isReadOnly() {
    return false;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput() {
    return null;
  },

  async call(input, context) {
    const name = (input.name as string) ?? `ac-worktree-${randomUUID().slice(0, 8)}`;
    const worktreePath = `${context.cwd}/.ashlrcode-worktrees/${name}`;

    const proc = Bun.spawn(
      ["git", "worktree", "add", "-b", name, worktreePath],
      { cwd: context.cwd, stdout: "pipe", stderr: "pipe" }
    );

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return `Failed to create worktree: ${stderr}`;
    }

    return `Worktree created at: ${worktreePath}\nBranch: ${name}\n\nUse this path as the working directory for isolated operations.`;
  },
};

export const exitWorktreeTool: Tool = {
  name: "ExitWorktree",

  prompt() {
    return "Remove a git worktree. Optionally merge changes back to the original branch.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the worktree to remove",
        },
        merge: {
          type: "boolean",
          description: "Merge the worktree branch back before removing (default: false)",
        },
      },
      required: ["path"],
    };
  },

  isReadOnly() {
    return false;
  },
  isDestructive() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    if (!input.path) return "path is required";
    return null;
  },

  async call(input, context) {
    const worktreePath = input.path as string;
    const merge = (input.merge as boolean) ?? false;

    if (merge) {
      // Get the branch name from the worktree
      const branchProc = Bun.spawn(
        ["git", "-C", worktreePath, "branch", "--show-current"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const branch = (await new Response(branchProc.stdout).text()).trim();

      if (branch) {
        // Merge the branch
        const mergeProc = Bun.spawn(
          ["git", "merge", branch, "--no-edit"],
          { cwd: context.cwd, stdout: "pipe", stderr: "pipe" }
        );
        const mergeStderr = await new Response(mergeProc.stderr).text();
        const mergeExit = await mergeProc.exited;

        if (mergeExit !== 0) {
          return `Merge failed: ${mergeStderr}\nWorktree NOT removed. Resolve conflicts manually.`;
        }
      }
    }

    // Remove the worktree
    const proc = Bun.spawn(
      ["git", "worktree", "remove", worktreePath, "--force"],
      { cwd: context.cwd, stdout: "pipe", stderr: "pipe" }
    );

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return `Failed to remove worktree: ${stderr}`;
    }

    return `Worktree removed: ${worktreePath}${merge ? " (changes merged)" : ""}`;
  },
};
