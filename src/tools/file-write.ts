/**
 * FileWriteTool — create or overwrite files.
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";
import { getFileHistory } from "../state/file-history.ts";

export const fileWriteTool: Tool = {
  name: "Write",

  prompt() {
    return "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories as needed.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["file_path", "content"],
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
    if (!input.file_path || typeof input.file_path !== "string") {
      return "file_path is required and must be a string";
    }
    if (typeof input.content !== "string") {
      return "content is required and must be a string";
    }
    return null;
  },

  checkPermissions(input: Record<string, unknown>, context: ToolContext): string | null {
    const filePath = input.file_path as string;
    if (!filePath) return null;
    const resolved = resolve(context.cwd, filePath);
    const sensitive = ["/etc/", "/usr/bin/", "/sbin/", "/.ssh/"];
    for (const s of sensitive) {
      if (resolved.includes(s)) return `Cannot write to sensitive path: ${s}`;
    }
    return null;
  },

  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path as string);
    const content = input.content as string;

    // Snapshot before overwriting (captures new files too for undo-as-delete)
    const history = getFileHistory();
    if (history) {
      await history.capture(filePath, "Write", context.turnNumber ?? 0);
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    const lines = content.split("\n").length;
    return `Wrote ${lines} lines to ${filePath}`;
  },
};
