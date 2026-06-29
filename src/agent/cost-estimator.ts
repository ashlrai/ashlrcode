/**
 * cost-estimator.ts — LLM-lite pre-flight cost projector.
 *
 * Analyzes a goal string for complexity signals, maps to historical agent turn
 * costs, and returns a structured estimate with provider alternatives.
 *
 * Design goals:
 *  - Zero network calls (pure heuristic, sub-millisecond)
 *  - Deterministic for the same goal + history snapshot
 *  - Result cached for 5 minutes to avoid re-scoring the same goal
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderEstimate {
  provider: string;
  model: string;
  /** Total estimated cost in USD */
  costUSD: number;
  /** Estimated wall-clock turns (round-trips to the LLM) */
  turnsNeeded: number;
  /** Relative speed label */
  speed: "fast" | "balanced" | "slow";
}

export interface CostEstimate {
  /** Estimated total tokens across all turns */
  estimatedTokens: number;
  /** Cost for the *default* provider */
  costUSD: number;
  /** Estimated turns for the default provider */
  turnsNeeded: number;
  /** True when the estimate fits within the active --max-cost budget */
  budgetOK: boolean;
  /** Ordered list of provider alternatives (cheapest first) */
  alternativeProviders: ProviderEstimate[];
  /** Human-readable breakdown of the complexity signals detected */
  complexityBreakdown: string[];
  /** Numeric complexity score (1.0 = baseline) */
  complexityScore: number;
}

// ---------------------------------------------------------------------------
// Provider rate table (per-million tokens, USD)
// Keep in sync with @ashlr/cost pricing — these are read-only estimates.
// ---------------------------------------------------------------------------

interface ProviderRates {
  provider: string;
  model: string;
  inputPerM: number;
  outputPerM: number;
  speed: "fast" | "balanced" | "slow";
}

export const PROVIDER_RATE_TABLE: ProviderRates[] = [
  { provider: "xai",       model: "grok-3-fast",              inputPerM: 0.1,  outputPerM: 0.3,  speed: "fast" },
  { provider: "xai",       model: "grok-4-0314",              inputPerM: 2.0,  outputPerM: 10.0, speed: "balanced" },
  { provider: "anthropic", model: "claude-sonnet-4-6-20250514", inputPerM: 3.0, outputPerM: 15.0, speed: "balanced" },
  { provider: "anthropic", model: "claude-opus-4-6-20250514",  inputPerM: 15.0, outputPerM: 75.0, speed: "slow" },
  { provider: "deepseek",  model: "deepseek-chat",             inputPerM: 0.14, outputPerM: 0.28, speed: "fast" },
  { provider: "deepseek",  model: "deepseek-reasoner",         inputPerM: 0.55, outputPerM: 2.19, speed: "balanced" },
  { provider: "openai",    model: "gpt-4o",                    inputPerM: 2.5,  outputPerM: 10.0, speed: "balanced" },
  { provider: "openai",    model: "gpt-4o-mini",               inputPerM: 0.15, outputPerM: 0.6,  speed: "fast" },
];

// ---------------------------------------------------------------------------
// Complexity signal weights
// ---------------------------------------------------------------------------

/** Multiplier applied per keyword match (stacks multiplicatively) */
export const KEYWORD_MULTIPLIERS: Record<string, number> = {
  // High-complexity operations
  refactor: 2.5,
  rewrite: 2.5,
  migrate: 2.2,
  redesign: 2.0,
  architecture: 2.0,
  // Medium-complexity
  test: 1.4,
  tests: 1.4,
  spec: 1.4,
  debug: 1.6,
  fix: 1.3,
  optimize: 1.5,
  performance: 1.5,
  security: 1.7,
  // Scope expanders
  all: 1.3,
  entire: 1.4,
  every: 1.3,
  // Qualifiers
  "with tests": 1.4,
  "and tests": 1.4,
  "add tests": 1.4,
  "including tests": 1.4,
  // Low-complexity
  rename: 0.6,
  typo: 0.4,
  comment: 0.5,
  format: 0.5,
  lint: 0.5,
};

/** Base tokens per turn for a "normal" task */
export const BASE_TOKENS_PER_TURN = 8_000;

/** Base number of turns for a "normal" task */
export const BASE_TURNS = 4;

/** Token overhead per detected file (estimated from codebase scan cost) */
export const TOKENS_PER_FILE = 700;

// ---------------------------------------------------------------------------
// Cache (5-minute TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  estimate: CostEstimate;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const estimateCache = new Map<string, CacheEntry>();

function cacheGet(key: string): CostEstimate | undefined {
  const entry = estimateCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    estimateCache.delete(key);
    return undefined;
  }
  return entry.estimate;
}

function cacheSet(key: string, estimate: CostEstimate): void {
  estimateCache.set(key, { estimate, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Exposed for testing — clears the in-process estimate cache. */
export function clearEstimateCache(): void {
  estimateCache.clear();
}

/** Returns number of entries currently in the cache (including expired ones). */
export function getEstimateCacheSize(): number {
  return estimateCache.size;
}

// ---------------------------------------------------------------------------
// Complexity analysis
// ---------------------------------------------------------------------------

export interface ComplexityResult {
  score: number;
  signals: string[];
  estimatedFileCount: number;
}

/**
 * Analyze goal text for complexity signals.
 * Returns a multiplicative score (1.0 = baseline).
 */
export function analyzeGoalComplexity(goal: string): ComplexityResult {
  const lower = goal.toLowerCase();
  const signals: string[] = [];
  let score = 1.0;

  // Check multi-word phrases first (order matters — longest first)
  const phrases = ["with tests", "and tests", "add tests", "including tests"];
  for (const phrase of phrases) {
    if (lower.includes(phrase)) {
      const m = KEYWORD_MULTIPLIERS[phrase]!;
      score *= m;
      signals.push(`"${phrase}" (+${Math.round((m - 1) * 100)}%)`);
    }
  }

  // Single-word keywords (skip if already matched as phrase)
  const words = lower.split(/\W+/).filter(Boolean);
  for (const word of words) {
    if (word in KEYWORD_MULTIPLIERS && !phrases.some((p) => p.includes(word) && lower.includes(p))) {
      const m = KEYWORD_MULTIPLIERS[word]!;
      score *= m;
      signals.push(`"${word}" (×${m.toFixed(1)})`);
    }
  }

  // Heuristic file count from goal (numbers that could be file references)
  let estimatedFileCount = 0;
  const fileCountMatch = lower.match(/(\d+)\s*file/);
  if (fileCountMatch) {
    estimatedFileCount = parseInt(fileCountMatch[1]!, 10);
    signals.push(`${estimatedFileCount} files mentioned`);
  }

  // Module/component keywords suggest multi-file scope
  const moduleKeywords = ["module", "component", "service", "controller", "middleware", "plugin", "package"];
  for (const kw of moduleKeywords) {
    if (lower.includes(kw)) {
      estimatedFileCount = Math.max(estimatedFileCount, 8);
      signals.push(`"${kw}" → ~8 files`);
      break;
    }
  }

  // Auth/payment/core keywords imply larger scope
  const coreKeywords = ["auth", "authentication", "payment", "database", "migration", "schema"];
  for (const kw of coreKeywords) {
    if (lower.includes(kw)) {
      estimatedFileCount = Math.max(estimatedFileCount, 12);
      signals.push(`"${kw}" → ~12 files`);
      break;
    }
  }

  // Clamp score between 0.3 and 10.0
  score = Math.max(0.3, Math.min(10.0, score));

  return { score, signals, estimatedFileCount };
}

// ---------------------------------------------------------------------------
// Turn / token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate turns and tokens from a complexity score + file count.
 */
export function estimateTurnsAndTokens(
  score: number,
  fileCount: number,
  historicalAvgCostPerTurn?: number,
): { turns: number; tokens: number } {
  const turns = Math.max(1, Math.round(BASE_TURNS * score));
  const fileTokens = fileCount * TOKENS_PER_FILE;
  const baseTokens = Math.round(BASE_TOKENS_PER_TURN * score * turns);
  const tokens = baseTokens + fileTokens;
  return { turns, tokens };
}

// ---------------------------------------------------------------------------
// Provider cost calculation
// ---------------------------------------------------------------------------

function costForTokens(tokens: number, rates: ProviderRates): number {
  // Assume 60% of tokens are input, 40% output (typical agent pattern)
  const inputTokens = tokens * 0.6;
  const outputTokens = tokens * 0.4;
  return (inputTokens / 1_000_000) * rates.inputPerM + (outputTokens / 1_000_000) * rates.outputPerM;
}

// ---------------------------------------------------------------------------
// Main estimator
// ---------------------------------------------------------------------------

export interface EstimateOptions {
  /** Maximum cost budget (from --max-cost flag). If undefined, no budget check. */
  maxCostUSD?: number;
  /** Default provider name to use as the primary estimate */
  defaultProvider?: string;
  /** Historical average cost per turn for the default provider (from cost-tracker) */
  historicalAvgCostPerTurn?: number;
}

/**
 * Project the cost of running agents for a given goal.
 *
 * Results are cached for 5 minutes — same goal + same maxCost returns the
 * cached estimate without re-scoring.
 */
export function estimateGoalCost(goal: string, options: EstimateOptions = {}): CostEstimate {
  if (!goal || !goal.trim()) {
    return {
      estimatedTokens: 0,
      costUSD: 0,
      turnsNeeded: 0,
      budgetOK: true,
      alternativeProviders: [],
      complexityBreakdown: ["(empty goal)"],
      complexityScore: 0,
    };
  }

  const cacheKey = `${goal.trim().toLowerCase()}::${options.maxCostUSD ?? ""}::${options.defaultProvider ?? ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { score, signals, estimatedFileCount } = analyzeGoalComplexity(goal);
  const { turns, tokens } = estimateTurnsAndTokens(score, estimatedFileCount, options.historicalAvgCostPerTurn);

  // Find the default provider rates
  const defaultProviderName = options.defaultProvider ?? "xai";
  const defaultRates =
    PROVIDER_RATE_TABLE.find((r) => r.provider === defaultProviderName) ?? PROVIDER_RATE_TABLE[0]!;

  const costUSD = costForTokens(tokens, defaultRates);

  const budgetOK = options.maxCostUSD === undefined ? true : costUSD <= options.maxCostUSD;

  // Build all provider alternatives, cheapest first
  const alternativeProviders: ProviderEstimate[] = PROVIDER_RATE_TABLE.map((rates) => ({
    provider: rates.provider,
    model: rates.model,
    costUSD: costForTokens(tokens, rates),
    turnsNeeded: turns,
    speed: rates.speed,
  })).sort((a, b) => a.costUSD - b.costUSD);

  const estimate: CostEstimate = {
    estimatedTokens: tokens,
    costUSD,
    turnsNeeded: turns,
    budgetOK,
    alternativeProviders,
    complexityBreakdown: signals.length > 0 ? signals : ["(no complexity signals detected — baseline)"],
    complexityScore: score,
  };

  cacheSet(cacheKey, estimate);
  return estimate;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function padR(s: string, n: number): string {
  return s.padEnd(n);
}
function padL(s: string, n: number): string {
  return s.padStart(n);
}

function fmtCost(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Format a CostEstimate as a readable multi-line table.
 */
export function formatCostEstimate(goal: string, estimate: CostEstimate, maxCostUSD?: number): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`  Pre-flight Estimate: "${goal.slice(0, 70)}${goal.length > 70 ? "..." : ""}"`);
  lines.push("");

  // Complexity breakdown
  lines.push(`  Complexity score: ${estimate.complexityScore.toFixed(2)}x`);
  for (const sig of estimate.complexityBreakdown) {
    lines.push(`    · ${sig}`);
  }
  lines.push(`  Estimated tokens:  ${fmtTokens(estimate.estimatedTokens)}`);
  lines.push(`  Estimated turns:   ${estimate.turnsNeeded}`);
  lines.push("");

  // Provider table
  lines.push("  " + padR("Provider", 12) + padR("Model", 28) + padL("Est. Cost", 12) + padL("Turns", 7) + padL("Speed", 10));
  lines.push("  " + "-".repeat(69));

  for (const p of estimate.alternativeProviders) {
    const badge = p.provider === "xai" ? " (default)" : "";
    lines.push(
      "  " +
        padR(p.provider + badge, 12) +
        padR(p.model.slice(0, 27), 28) +
        padL(fmtCost(p.costUSD), 12) +
        padL(String(p.turnsNeeded), 7) +
        padL(p.speed, 10),
    );
  }

  lines.push("");

  // Budget check
  if (maxCostUSD !== undefined) {
    if (estimate.budgetOK) {
      lines.push(`  Budget: ${fmtCost(estimate.costUSD)} / ${fmtCost(maxCostUSD)} — OK`);
    } else {
      lines.push(`  Budget: ${fmtCost(estimate.costUSD)} EXCEEDS limit of ${fmtCost(maxCostUSD)}`);
      // Find cheapest provider within budget
      const affordable = estimate.alternativeProviders.filter((p) => p.costUSD <= maxCostUSD);
      if (affordable.length > 0) {
        const best = affordable[0]!;
        lines.push(`  Tip: switch to ${best.provider}/${best.model} → ${fmtCost(best.costUSD)} (within budget)`);
      } else {
        lines.push("  Tip: no configured provider fits this budget — consider splitting the goal into smaller tasks.");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
