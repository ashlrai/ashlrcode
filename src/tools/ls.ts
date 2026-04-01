/**
 * LS tool — directory listing without Bash.
 */

import { readdir, stat } from "fs/promises";
import { resolve, join } from "path";
import type { Tool, ToolContext } from "./types.ts";

export const lsTool: Tool = {
  name: "LS",

  prompt() {
    return "List files and directories in a given path. Returns names with type indicators (/ for directories). Lighter than Bash ls.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (defaults to cwd)",
        },
      },
      required: [],
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

  validateInput() {
    return null;
  },

  async call(input, context) {
    const dirPath = resolve(context.cwd, (input.path as string) ?? ".");

    try {
      const entries = await readdir(dirPath);
      const details: string[] = [];

      for (const entry of entries) {
        if (entry.startsWith(".")) continue; // Skip hidden files
        try {
          const s = await stat(join(dirPath, entry));
          const indicator = s.isDirectory() ? "/" : "";
          const size = s.isDirectory() ? "" : ` (${formatSize(s.size)})`;
          details.push(`${entry}${indicator}${size}`);
        } catch {
          details.push(entry);
        }
      }

      if (details.length === 0) {
        return `Empty directory: ${dirPath}`;
      }

      return details.join("\n");
    } catch (err) {
      return `Error listing ${dirPath}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
