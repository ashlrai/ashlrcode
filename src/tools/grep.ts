/**
 * GrepTool — content search using ripgrep or fallback to native search.
 */

import { resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";

export const grepTool: Tool = {
  name: "Grep",

  prompt() {
    return "Search file contents using regex patterns. Uses ripgrep (rg) for fast searching. Returns matching lines with file paths and line numbers.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "File or directory to search in (defaults to cwd)",
        },
        glob: {
          type: "string",
          description: 'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}")',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output mode (default: files_with_matches)",
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
    const globFilter = input.glob as string | undefined;
    const outputMode = (input.output_mode as string) ?? "files_with_matches";

    const args = ["rg"];

    switch (outputMode) {
      case "files_with_matches":
        args.push("-l");
        break;
      case "count":
        args.push("-c");
        break;
      case "content":
        args.push("-n"); // line numbers
        break;
    }

    if (globFilter) {
      args.push("--glob", globFilter);
    }

    args.push("--max-count", "250");
    args.push("--no-heading");
    args.push(pattern, searchPath);

    const proc = Bun.spawn(args, {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 1) {
      return `No matches found for "${pattern}"`;
    }

    if (exitCode !== 0 && exitCode !== 1) {
      // ripgrep not found — fall back to grep
      if (stderr.includes("not found") || stderr.includes("No such file")) {
        return await fallbackGrep(pattern, searchPath, context);
      }
      return `Search error: ${stderr}`;
    }

    return stdout.trim() || `No matches found for "${pattern}"`;
  },
};

async function fallbackGrep(
  pattern: string,
  searchPath: string,
  context: ToolContext
): Promise<string> {
  const proc = Bun.spawn(
    ["grep", "-r", "-n", "--include=*.{ts,js,tsx,jsx,py,go,rs,md,json}", pattern, searchPath],
    { cwd: context.cwd, stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim() || `No matches found for "${pattern}"`;
}
