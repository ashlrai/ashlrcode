/**
 * BashTool — execute shell commands with timeout and live output streaming.
 */

import chalk from "chalk";
import type { Tool, ToolContext } from "./types.ts";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const LIVE_OUTPUT_THRESHOLD = 5_000; // Stream live after 5s

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
    return true;
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

  checkPermissions(input: Record<string, unknown>): string | null {
    const cmd = input.command as string;
    if (!cmd) return null;
    const dangerous = [
      /\brm\s+-rf\s+[\/~]/,
      /\bdd\s+.*of=\/dev/,
      /\bmkfs\b/,
    ];
    for (const pattern of dangerous) {
      if (pattern.test(cmd)) return `Dangerous command pattern: ${pattern.source}`;
    }
    return null;
  },

  async call(input, context) {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT;

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
    }, timeout);

    // Start reading stderr concurrently (prevents deadlock if pipe buffer fills)
    const stderrPromise = new Response(proc.stderr).text();

    // Read stdout in chunks
    const reader = proc.stdout.getReader();

    try {
      // Collect output with live streaming for long-running commands
      let stdout = "";
      let liveMode = false;
      const startTime = Date.now();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        stdout += chunk;

        // Switch to live output after threshold
        if (!liveMode && Date.now() - startTime > LIVE_OUTPUT_THRESHOLD) {
          liveMode = true;
          process.stderr.write(chalk.dim("    [live output]\n"));
          // Print buffered content
          if (stdout.length > chunk.length) {
            process.stderr.write(chalk.dim(stdout.slice(0, -chunk.length)));
          }
        }
        if (liveMode) {
          process.stderr.write(chalk.dim(chunk));
        }
      }

      const stderr = await stderrPromise;
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      if (liveMode) {
        process.stderr.write("\n");
      }

      let result = "";
      if (stdout) result += stdout;
      if (stderr) result += (result ? "\n" : "") + stderr;
      if (exitCode !== 0) {
        result += `\nExit code: ${exitCode}`;
      }

      // Truncate very long output for the model
      if (result.length > 50_000) {
        result =
          result.slice(0, 20_000) +
          `\n\n[... truncated ${result.length - 40_000} chars ...]\n\n` +
          result.slice(-20_000);
      }

      return result || "(no output)";
    } catch {
      clearTimeout(timeoutId);
      // Release stdout reader lock and drain stderr
      try { reader.releaseLock(); } catch {}
      try { await stderrPromise; } catch {}
      return "Command timed out";
    }
  },
};
