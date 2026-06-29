/**
 * BashTool — execute shell commands with timeout and live output streaming.
 *
 * Autonomous safety guards (both default-off, flag-gated via settings):
 *   phantomSealed  — routes commands through `phantom exec --` so secrets
 *                    never appear in prompts/transcripts.
 *   binshieldGate  — scans dependency-install commands via binshield before
 *                    executing; blocks on critical/high risk verdict.
 */

import chalk from "chalk";
import type { Tool, ToolContext } from "./types.ts";
import { applyPhantomSeal } from "./guards/phantom-seal.ts";
import { checkBinshieldGate } from "./guards/binshield-gate.ts";
import { validateBash } from "./validators/index.ts";
import type { Settings } from "../config/settings.ts";
import {
  ToolResultStreamer,
  type ToolResultChunk,
} from "../agent/tool-result-streaming.ts";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const LIVE_OUTPUT_THRESHOLD = 5_000; // Stream live after 5s

/**
 * Optional streaming callback injected by the executor layer.
 * When set, bash output is fed through a ToolResultStreamer so the UI
 * receives semantic chunks (log lines, JSON blocks, diffs) progressively.
 */
export let _bashStreamingCallback:
  | ((name: string, chunk: ToolResultChunk) => void)
  | undefined;

/**
 * Wire a streaming callback so BashTool feeds chunks to the UI layer.
 * Call with undefined to unregister.
 */
export function setBashStreamingCallback(
  cb: ((name: string, chunk: ToolResultChunk) => void) | undefined
): void {
  _bashStreamingCallback = cb;
}

/** Reset for tests. */
export function _resetBashStreamingCallback(): void {
  _bashStreamingCallback = undefined;
}

// ── Guard settings cache ──────────────────────────────────────────────────────
// Loaded lazily on first autonomous call; never throws.

let _cachedSettings: Settings | null = null;
let _settingsLoaded = false;

async function getGuardSettings(): Promise<Settings> {
  if (_settingsLoaded) return _cachedSettings ?? ({} as Settings);
  _settingsLoaded = true;
  try {
    const { loadSettings } = await import("../config/settings.ts");
    _cachedSettings = await loadSettings();
  } catch {
    _cachedSettings = {} as Settings;
  }
  return _cachedSettings;
}

/** Reset for tests — allows injecting mock settings. */
export function _resetGuardSettingsCache(settings?: Settings): void {
  _cachedSettings = settings ?? null;
  _settingsLoaded = settings !== undefined;
}

/** Fetch override for binshield — injectable in tests. */
export let _binshieldFetchOverride: typeof fetch | undefined;
export function _setBinshieldFetch(fn: typeof fetch | undefined): void {
  _binshieldFetchOverride = fn;
}

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

  validateSemantics(input: Record<string, unknown>): string | null {
    return validateBash(input.command as string);
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
    let command = input.command as string;
    const timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT;

    // ── Autonomous safety guards ────────────────────────────────────────────
    // Both are default-off and never-throw; degrade gracefully when unavailable.
    try {
      const s = await getGuardSettings();

      // Guard 1: BinShield install gate — scan before executing installs
      if (s.binshieldGate) {
        const gate = await checkBinshieldGate(command, {
          enabled: true,
          apiUrl: s.binshieldUrl,
          apiKey: s.binshieldKey,
          fetchFn: _binshieldFetchOverride,
        });
        if (gate.verdict === "block") {
          return gate.reason;
        }
      }

      // Guard 2: Phantom-sealed secrets — wrap command through phantom exec
      if (s.phantomSealed) {
        const seal = await applyPhantomSeal(command, {
          enabled: true,
          cwd: context.cwd,
        });
        command = seal.command;
      }
    } catch {
      // Guards must never break normal tool execution
    }
    // ── End guards ──────────────────────────────────────────────────────────

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

      const finalResult = result || "(no output)";

      // Feed result through ToolResultStreamer when a streaming callback is wired.
      // This gives the UI semantic chunks (log lines, JSON blocks, diffs, errors)
      // as progressive updates rather than a single large string.
      if (_bashStreamingCallback) {
        try {
          const cb = _bashStreamingCallback;
          const streamer = new ToolResultStreamer({
            toolName: "Bash",
            toolInput: input as Record<string, unknown>,
            onToolResultChunk: (chunk: ToolResultChunk) => cb("Bash", chunk),
          });
          streamer.push(finalResult);
          streamer.finalize();
        } catch {
          // Streaming is best-effort; never block normal tool execution
        }
      }

      return finalResult;
    } catch {
      clearTimeout(timeoutId);
      // Release stdout reader lock and drain stderr
      try { reader.releaseLock(); } catch {}
      try { await stderrPromise; } catch {}
      return "Command timed out";
    }
  },
};
