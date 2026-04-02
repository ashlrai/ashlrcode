/**
 * DiffTool — show differences between file versions or git changes.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";

export const diffTool: Tool = {
  name: "Diff",

  prompt() {
    return `Show differences between files or git changes. Modes:
- git: show git diff for a file or the whole repo
- files: compare two files
- string: compare two strings (useful for showing before/after)`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["git", "files", "string"],
          description: "Diff mode (default: git)",
        },
        file_path: {
          type: "string",
          description: "File path for git diff, or first file for files mode",
        },
        file_path_2: {
          type: "string",
          description: "Second file path (for files mode)",
        },
        old_string: {
          type: "string",
          description: "Old string (for string mode)",
        },
        new_string: {
          type: "string",
          description: "New string (for string mode)",
        },
        staged: {
          type: "boolean",
          description: "Show staged changes (git mode, default: false)",
        },
      },
      required: [],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput() { return null; },

  async call(input, context) {
    const mode = (input.mode as string) ?? "git";

    switch (mode) {
      case "git":
        return await gitDiff(input, context);
      case "files":
        return await filesDiff(input, context);
      case "string":
        return stringDiff(input);
      default:
        return `Unknown mode: ${mode}`;
    }
  },
};

async function gitDiff(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const args = ["git", "diff"];
  if (input.staged) args.push("--staged");
  if (input.file_path) args.push("--", input.file_path as string);

  const proc = Bun.spawn(args, {
    cwd: context.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 || !stdout.trim()) {
    return "No changes found.";
  }

  return stdout.trim();
}

async function filesDiff(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const path1 = resolve(context.cwd, input.file_path as string);
  const path2 = resolve(context.cwd, input.file_path_2 as string);

  if (!existsSync(path1)) return `File not found: ${path1}`;
  if (!existsSync(path2)) return `File not found: ${path2}`;

  const proc = Bun.spawn(["diff", "-u", path1, path2], {
    cwd: context.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  return stdout.trim() || "Files are identical.";
}

function stringDiff(input: Record<string, unknown>): string {
  const oldStr = (input.old_string as string) ?? "";
  const newStr = (input.new_string as string) ?? "";

  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const lines: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === newLine) {
      if (oldLine !== undefined) lines.push(`  ${oldLine}`);
    } else {
      if (oldLine !== undefined) lines.push(`- ${oldLine}`);
      if (newLine !== undefined) lines.push(`+ ${newLine}`);
    }
  }

  return lines.join("\n") || "No differences.";
}
