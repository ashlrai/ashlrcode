/**
 * context-budget-monitor.ts — Real-Time Context Budget Monitor
 *
 * Tracks per-turn token consumption, compression applied, and remaining budget
 * as a rolling window. Provides live telemetry for the terminal UI header bar
 * and optional verbose JSONL logging for post-session analysis.
 *
 * Integration points:
 *   - Called from onUsage() in the agent loop (repl.tsx) each turn.
 *   - Queried by App.tsx to render the 2-line header bar.
 *   - Used by /budget status command to display current + historical breakdown.
 *
 * Color thresholds:
 *   green  < 70%  (plenty of runway)
 *   yellow 70-85% (moderate pressure)
 *   red    85%+   (critical — overflow imminent)
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { TokenUsage } from "../providers/types.ts";
import { getProviderContextLimit } from "../agent/context.ts";
import { getBudgetAllocator } from "./budget-allocator.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Color threshold: green below this percentage. */
export const BUDGET_COLOR_GREEN_MAX = 70;

/** Color threshold: yellow below this percentage (red above). */
export const BUDGET_COLOR_YELLOW_MAX = 85;

/** Rolling window size for per-turn observations. */
export const TURN_WINDOW_SIZE = 50;

/** Tokens-per-turn estimate for runway calculation — uses rolling average. */
export const DEFAULT_TOKENS_PER_TURN = 2_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Color level for budget bar display. */
export type BudgetColor = "green" | "yellow" | "red";

/**
 * A single turn's recorded telemetry.
 */
export interface TurnRecord {
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number;
  /** Turn index within the session (1-based). */
  turnIndex: number;
  /** Provider name (e.g. "anthropic", "xai"). */
  provider: string;
  /** Model name (e.g. "claude-opus-4-5"). */
  model: string;
  /** Input tokens reported by the provider for this turn. */
  inputTokens: number;
  /** Output tokens reported by the provider for this turn. */
  outputTokens: number;
  /** Reasoning tokens (if applicable — e.g. extended thinking). */
  reasoningTokens: number;
  /** Total tokens used (input + output + reasoning). */
  totalTokens: number;
  /** Provider context limit in tokens at time of recording. */
  contextLimit: number;
  /** Fill ratio after this turn (0–1). */
  fillRatio: number;
  /** Compression tier applied during this turn (0 = none, 1–3 = tier applied). */
  compressionTier: number;
  /** Tokens saved by compression this turn (0 if none applied). */
  compressionSaved: number;
  /** Compression ratio as a percentage (0–100). */
  compressionRatio: number;
}

/**
 * Live snapshot of the budget monitor state for UI rendering.
 */
export interface BudgetSnapshot {
  /** Provider name. */
  provider: string;
  /** Model name. */
  model: string;
  /** Total tokens used so far (cumulative across turns). */
  usedTokens: number;
  /** Provider context limit. */
  contextLimit: number;
  /** Fill percentage (0–100, clamped). */
  usedPercent: number;
  /** Color to use for the budget bar. */
  color: BudgetColor;
  /** Compression ratios for the last 3 turns (as percentages, oldest first). */
  recentCompressionRatios: number[];
  /** Estimated turns remaining before context exhaustion. */
  runwayTurns: number;
  /** Total turns recorded this session. */
  totalTurns: number;
  /** Overhead multiplier from reasoning model (from BudgetAllocator). */
  overheadMultiplier: number;
}

/**
 * Historical breakdown by provider, for /budget status.
 */
export interface ProviderHistoryEntry {
  provider: string;
  model: string;
  turns: number;
  totalTokens: number;
  avgTokensPerTurn: number;
  maxFillRatio: number;
  compressionEvents: number;
  totalCompressionSaved: number;
}

/** Verbose log entry written to JSONL when --budget-verbose is enabled. */
export interface BudgetLogEntry extends TurnRecord {
  /** Session ID for cross-session correlation. */
  sessionId: string;
  /** BudgetAllocator overhead multiplier at this point in time. */
  overheadMultiplier: number;
  /** Compression limits that were active. */
  compressionLimits: {
    maxBytes: number;
    chunkSummaryThreshold: number;
  };
  /** Budget snapshot at end of turn. */
  snapshot: Omit<BudgetSnapshot, "recentCompressionRatios">;
}

// ---------------------------------------------------------------------------
// ContextBudgetMonitor
// ---------------------------------------------------------------------------

export class ContextBudgetMonitor {
  private _turns: TurnRecord[] = [];
  private _turnIndex = 0;
  private _sessionId: string;
  private _provider: string = "unknown";
  private _model: string = "unknown";
  private _verboseLogPath: string | null = null;
  private _cumulativeInputTokens = 0;
  private _cumulativeOutputTokens = 0;
  private _cumulativeReasoningTokens = 0;

  constructor(sessionId: string = "default") {
    this._sessionId = sessionId;
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /** Set the current provider and model (call when provider changes). */
  setProvider(provider: string, model: string): void {
    this._provider = provider;
    this._model = model;
    // Also update the underlying BudgetAllocator model key
    getBudgetAllocator().setModelKey(`${provider}:${model}`);
  }

  /**
   * Enable verbose JSONL logging to the given path.
   * Creates the directory if it does not exist.
   */
  enableVerboseLog(logPath: string): void {
    try {
      const dir = logPath.substring(0, logPath.lastIndexOf("/"));
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this._verboseLogPath = logPath;
    } catch {
      // Non-fatal — verbose logging is best-effort
      this._verboseLogPath = null;
    }
  }

  // ── Core recording ─────────────────────────────────────────────────────────

  /**
   * Record a usage event from the provider (call from onUsage in loop.ts).
   *
   * @param usage             Token usage from the provider response.
   * @param compressionTier   Overflow degradation tier applied this turn (0 = none).
   * @param compressionSaved  Tokens saved by compression (0 if none).
   */
  recordTurn(
    usage: TokenUsage,
    compressionTier: number = 0,
    compressionSaved: number = 0
  ): void {
    this._turnIndex++;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const reasoningTokens = usage.reasoningTokens ?? 0;
    const totalTokens = inputTokens + outputTokens + reasoningTokens;

    // Update cumulative counters
    this._cumulativeInputTokens += inputTokens;
    this._cumulativeOutputTokens += outputTokens;
    this._cumulativeReasoningTokens += reasoningTokens;

    const contextLimit = getProviderContextLimit(this._provider);
    const cumulativeTotal =
      this._cumulativeInputTokens +
      this._cumulativeOutputTokens +
      this._cumulativeReasoningTokens;
    const fillRatio = contextLimit > 0 ? Math.min(cumulativeTotal / contextLimit, 1) : 0;

    const compressionRatio =
      compressionSaved > 0 && totalTokens + compressionSaved > 0
        ? Math.round((compressionSaved / (totalTokens + compressionSaved)) * 100)
        : 0;

    const record: TurnRecord = {
      timestamp: Date.now(),
      turnIndex: this._turnIndex,
      provider: this._provider,
      model: this._model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      contextLimit,
      fillRatio,
      compressionTier,
      compressionSaved,
      compressionRatio,
    };

    this._turns.push(record);
    if (this._turns.length > TURN_WINDOW_SIZE) {
      this._turns.shift();
    }

    // Also feed into BudgetAllocator for compression limit computation
    getBudgetAllocator().recordUsage(usage);

    // Verbose log
    if (this._verboseLogPath) {
      this._writeVerboseLog(record);
    }
  }

  // ── Snapshot / query ───────────────────────────────────────────────────────

  /**
   * Compute the current budget snapshot for UI rendering.
   */
  getSnapshot(): BudgetSnapshot {
    const contextLimit = getProviderContextLimit(this._provider);
    const cumulativeTotal =
      this._cumulativeInputTokens +
      this._cumulativeOutputTokens +
      this._cumulativeReasoningTokens;
    const usedPercent = contextLimit > 0
      ? Math.min(Math.round((cumulativeTotal / contextLimit) * 100), 100)
      : 0;

    const color = classifyBudgetColor(usedPercent);

    // Recent compression ratios (last 3 turns, oldest first)
    const recent = this._turns.slice(-3);
    const recentCompressionRatios = recent.map((t) => t.compressionRatio);
    // Pad to 3 entries with zeros if fewer turns recorded
    while (recentCompressionRatios.length < 3) recentCompressionRatios.unshift(0);

    // Runway: estimate turns remaining based on rolling avg tokens per turn
    const runwayTurns = this._computeRunwayTurns(contextLimit, cumulativeTotal);

    const overheadMultiplier = getBudgetAllocator().computeOverheadMultiplier();

    return {
      provider: this._provider,
      model: this._model,
      usedTokens: cumulativeTotal,
      contextLimit,
      usedPercent,
      color,
      recentCompressionRatios,
      runwayTurns,
      totalTurns: this._turnIndex,
      overheadMultiplier,
    };
  }

  /**
   * Get per-provider historical breakdown (for /budget status).
   */
  getProviderHistory(): ProviderHistoryEntry[] {
    const map = new Map<string, ProviderHistoryEntry>();

    for (const turn of this._turns) {
      const key = `${turn.provider}:${turn.model}`;
      const existing = map.get(key);
      if (existing) {
        existing.turns++;
        existing.totalTokens += turn.totalTokens;
        existing.avgTokensPerTurn = Math.round(existing.totalTokens / existing.turns);
        if (turn.fillRatio > existing.maxFillRatio) existing.maxFillRatio = turn.fillRatio;
        if (turn.compressionTier > 0) existing.compressionEvents++;
        existing.totalCompressionSaved += turn.compressionSaved;
      } else {
        map.set(key, {
          provider: turn.provider,
          model: turn.model,
          turns: 1,
          totalTokens: turn.totalTokens,
          avgTokensPerTurn: turn.totalTokens,
          maxFillRatio: turn.fillRatio,
          compressionEvents: turn.compressionTier > 0 ? 1 : 0,
          totalCompressionSaved: turn.compressionSaved,
        });
      }
    }

    return Array.from(map.values());
  }

  /**
   * Get all recorded turns in the rolling window (for /budget status history).
   */
  getTurns(): readonly TurnRecord[] {
    return this._turns;
  }

  /**
   * Format a 2-line header bar string for terminal display.
   *
   * Line 1: [Provider] [Used: XX% (YYK/ZZZ)] [Compress: A% B% C%] [Runway: NN turns]
   * Line 2: visual fill bar + color-coded status
   */
  formatHeaderBar(termWidth: number = 80): string {
    const snap = this.getSnapshot();
    return formatBudgetHeader(snap, termWidth);
  }

  /** Reset all session state (for testing). */
  reset(): void {
    this._turns = [];
    this._turnIndex = 0;
    this._provider = "unknown";
    this._model = "unknown";
    this._verboseLogPath = null;
    this._cumulativeInputTokens = 0;
    this._cumulativeOutputTokens = 0;
    this._cumulativeReasoningTokens = 0;
    getBudgetAllocator().reset();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _computeRunwayTurns(contextLimit: number, usedTokens: number): number {
    if (contextLimit <= 0) return 999;
    const remaining = contextLimit - usedTokens;
    if (remaining <= 0) return 0;

    // Rolling average tokens per turn from the window
    const avgPerTurn = this._computeAvgTokensPerTurn();
    if (avgPerTurn <= 0) return 999;

    return Math.max(0, Math.floor(remaining / avgPerTurn));
  }

  private _computeAvgTokensPerTurn(): number {
    if (this._turns.length === 0) return DEFAULT_TOKENS_PER_TURN;
    const total = this._turns.reduce((acc, t) => acc + t.totalTokens, 0);
    return Math.max(1, Math.round(total / this._turns.length));
  }

  private _writeVerboseLog(record: TurnRecord): void {
    if (!this._verboseLogPath) return;
    try {
      const allocator = getBudgetAllocator();
      const compressionLimits = allocator.getCompressionLimits("Bash", record.contextLimit);
      const snapshot = this.getSnapshot();
      const entry: BudgetLogEntry = {
        ...record,
        sessionId: this._sessionId,
        overheadMultiplier: allocator.computeOverheadMultiplier(),
        compressionLimits,
        snapshot: {
          provider: snapshot.provider,
          model: snapshot.model,
          usedTokens: snapshot.usedTokens,
          contextLimit: snapshot.contextLimit,
          usedPercent: snapshot.usedPercent,
          color: snapshot.color,
          runwayTurns: snapshot.runwayTurns,
          totalTurns: snapshot.totalTurns,
          overheadMultiplier: snapshot.overheadMultiplier,
        },
      };
      appendFileSync(this._verboseLogPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Non-fatal — best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing and UI use)
// ---------------------------------------------------------------------------

/** Classify a fill percentage into a color. */
export function classifyBudgetColor(percent: number): BudgetColor {
  if (percent < BUDGET_COLOR_GREEN_MAX) return "green";
  if (percent < BUDGET_COLOR_YELLOW_MAX) return "yellow";
  return "red";
}

/** Format a human-readable token count (e.g. "128K", "1.2M"). */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

/**
 * Format the 1-line header bar for terminal output.
 * Returns a plain string (callers can apply chalk colors).
 *
 * Format: [Provider] [Used: XX% (YYK/ZZZ)] [Compress: A% B% C%] [Runway: NN turns]
 */
export function formatBudgetHeader(snap: BudgetSnapshot, _termWidth: number = 80): string {
  const usedStr = `${snap.usedPercent}% (${formatTokenCount(snap.usedTokens)}/${formatTokenCount(snap.contextLimit)})`;
  const compressStr = snap.recentCompressionRatios.map((r) => `${r}%`).join(" ");
  const runwayStr = snap.runwayTurns >= 999 ? "∞" : `${snap.runwayTurns}`;
  const providerShort = snap.provider === "unknown" ? "?" : snap.provider;

  return (
    `[${providerShort}] ` +
    `[Used: ${usedStr}] ` +
    `[Compress: ${compressStr}] ` +
    `[Runway: ${runwayStr} turns]`
  );
}

/**
 * Build a verbose log file path for the current date.
 * ~/.ashlrcode/logs/budget-YYYY-MM-DD.jsonl
 */
export function buildVerboseLogPath(configDir: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(configDir, "logs", `budget-${dateStr}.jsonl`);
}

// ---------------------------------------------------------------------------
// Module-level singleton — shared across the session.
// ---------------------------------------------------------------------------

let _monitor: ContextBudgetMonitor | null = null;

/** Get (or lazily create) the module-level ContextBudgetMonitor singleton. */
export function getContextBudgetMonitor(): ContextBudgetMonitor {
  if (!_monitor) _monitor = new ContextBudgetMonitor();
  return _monitor;
}

/** Replace the module-level monitor (for testing). */
export function setContextBudgetMonitor(monitor: ContextBudgetMonitor): void {
  _monitor = monitor;
}
