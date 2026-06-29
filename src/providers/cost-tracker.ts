/**
 * cost-tracker.ts — thin shim over @ashlr/cost.
 *
 * Re-exports all public types from the canonical package and extends
 * CostTracker with the `totalTokens` object getter that ashlrcode tests and
 * legacy callers depend on (removed upstream in favour of scalar getters).
 */

export {
  type ProviderCostEntry,
  type BudgetAlert as BudgetWarning,
  type TokenUsage as TokenUsageTotals,
} from "@ashlr/cost";

import { CostTracker as _BaseCostTracker, type TokenUsage } from "@ashlr/cost";

/**
 * CostTracker — wraps @ashlr/cost's CostTracker and adds the legacy
 * `totalTokens` object getter for backward compatibility.
 */
export class CostTracker extends _BaseCostTracker {
  /** @deprecated Use totalInputTokens / totalOutputTokens / totalReasoningTokens. */
  get totalTokens(): Required<TokenUsage> {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      reasoningTokens: this.totalReasoningTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Cost type used by pre-flight estimation
// ---------------------------------------------------------------------------

export interface Cost {
  /** Total cost in USD */
  totalCostUSD: number;
  /** Total tokens consumed (input + output + reasoning) */
  totalTokens: number;
  /** Number of LLM turns recorded */
  turns: number;
}

/**
 * Compute a historical average cost per agent turn from a CostTracker snapshot.
 *
 * This is called by `/estimate` to seed the cost projector with real data from
 * past sessions when available.  The `goal` parameter is reserved for future
 * per-goal classification (currently unused — we return the session aggregate).
 *
 * Returns `undefined` when no turns have been recorded yet (cold start).
 */
export function historicalAverageCost(_goal: string, tracker: CostTracker): Cost | undefined {
  const breakdown = tracker.getBreakdown();
  if (breakdown.length === 0) return undefined;

  const totalCalls = breakdown.reduce((sum, e) => sum + e.calls, 0);
  if (totalCalls === 0) return undefined;

  const totalCostUSD = tracker.totalCostUSD;
  const totalTokens =
    tracker.totalInputTokens + tracker.totalOutputTokens + tracker.totalReasoningTokens;

  return {
    totalCostUSD,
    totalTokens,
    turns: totalCalls,
  };
}
