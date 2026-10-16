/**
 * FileReadTool — read file contents with line numbers.
 */

import { readFile } from "fs/promises";
import type { Tool, ToolContext } from "./types.ts";
import { validateFilePath, resolveFilePath, checkFileExists } from "./file-utils.ts";
import { validatePath } from "./validators/index.ts";

export const fileReadTool: Tool = {
  name: "Read",

  prompt() {
    return "Read a file from the filesystem. Returns contents with line numbers. Supports offset and limit for reading specific portions of large files.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute path to the file to read",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (0-based)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read",
        },
      },
      required: ["file_path"],
    };
  },

  isReadOnly() {
    return true;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return true;
  },

  validateInput(input) {
    return validateFilePath(input);
  },

  validateSemantics(input: Record<string, unknown>, context: ToolContext): string | null {
    return validatePath(input.file_path as string, context.cwd);
  },

  async call(input, context) {
    const filePath = resolveFilePath(context.cwd, input.file_path as string);

    const notFound = checkFileExists(filePath);
    if (notFound) return notFound;

    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");

    const offset = (input.offset as number) ?? 0;
    const limit = (input.limit as number) ?? 2000;
    const slice = lines.slice(offset, offset + limit);

    const numbered = slice
      .map((line, i) => `${offset + i + 1}\t${line}`)
      .join("\n");

    const total = lines.length;
    const showing = slice.length;
    const header =
      showing < total
        ? `(Showing lines ${offset + 1}-${offset + showing} of ${total})\n`
        : "";

    return header + numbered;
  },
};
