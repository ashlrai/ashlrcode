/**
 * KAIROS — Autonomous Agent Mode.
 *
 * Heartbeat-driven loop that keeps the agent alive between user inputs.
 * Terminal focus detection adjusts autonomy level:
 *   - focused   → collaborative (ask before big changes)
 *   - unfocused  → full-auto (lean into autonomous action)
 *   - unknown    → autonomous (balanced default)
 */

import { runAgentLoop } from "./loop.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { Message } from "../providers/types.ts";
import { generateAwaySummary, formatAwaySummaryForNotification } from "./away-summary.ts";

/* ── Configuration ──────────────────────────────────────────────── */

export interface KairosConfig {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  /** Milliseconds between autonomous heartbeats. Default: 30_000 */
  heartbeatIntervalMs: number;
  /** Max tool-loop iterations per heartbeat tick. Default: 5 */
  maxAutonomousIterations: number;
  onOutput: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
}

export type AutonomyLevel = "collaborative" | "autonomous" | "full-auto";

/* ── Focus detection ────────────────────────────────────────────── */

export type FocusState = "focused" | "unfocused" | "unknown";

/**
 * Detect whether a terminal application is the frontmost window.
 * macOS: uses osascript.  Linux: uses xdotool.  Otherwise: unknown.
 */
export async function detectTerminalFocus(): Promise<FocusState> {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      const proc = Bun.spawn(
        ["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      const terminals = ["Terminal", "iTerm2", "Alacritty", "kitty", "Warp", "Hyper", "WezTerm"];
      return terminals.some(t => output.includes(t)) ? "focused" : "unfocused";
    }

    if (platform === "linux") {
      const proc = Bun.spawn(
        ["bash", "-c", "xdotool getactivewindow getwindowname 2>/dev/null || echo unknown"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = (await new Response(proc.stdout).text()).trim().toLowerCase();
      await proc.exited;
      if (output === "unknown") return "unknown";
      const terminals = ["terminal", "konsole", "alacritty", "kitty", "tmux", "screen"];
      return terminals.some(t => output.includes(t)) ? "focused" : "unfocused";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

/* ── Autonomy helpers ───────────────────────────────────────────── */

function getAutonomyLevel(focusState: FocusState): AutonomyLevel {
  switch (focusState) {
    case "unfocused": return "full-auto";
    case "focused":   return "collaborative";
    default:          return "autonomous";
  }
}

function getAutonomyPrompt(level: AutonomyLevel): string {
  switch (level) {
    case "full-auto":
      return "\n\n[AUTONOMOUS MODE — User is away]\nLean heavily into autonomous action. Read files, make changes, commit, push. Decide independently. Only pause for truly irreversible or ambiguous decisions.";
    case "collaborative":
      return "\n\n[COLLABORATIVE MODE — User is watching]\nBe more collaborative. Ask before making significant changes. Explain your reasoning. Use AskUser for decisions.";
    case "autonomous":
      return "\n\n[AUTONOMOUS MODE]\nYou are running autonomously. Complete tasks independently but use good judgment about what requires confirmation.";
  }
}

/* ── Push notifications ────────────────────────────────────────── */

/**
 * Send a macOS notification. No-op on other platforms.
 * Uses osascript to display a native notification center alert.
 */
async function sendNotification(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const escaped = message.replace(/"/g, '\\"').slice(0, 200);
    const escapedTitle = title.replace(/"/g, '\\"');
    const proc = Bun.spawn(
      ["osascript", "-e", `display notification "${escaped}" with title "${escapedTitle}"`],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
  } catch {
    // Notification failure is not critical
  }
}

/* ── KAIROS loop ────────────────────────────────────────────────── */

export class KairosLoop {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private focusTimer: ReturnType<typeof setInterval> | null = null;
  private history: Message[] = [];
  private config: KairosConfig;
  private tickCount = 0;
  private _focusState: FocusState = "unknown";

  constructor(config: KairosConfig) {
    this.config = config;
  }

  /** Kick off the autonomous loop with an initial goal. */
  async start(initialGoal: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;

    this.config.onOutput(
      `  KAIROS active — heartbeat every ${this.config.heartbeatIntervalMs / 1000}s\n`,
    );

    // Poll terminal focus every 10 s
    this.focusTimer = setInterval(async () => {
      this._focusState = await detectTerminalFocus();
    }, 10_000);

    // Initial goal execution
    await this.executeTick(initialGoal);

    // Recurring heartbeat
    this.timer = setInterval(() => {
      if (this.running) this.heartbeat().catch(() => {});
    }, this.config.heartbeatIntervalMs);
  }

  /** Gracefully stop the loop. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.focusTimer) { clearInterval(this.focusTimer); this.focusTimer = null; }
    this.config.onOutput("  KAIROS stopped\n");

    // Push notification when user is away
    if (this._focusState === "unfocused") {
      await sendNotification(
        "AshlrCode — KAIROS Complete",
        `Autonomous work finished after ${this.tickCount} ticks.`,
      );
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Inject a user message into the running autonomous loop. */
  async injectMessage(message: string): Promise<void> {
    await this.executeTick(message);
  }

  /* ── internals ──────────────────────────────────────────────── */

  private async heartbeat(): Promise<void> {
    if (!this.running) return;
    this.tickCount++;

    const level = getAutonomyLevel(this._focusState);

    // Every 3rd tick, prompt the agent to scan for new work if idle
    const scanPrompt = this.tickCount % 3 === 0
      ? "\nIf nothing is pending, use the Bash tool to run `bun test` and check for failures. Also search for TODO/FIXME comments with Grep. Fix any issues you find."
      : "\nIf nothing is pending, check if there are improvements to make or tests to run.";

    const tick = [
      `<tick count="${this.tickCount}" focus="${this._focusState}" autonomy="${level}" time="${new Date().toISOString()}">`,
      "Continue your current work. Check task list for pending items.",
      scanPrompt,
    ].join("\n");

    this.config.onOutput(`  tick #${this.tickCount} [${level}]\n`);
    await this.executeTick(tick);

    // Away Summary: every 5th tick when user is away, send a notification summary
    if (this._focusState === "unfocused" && this.tickCount % 5 === 0 && this.history.length > 0) {
      const summary = generateAwaySummary(this.history);
      summary.duration = `${Math.round((this.tickCount * (this.config.heartbeatIntervalMs / 1000)) / 60)}m`;
      const notifText = formatAwaySummaryForNotification(summary);
      sendNotification("AshlrCode — Away Summary", notifText).catch(() => {});
    }
  }

  private async executeTick(prompt: string): Promise<void> {
    const level = getAutonomyLevel(this._focusState);
    const autonomyPrompt = getAutonomyPrompt(level);

    try {
      const result = await runAgentLoop(prompt, this.history, {
        systemPrompt: this.config.systemPrompt + autonomyPrompt,
        router: this.config.router,
        toolRegistry: this.config.toolRegistry,
        toolContext: this.config.toolContext,
        maxIterations: this.config.maxAutonomousIterations,
        onText: (text) => this.config.onOutput(text),
        onToolStart: this.config.onToolStart,
        onToolEnd: this.config.onToolEnd,
      });

      this.history = result.messages;

      // Cap history to prevent unbounded growth
      const MAX_HISTORY = 100;
      if (this.history.length > MAX_HISTORY) {
        this.history = this.history.slice(-MAX_HISTORY);
      }

      // Auto-stop if the model signals completion
      if (
        result.finalText.includes("[KAIROS_STOP]") ||
        result.finalText.includes("nothing left to do")
      ) {
        await this.stop();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.config.onOutput(`  KAIROS error: ${errMsg}\n`);

      // Notify on error when user is away
      if (this._focusState === "unfocused") {
        sendNotification("AshlrCode — KAIROS Error", errMsg.slice(0, 100)).catch(() => {});
      }
    }
  }
}
