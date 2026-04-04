/**
 * Detailed cost tracking — per-provider, per-model pricing with reasoning tokens.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  reasoningPerMillion?: number; // Some models charge extra for reasoning tokens
}

// Pricing tables (USD per million tokens)
const PRICING: Record<string, ModelPricing> = {
  // xAI
  "grok-4-1-fast-reasoning": {
    inputPerMillion: 0.2,
    outputPerMillion: 0.5,
  },
  "grok-4-0314": { inputPerMillion: 2.0, outputPerMillion: 4.0 },
  "grok-3-fast": { inputPerMillion: 0.1, outputPerMillion: 0.3 },
  // Anthropic
  "claude-opus-4-6-20250514": {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
  },
  "claude-sonnet-4-6-20250514": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
  },
  // OpenAI
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  o1: {
    inputPerMillion: 15.0,
    outputPerMillion: 60.0,
    reasoningPerMillion: 60.0,
  },
  "o1-mini": {
    inputPerMillion: 3.0,
    outputPerMillion: 12.0,
    reasoningPerMillion: 12.0,
  },
  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek-reasoner": {
    inputPerMillion: 0.55,
    outputPerMillion: 2.19,
    reasoningPerMillion: 2.19,
  },
  // Groq (free tier, nominal costs)
  "llama-3.3-70b-versatile": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  // Local (Ollama) — all free
  "llama3.2": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "llama3.1": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "llama3": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "codellama": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "mistral": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "mixtral": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "deepseek-coder": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "deepseek-coder-v2": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "qwen2.5-coder": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "qwen2.5": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "phi3": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "gemma2": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  "starcoder2": { inputPerMillion: 0.0, outputPerMillion: 0.0 },
};

function getPricing(model: string): ModelPricing {
  // Exact match first
  if (PRICING[model]) return PRICING[model];
  // Partial match (model might have date suffix)
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  // Unknown model — assume moderate pricing
  return { inputPerMillion: 1.0, outputPerMillion: 3.0 };
}

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ProviderCostEntry {
  provider: string;
  model: string;
  usage: TokenUsageTotals;
  costUSD: number;
  calls: number;
}

export type BudgetWarning = {
  level: "warning" | "critical" | "exceeded";
  message: string;
  percentUsed: number;
};

export class CostTracker {
  private entries = new Map<string, ProviderCostEntry>();
  /** Maximum cost in USD. Infinity = no limit. */
  budgetUSD: number = Infinity;
  /** Callback fired when budget thresholds are crossed */
  onBudgetWarning?: (warning: BudgetWarning) => void;
  private _lastWarningLevel: BudgetWarning["level"] | null = null;

  /** Record token usage for a single API call */
  record(
    provider: string,
    model: string,
    usage: Partial<TokenUsageTotals>
  ): void {
    const key = `${provider}:${model}`;
    const existing = this.entries.get(key) ?? {
      provider,
      model,
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      costUSD: 0,
      calls: 0,
    };

    existing.usage.inputTokens += usage.inputTokens ?? 0;
    existing.usage.outputTokens += usage.outputTokens ?? 0;
    existing.usage.reasoningTokens += usage.reasoningTokens ?? 0;
    existing.calls++;

    // Recalculate cost from totals to avoid floating-point drift
    const pricing = getPricing(model);
    existing.costUSD =
      (existing.usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
      (existing.usage.outputTokens / 1_000_000) * pricing.outputPerMillion +
      (existing.usage.reasoningTokens / 1_000_000) *
        (pricing.reasoningPerMillion ?? pricing.outputPerMillion);

    this.entries.set(key, existing);

    // Check budget thresholds
    this._checkBudget();
  }

  /** Check if budget has been exceeded */
  isBudgetExceeded(): boolean {
    return this.budgetUSD !== Infinity && this.totalCostUSD >= this.budgetUSD;
  }

  /** Get percentage of budget used */
  getBudgetPercent(): number {
    if (this.budgetUSD === Infinity) return 0;
    return (this.totalCostUSD / this.budgetUSD) * 100;
  }

  private _checkBudget(): void {
    if (this.budgetUSD === Infinity || !this.onBudgetWarning) return;

    const percent = this.getBudgetPercent();

    if (percent >= 100 && this._lastWarningLevel !== "exceeded") {
      this._lastWarningLevel = "exceeded";
      this.onBudgetWarning({
        level: "exceeded",
        message: `Budget exceeded: $${this.totalCostUSD.toFixed(4)} / $${this.budgetUSD.toFixed(2)} (${percent.toFixed(0)}%)`,
        percentUsed: percent,
      });
    } else if (percent >= 90 && this._lastWarningLevel !== "critical" && this._lastWarningLevel !== "exceeded") {
      this._lastWarningLevel = "critical";
      this.onBudgetWarning({
        level: "critical",
        message: `90% of budget used: $${this.totalCostUSD.toFixed(4)} / $${this.budgetUSD.toFixed(2)}`,
        percentUsed: percent,
      });
    } else if (percent >= 75 && this._lastWarningLevel === null) {
      this._lastWarningLevel = "warning";
      this.onBudgetWarning({
        level: "warning",
        message: `75% of budget used: $${this.totalCostUSD.toFixed(4)} / $${this.budgetUSD.toFixed(2)}`,
        percentUsed: percent,
      });
    }
  }

  /** Get total cost across all providers */
  get totalCostUSD(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.costUSD;
    return total;
  }

  /** Get total tokens */
  get totalTokens(): TokenUsageTotals {
    const total: TokenUsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    for (const entry of this.entries.values()) {
      total.inputTokens += entry.usage.inputTokens;
      total.outputTokens += entry.usage.outputTokens;
      total.reasoningTokens += entry.usage.reasoningTokens;
    }
    return total;
  }

  /** Get per-provider breakdown */
  getBreakdown(): ProviderCostEntry[] {
    return Array.from(this.entries.values());
  }

  /** Format a detailed cost summary */
  formatSummary(): string {
    const total = this.totalTokens;
    const entries = this.getBreakdown();

    const budgetStr = this.budgetUSD !== Infinity
      ? ` / $${this.budgetUSD.toFixed(2)} budget (${this.getBudgetPercent().toFixed(0)}%)`
      : "";
    const lines: string[] = [`Cost: $${this.totalCostUSD.toFixed(4)}${budgetStr}`];
    lines.push(
      `Tokens: ${formatTokens(total.inputTokens)} in / ${formatTokens(total.outputTokens)} out${total.reasoningTokens > 0 ? ` / ${formatTokens(total.reasoningTokens)} reasoning` : ""}`
    );

    if (entries.length > 1) {
      lines.push("Per provider:");
      for (const e of entries) {
        lines.push(
          `  ${e.provider}:${e.model} — $${e.costUSD.toFixed(4)} (${e.calls} calls)`
        );
      }
    }

    return lines.join("\n");
  }

  // ── Legacy compat: expose the same shape the old CostTracker interface had ──

  get totalInputTokens(): number {
    return this.totalTokens.inputTokens;
  }
  get totalOutputTokens(): number {
    return this.totalTokens.outputTokens;
  }
  get totalReasoningTokens(): number {
    return this.totalTokens.reasoningTokens;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}
