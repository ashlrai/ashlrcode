/**
 * BashTool — execute shell commands with timeout and output capture.
 */

import type { Tool, ToolContext } from "./types.ts";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export const bashTool: Tool = {
  name: "Bash",

  prompt() {
    return "Execute a bash command and return its output. Use for system commands, git operations, running tests, installing packages, etc. Commands run in the project's working directory.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 120000)",
        },
      },
      required: ["command"],
    };
  },

  isReadOnly() {
    return false;
  },
  isDestructive() {
    return false; // We prompt for permission on all bash commands
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    if (!input.command || typeof input.command !== "string") {
      return "command is required and must be a string";
    }
    return null;
  },

  async call(input, context) {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT;

    // Always ask permission for bash commands
    const allowed = await context.requestPermission(
      "Bash",
      `Run: ${command}`
    );
    if (!allowed) {
      return "Permission denied by user";
    }

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
    }, timeout);

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      let result = "";
      if (stdout) result += stdout;
      if (stderr) result += (result ? "\n" : "") + stderr;
      if (exitCode !== 0) {
        result += `\nExit code: ${exitCode}`;
      }

      return result || "(no output)";
    } catch {
      clearTimeout(timeoutId);
      return "Command timed out";
    }
  },
};
