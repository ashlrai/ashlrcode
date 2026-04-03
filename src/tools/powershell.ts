/**
 * PowerShellTool — execute PowerShell commands on Windows.
 */

import chalk from "chalk";
import type { Tool, ToolContext } from "./types.ts";

const DEFAULT_TIMEOUT = 120_000;

export const powershellTool: Tool = {
  name: "PowerShell",

  prompt() {
    return "Execute a PowerShell command on Windows. Use for system commands, file operations, and Windows-specific tasks.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        command: { type: "string", description: "The PowerShell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 120000)" },
      },
      required: ["command"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return true; },
  isConcurrencySafe() { return false; },

  validateInput(input) {
    if (!input.command || typeof input.command !== "string") return "command is required";
    return null;
  },

  async call(input, context) {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT;

    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const proc = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeoutId = setTimeout(() => proc.kill(), timeout);
    const stderrPromise = new Response(proc.stderr).text();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      let stdout = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }

      const stderr = await stderrPromise;
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      let result = "";
      if (stdout) result += stdout;
      if (stderr) result += (result ? "\n" : "") + stderr;
      if (exitCode !== 0) result += `\nExit code: ${exitCode}`;

      if (result.length > 50_000) {
        result = result.slice(0, 20_000) + `\n\n[... truncated ${result.length - 40_000} chars ...]\n\n` + result.slice(-20_000);
      }

      return result || "(no output)";
    } catch {
      clearTimeout(timeoutId);
      try { reader.releaseLock(); } catch {}
      try { await stderrPromise; } catch {}
      return "Command timed out";
    }
  },
};
