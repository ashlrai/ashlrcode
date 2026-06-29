/**
 * FileWriteTool — create or overwrite files.
 */

import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { Tool, ToolContext } from "./types.ts";
import {
  validateFilePath,
  resolveFilePath,
  checkSensitivePath,
  captureSnapshot,
} from "./file-utils.ts";

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
    const pathErr = validateFilePath(input);
    if (pathErr) return pathErr;
    if (typeof input.content !== "string") {
      return "content is required and must be a string";
    }
    return null;
  },

  checkPermissions(input: Record<string, unknown>, context: ToolContext): string | null {
    const filePath = input.file_path as string;
    if (!filePath) return null;
    return checkSensitivePath(resolveFilePath(context.cwd, filePath));
  },

  async call(input, context) {
    const filePath = resolveFilePath(context.cwd, input.file_path as string);
    const content = input.content as string;

    // Snapshot before overwriting (captures new files too for undo-as-delete)
    await captureSnapshot(filePath, "Write", context.turnNumber ?? 0);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    const lines = content.split("\n").length;
    return `Wrote ${lines} lines to ${filePath}`;
  },
};
