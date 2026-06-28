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
