/**
 * GlobTool — fast file pattern matching.
 */

import fg from "fast-glob";
import { resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";

export const globTool: Tool = {
  name: "Glob",

  prompt() {
    return 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Example patterns: "**/*.ts", "src/**/*.tsx", "*.json"';
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files against",
        },
        path: {
          type: "string",
          description: "Directory to search in (defaults to cwd)",
        },
      },
      required: ["pattern"],
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
    if (!input.pattern || typeof input.pattern !== "string") {
      return "pattern is required";
    }
    return null;
  },

  async call(input, context) {
    const pattern = input.pattern as string;
    const searchPath = resolve(context.cwd, (input.path as string) ?? ".");

    const files = await fg(pattern, {
      cwd: searchPath,
      absolute: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
      stats: true,
    });

    // Sort by modification time (most recent first)
    files.sort((a, b) => {
      const aTime = a.stats?.mtimeMs ?? 0;
      const bTime = b.stats?.mtimeMs ?? 0;
      return bTime - aTime;
    });

    if (files.length === 0) {
      return `No files matching "${pattern}" in ${searchPath}`;
    }

    const paths = files.map((f) => f.path).join("\n");
    return `${files.length} file(s) found:\n${paths}`;
  },
};
