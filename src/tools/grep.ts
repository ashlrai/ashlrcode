/**
 * GrepTool — content search. Tries ripgrep first, falls back to grep.
 */

import { resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";

export const grepTool: Tool = {
  name: "Grep",

  prompt() {
    return "Search file contents using regex patterns. Returns matching lines with file paths and line numbers.";
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

    // Try ripgrep first (use bash -c to resolve shell functions/aliases)
    try {
      const result = await runRipgrep(pattern, searchPath, globFilter, outputMode, context);
      if (result !== null) return result;
    } catch {
      // ripgrep not available, fall through to grep
    }

    // Fallback to system grep
    return await runGrep(pattern, searchPath, globFilter, outputMode, context);
  },
};

async function runRipgrep(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  outputMode: string,
  context: ToolContext
): Promise<string | null> {
  const rgArgs: string[] = [];

  switch (outputMode) {
    case "files_with_matches":
      rgArgs.push("-l");
      break;
    case "count":
      rgArgs.push("-c");
      break;
    case "content":
      rgArgs.push("-n");
      break;
  }

  if (globFilter) {
    rgArgs.push("--glob", globFilter);
  }

  rgArgs.push("--max-count", "250", "--no-heading");
  rgArgs.push("--", pattern, searchPath);

  // Spawn rg directly (no shell) to eliminate command injection risk.
  // Previous approach used bash -c with shell escaping, but direct
  // argv-style invocation is inherently safe.
  const proc = Bun.spawn(["rg", ...rgArgs], {
    cwd: context.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode === 1 && !stderr) {
    return `No matches found for "${pattern}"`;
  }

  if (exitCode !== 0 && exitCode !== 1) {
    if (stderr.includes("not found") || stderr.includes("command not found")) {
      return null; // rg not available
    }
    return `Search error: ${stderr}`;
  }

  return stdout.trim() || `No matches found for "${pattern}"`;
}

async function runGrep(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  outputMode: string,
  context: ToolContext
): Promise<string> {
  const args = ["grep", "-r"];

  switch (outputMode) {
    case "files_with_matches":
      args.push("-l");
      break;
    case "count":
      args.push("-c");
      break;
    case "content":
      args.push("-n");
      break;
  }

  if (globFilter) {
    args.push(`--include=${globFilter}`);
  } else {
    args.push("--include=*.ts", "--include=*.js", "--include=*.tsx",
      "--include=*.jsx", "--include=*.py", "--include=*.go",
      "--include=*.rs", "--include=*.md", "--include=*.json");
  }

  args.push(pattern, searchPath);

  const proc = Bun.spawn(args, {
    cwd: context.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode === 1) {
    return `No matches found for "${pattern}"`;
  }

  // Limit output
  const lines = stdout.trim().split("\n");
  if (lines.length > 250) {
    return lines.slice(0, 250).join("\n") + `\n\n[... ${lines.length - 250} more matches]`;
  }

  return stdout.trim() || `No matches found for "${pattern}"`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
