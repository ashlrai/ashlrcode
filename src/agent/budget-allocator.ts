/**
 * budget-allocator.ts — Adaptive Context Budget Allocator
 *
 * Dynamically adjusts tool result compression thresholds at runtime based on:
 *   1. Provider-aware reasoning overhead (reasoning models consume 3-5x more tokens)
 *   2. Remaining budget in the current turn
 *   3. Tool result pattern (stack traces vs grep results get different budgets)
 *   4. Turn-level budget reservation (15% reserved for next-turn system prompt / genomic RAG)
 *
 * Usage:
 *   const allocator = new BudgetAllocator();
 *   allocator.recordUsage(usage);                        // called from onUsage()
 *   const limits = allocator.getCompressionLimits(toolName, totalContextTokens, usage);
 */

import type { TokenUsage } from "../providers/types.ts";
import {
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD,
} from "./tool-executor.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fraction of total context reserved for next-turn system prompt / genomic RAG. */
export const NEXT_TURN_RESERVE_FRACTION = 0.15;

/** Rolling window size for computing empirical reasoning overhead per model. */
export const OVERHEAD_WINDOW_SIZE = 20;

/**
 * Minimum reasoning overhead multiplier.  Below this value we treat the model
 * as "fast" and use default thresholds.
 */
export const MIN_OVERHEAD_MULTIPLIER = 1.0;

/**
 * Maximum clamped overhead multiplier.  Even at 10x reasoning we won't shrink
 * tool results to zero — this caps the penalty.
 */
export const MAX_OVERHEAD_MULTIPLIER = 5.0;

/** Tool patterns and their relative budget weights (higher = more budget). */
export const TOOL_BUDGET_WEIGHTS: Record<string, number> = {
  // Stack traces are dense but critical; give them extra room.
  Bash: 1.4,
  bash: 1.4,
  // Grep / search results can be very large; moderate budget.
  Grep: 1.2,
  grep: 1.2,
  // File reads may be huge; use default.
  Read: 1.0,
  read: 1.0,
  // Compact structured output; can afford less compression headroom.
  Write: 0.8,
  write: 0.8,
  Edit: 0.8,
  edit: 0.8,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressionLimits {
  /** Maximum verbatim bytes before summarisation kicks in. */
  maxBytes: number;
  /** Chunk size for each summarised segment. */
  chunkSummaryThreshold: number;
}

/** Single usage observation stored in the rolling window. */
interface UsageObservation {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

// ---------------------------------------------------------------------------
// BudgetAllocator
// ---------------------------------------------------------------------------

export class BudgetAllocator {
  /** Rolling window of recent usage observations for overhead calculation. */
  private _window: UsageObservation[] = [];

  /** Track the model key to allow per-model windows in the future. */
  private _modelKey: string = "default";

  /**
   * Record a usage event from a provider response.
   * Call this from AgentConfig.onUsage() in loop.ts.
   */
  recordUsage(usage: TokenUsage): void {
    const obs: UsageObservation = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    };
    this._window.push(obs);
    if (this._window.length > OVERHEAD_WINDOW_SIZE) {
      this._window.shift();
    }
  }

  /**
   * Set the current model key (provider:model string).
   * Used for display / future per-model windows.
   */
  setModelKey(modelKey: string): void {
    this._modelKey = modelKey;
  }

  /**
   * Compute the empirical reasoning overhead multiplier from the rolling window.
   *
   * Multiplier = avg(reasoningTokens) / avg(outputTokens) + 1.0
   * when the window has enough data.  Falls back to 1.0 for models with no
   * reasoning overhead.
   */
  computeOverheadMultiplier(): number {
    if (this._window.length === 0) return MIN_OVERHEAD_MULTIPLIER;

    let totalReasoning = 0;
    let totalOutput = 0;
    for (const obs of this._window) {
      totalReasoning += obs.reasoningTokens;
      totalOutput += obs.outputTokens;
    }

    if (totalOutput === 0) return MIN_OVERHEAD_MULTIPLIER;

    const ratio = totalReasoning / totalOutput;
    // Multiplier: 1.0 (no reasoning) → up to MAX_OVERHEAD_MULTIPLIER
    const multiplier = 1.0 + ratio;
    return Math.min(Math.max(multiplier, MIN_OVERHEAD_MULTIPLIER), MAX_OVERHEAD_MULTIPLIER);
  }

  /**
   * Compute the fraction of context remaining after reserving capacity for
   * the next turn's system prompt injection (genomic RAG).
   *
   * @param usedTokens   Tokens consumed so far in this turn.
   * @param totalContext Maximum context window size in tokens.
   * @returns A fraction in [0, 1] representing available budget.
   */
  remainingBudgetFraction(usedTokens: number, totalContext: number): number {
    if (totalContext <= 0) return 1.0;
    const reserved = Math.ceil(totalContext * NEXT_TURN_RESERVE_FRACTION);
    const available = totalContext - reserved;
    const remaining = available - usedTokens;
    if (remaining <= 0) return 0;
    return Math.min(remaining / available, 1.0);
  }

  /**
   * Get the tool-pattern budget weight for a given tool name.
   * Defaults to 1.0 for unknown tools.
   */
  toolBudgetWeight(toolName: string): number {
    return TOOL_BUDGET_WEIGHTS[toolName] ?? 1.0;
  }

  /**
   * Compute dynamic compression limits for a tool result.
   *
   * Algorithm:
   *   base = DEFAULT limits
   *   scale by (1 / overheadMultiplier)     — reasoning models get tighter limits
   *   scale by remainingBudgetFraction       — shrink further when context is tight
   *   scale by toolBudgetWeight(toolName)    — give more room to high-value tools
   *   clamp to sensible min/max ranges
   *
   * @param toolName      Name of the tool being executed.
   * @param totalContext  Total context window tokens (0 = unlimited / unknown).
   * @param usage         Latest usage snapshot (optional; falls back to window).
   */
  getCompressionLimits(
    toolName: string,
    totalContext: number = 0,
    usage?: TokenUsage
  ): CompressionLimits {
    // Incorporate latest usage event into the window before computing limits.
    if (usage) this.recordUsage(usage);

    const overhead = this.computeOverheadMultiplier();

    // Estimate tokens used so far (sum of input + output + reasoning in window).
    const usedTokens = this._window.reduce(
      (acc, obs) => acc + obs.inputTokens + obs.outputTokens + obs.reasoningTokens,
      0
    );

    const budgetFraction = this.remainingBudgetFraction(usedTokens, totalContext);
    const toolWeight = this.toolBudgetWeight(toolName);

    // Combined scale: inversely proportional to overhead, proportional to
    // remaining budget and tool weight.
    const scale = (budgetFraction * toolWeight) / overhead;

    const rawMaxBytes = DEFAULT_TOOL_RESULT_MAX_BYTES * scale;
    const rawChunkSize = DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD * scale;

    // Clamp maxBytes: floor at 1 KB (always give at least something), cap at
    // 2x default (no point expanding beyond what static limits allow without
    // explicit configuration).
    const maxBytes = Math.round(
      Math.max(1_024, Math.min(rawMaxBytes, DEFAULT_TOOL_RESULT_MAX_BYTES * 2))
    );

    // Clamp chunkSummaryThreshold: floor at 256 bytes, cap at 2x default.
    const chunkSummaryThreshold = Math.round(
      Math.max(256, Math.min(rawChunkSize, DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD * 2))
    );

    return { maxBytes, chunkSummaryThreshold };
  }

  /** Reset all state (for testing). */
  reset(): void {
    this._window = [];
    this._modelKey = "default";
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — shared across the agent loop in a session.
// ---------------------------------------------------------------------------

let _allocator: BudgetAllocator | null = null;

/** Get (or lazily create) the module-level BudgetAllocator singleton. */
export function getBudgetAllocator(): BudgetAllocator {
  if (!_allocator) _allocator = new BudgetAllocator();
  return _allocator;
}

/** Replace the module-level allocator (for testing). */
export function setBudgetAllocator(allocator: BudgetAllocator): void {
  _allocator = allocator;
}
