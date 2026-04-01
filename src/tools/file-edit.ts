/**
 * FileEditTool — exact string replacement in files.
 * Follows Claude Code's Edit pattern.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";
import { fileHistory } from "../state/file-history.ts";

export const fileEditTool: Tool = {
  name: "Edit",

  prompt() {
    return "Perform exact string replacement in a file. The old_string must be unique in the file. Use replace_all: true to replace all occurrences.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the file to edit",
        },
        old_string: {
          type: "string",
          description: "The exact text to find and replace",
        },
        new_string: {
          type: "string",
          description: "The replacement text",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default: false)",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    };
  },

  isReadOnly() {
    return false;
  },
  isDestructive() {
    return false; // Reversible via edit
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    if (!input.file_path || typeof input.file_path !== "string") {
      return "file_path is required";
    }
    if (typeof input.old_string !== "string") {
      return "old_string is required";
    }
    if (typeof input.new_string !== "string") {
      return "new_string is required";
    }
    if (input.old_string === input.new_string) {
      return "old_string and new_string must be different";
    }
    return null;
  },

  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path as string);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (!existsSync(filePath)) {
      return `File not found: ${filePath}`;
    }

    // Snapshot before editing
    await fileHistory.snapshot(filePath);

    const content = await readFile(filePath, "utf-8");

    if (!replaceAll) {
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return `old_string not found in ${filePath}`;
      }
      if (occurrences > 1) {
        return `old_string found ${occurrences} times — must be unique. Provide more context or use replace_all: true.`;
      }
    }

    const updated = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);

    await writeFile(filePath, updated, "utf-8");

    const replacements = replaceAll
      ? content.split(oldString).length - 1
      : 1;

    // Show a mini diff
    const oldLines = oldString.split("\n");
    const newLines = newString.split("\n");
    const diffLines: string[] = [];
    for (const line of oldLines.slice(0, 3)) {
      diffLines.push(`- ${line}`);
    }
    if (oldLines.length > 3) diffLines.push(`  ... (${oldLines.length} lines)`);
    for (const line of newLines.slice(0, 3)) {
      diffLines.push(`+ ${line}`);
    }
    if (newLines.length > 3) diffLines.push(`  ... (${newLines.length} lines)`);

    return `Replaced ${replacements} occurrence(s) in ${filePath}\n${diffLines.join("\n")}`;
  },
};
