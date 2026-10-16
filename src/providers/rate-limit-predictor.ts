/**
 * rate-limit-predictor.ts — Multi-provider rate limit & quota prediction engine.
 *
 * Learns per-provider request/token patterns via sliding-window histograms and
 * predicts rate-limit or quota exhaustion BEFORE it occurs. When prediction
 * confidence exceeds 70%, the predictor emits a recommendation to delay or
 * switch providers, giving the router a chance to act proactively rather than
 * reactively.
 *
 * Prediction model is persisted to ~/.ashlrcode/rate-limit-models.json and
 * loaded on startup so learning carries across sessions.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ── Constants ──────────────────────────────────────────────────────────────

const MODELS_DIR = join(homedir(), ".ashlrcode");
const MODELS_PATH = join(MODELS_DIR, "rate-limit-models.json");

/** Sliding-window duration (ms) used for velocity calculations. */
const WINDOW_MS = 60_000; // 1 minute

/** Number of histogram buckets for token-velocity distribution. */
const HISTOGRAM_BUCKETS = 20;

/** Maximum bucket range for tokens per request (for histogram scaling). */
const MAX_TOKENS_PER_REQUEST = 100_000;

/** Confidence threshold (0–1) above which the predictor recommends action. */
export const CONFIDENCE_THRESHOLD = 0.7;

/** Suggested proactive delay (ms) when rate-limit risk is predicted. */
export const PROACTIVE_DELAY_MS = 2_000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface RateLimitEvent {
  /** Unix timestamp (ms) */
  ts: number;
  /** Total tokens consumed in this request */
  tokens: number;
  /** Whether this request actually received a rate-limit error */
  wasRateLimited: boolean;
}

/**
 * Sliding-window histogram model for a single provider.
 * All fields are JSON-serialisable for persistence.
 */
export interface ProviderModel {
  /** Provider name / identifier */
  provider: string;
  /** Circular buffer of recent events (capped at 500) */
  events: RateLimitEvent[];
  /** Token-count frequency histogram over all recorded requests */
  tokenHistogram: number[];
  /** Total number of rate-limit errors recorded */
  rateLimitCount: number;
  /** Total number of requests recorded */
  requestCount: number;
  /** Timestamp of last observed quota reset (ms), or 0 if unknown */
  lastQuotaReset: number;
  /** Estimated quota reset interval (ms), or 0 if unknown */
  estimatedResetIntervalMs: number;
  /** Running sum of tokens within current window (for fast velocity calc) */
  windowTokenSum: number;
  /** Timestamp of the oldest event in the current window */
  windowStart: number;
}

export type PredictionAction = "proceed" | "delay" | "switch_provider";

export interface PredictionResult {
  action: PredictionAction;
  confidence: number;
  /** Suggested delay in ms if action === "delay" */
  delayMs?: number;
  /** Human-readable reason */
  reason: string;
  /** Estimated ms until next quota reset, if known */
  msUntilReset?: number;
}

// ── Serialised store ───────────────────────────────────────────────────────

interface ModelStore {
  version: 1;
  models: Record<string, ProviderModel>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyModel(provider: string): ProviderModel {
  return {
    provider,
    events: [],
    tokenHistogram: new Array<number>(HISTOGRAM_BUCKETS).fill(0),
    rateLimitCount: 0,
    requestCount: 0,
    lastQuotaReset: 0,
    estimatedResetIntervalMs: 0,
    windowTokenSum: 0,
    windowStart: Date.now(),
  };
}

function bucketIndex(tokens: number): number {
  const ratio = Math.min(tokens / MAX_TOKENS_PER_REQUEST, 1);
  return Math.min(Math.floor(ratio * HISTOGRAM_BUCKETS), HISTOGRAM_BUCKETS - 1);
}

/** Prune events older than WINDOW_MS and recompute windowTokenSum. */
function pruneWindow(model: ProviderModel, now: number): void {
  const cutoff = now - WINDOW_MS;
  let pruned = false;
  while (model.events.length > 0 && model.events[0]!.ts < cutoff) {
    const evicted = model.events.shift()!;
    model.windowTokenSum = Math.max(0, model.windowTokenSum - evicted.tokens);
    pruned = true;
  }
  if (pruned || model.windowStart < cutoff) {
    model.windowStart = model.events.length > 0 ? model.events[0]!.ts : now;
  }
}

/** Requests per second within the sliding window. */
function requestVelocity(model: ProviderModel, now: number): number {
  pruneWindow(model, now);
  const windowDurationMs = Math.max(now - model.windowStart, 1);
  return (model.events.length / windowDurationMs) * 1000;
}

/** Tokens per second within the sliding window. */
function tokenVelocity(model: ProviderModel, now: number): number {
  pruneWindow(model, now);
  const windowDurationMs = Math.max(now - model.windowStart, 1);
  return (model.windowTokenSum / windowDurationMs) * 1000;
}

/**
 * Historical rate-limit rate: proportion of past requests that were rate-limited.
 * Uses a recency-weighted count (events in window weighted 2×).
 */
function rateLimitRate(model: ProviderModel, now: number): number {
  if (model.requestCount === 0) return 0;
  pruneWindow(model, now);
  const recentRLCount = model.events.filter((e) => e.wasRateLimited).length;
  const recentTotal = model.events.length;
  // Blend historical + recency
  const historicalRate = model.rateLimitCount / model.requestCount;
  const recentRate = recentTotal > 0 ? recentRLCount / recentTotal : 0;
  return historicalRate * 0.4 + recentRate * 0.6;
}

/**
 * Typical (median) tokens per request derived from the histogram.
 */
function medianTokensPerRequest(model: ProviderModel): number {
  const total = model.tokenHistogram.reduce((s, c) => s + c, 0);
  if (total === 0) return 0;
  let cumulative = 0;
  const half = total / 2;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    cumulative += model.tokenHistogram[i]!;
    if (cumulative >= half) {
      // Midpoint of bucket i
      const bucketWidth = MAX_TOKENS_PER_REQUEST / HISTOGRAM_BUCKETS;
      return (i + 0.5) * bucketWidth;
    }
  }
  return MAX_TOKENS_PER_REQUEST;
}

// ── Core class ─────────────────────────────────────────────────────────────

/**
 * RateLimitPredictor — learns per-provider usage patterns and predicts when
 * rate limits or quota walls will be reached before they occur.
 *
 * Usage:
 *   const predictor = new RateLimitPredictor();
 *   await predictor.load();
 *
 *   // Before each request:
 *   const result = predictor.predict("anthropic", estimatedTokens);
 *   if (result.action === "delay") await sleep(result.delayMs!);
 *
 *   // After each request:
 *   predictor.record("anthropic", tokensUsed, wasRateLimited);
 *   await predictor.save(); // optional — called automatically every 10 records
 */
export class RateLimitPredictor {
  private models = new Map<string, ProviderModel>();
  private recordsSinceLastSave = 0;
  private readonly autosaveInterval: number;

  /**
   * @param autosaveInterval Save to disk every N records (default 10).
   *   Pass Infinity to disable auto-save (tests typically do this).
   */
  constructor(autosaveInterval = 10) {
    this.autosaveInterval = autosaveInterval;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Load models from ~/.ashlrcode/rate-limit-models.json (no-op if absent). */
  load(): void {
    try {
      if (!existsSync(MODELS_PATH)) return;
      const raw = readFileSync(MODELS_PATH, "utf8");
      const store = JSON.parse(raw) as ModelStore;
      if (store.version !== 1) return;
      for (const [provider, model] of Object.entries(store.models)) {
        // Ensure histogram array has correct length (guard against schema drift)
        if (!Array.isArray(model.tokenHistogram) || model.tokenHistogram.length !== HISTOGRAM_BUCKETS) {
          model.tokenHistogram = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
        }
        if (!Array.isArray(model.events)) model.events = [];
        this.models.set(provider, model);
      }
    } catch {
      // Corrupt or unreadable — start fresh
      this.models.clear();
    }
  }

  /** Persist current models to disk. Creates directory if needed. */
  save(): void {
    try {
      if (!existsSync(MODELS_DIR)) {
        mkdirSync(MODELS_DIR, { recursive: true });
      }
      const store: ModelStore = {
        version: 1,
        models: Object.fromEntries(this.models.entries()),
      };
      writeFileSync(MODELS_PATH, JSON.stringify(store, null, 2), "utf8");
    } catch {
      // Non-fatal: prediction still works without persistence
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Record a completed request for a provider.
   *
   * @param provider     Provider name (e.g. "anthropic", "xai")
   * @param tokens       Actual tokens consumed
   * @param wasRateLimited Whether the request received a 429 / quota error
   */
  record(provider: string, tokens: number, wasRateLimited: boolean): void {
    const model = this.getOrCreate(provider);
    const now = Date.now();

    const event: RateLimitEvent = { ts: now, tokens, wasRateLimited };
    model.events.push(event);
    model.windowTokenSum += tokens;
    model.requestCount++;
    if (wasRateLimited) {
      model.rateLimitCount++;
      // If we know the previous quota reset time, update the estimate
      if (model.lastQuotaReset > 0) {
        const gap = now - model.lastQuotaReset;
        model.estimatedResetIntervalMs =
          model.estimatedResetIntervalMs === 0
            ? gap
            : Math.round(model.estimatedResetIntervalMs * 0.7 + gap * 0.3);
      }
      model.lastQuotaReset = now;
    }

    // Update histogram
    model.tokenHistogram[bucketIndex(tokens)]!++;

    // Cap event buffer at 500
    if (model.events.length > 500) {
      const evicted = model.events.shift()!;
      model.windowTokenSum = Math.max(0, model.windowTokenSum - evicted.tokens);
    }

    // Auto-save
    this.recordsSinceLastSave++;
    if (this.recordsSinceLastSave >= this.autosaveInterval) {
      this.save();
      this.recordsSinceLastSave = 0;
    }
  }

  /**
   * Predict whether the next request to `provider` risks hitting a rate limit
   * or quota wall, given an estimated token count for the upcoming request.
   *
   * Returns a PredictionResult with:
   *   - action: "proceed" | "delay" | "switch_provider"
   *   - confidence: 0–1
   *   - delayMs: suggested wait if action === "delay"
   *   - reason: human-readable explanation
   */
  predict(provider: string, estimatedTokens = 0): PredictionResult {
    const model = this.models.get(provider);
    if (!model || model.requestCount < 3) {
      // Not enough data — proceed
      return { action: "proceed", confidence: 0, reason: "Insufficient history" };
    }

    const now = Date.now();
    pruneWindow(model, now);

    const rqVel = requestVelocity(model, now); // req/s
    const tkVel = tokenVelocity(model, now);   // tokens/s
    const rlRate = rateLimitRate(model, now);   // 0–1
    const medTokens = medianTokensPerRequest(model);

    // ── Signal 1: historical rate-limit rate ──────────────────────────────
    // If >30% of past requests have been rate-limited, that's a strong signal.
    const rlSignal = Math.min(rlRate / 0.3, 1);

    // ── Signal 2: high request velocity ──────────────────────────────────
    // Heuristic: >2 req/s sustained is aggressive for most LLM providers.
    const rqSignal = Math.min(rqVel / 2, 1);

    // ── Signal 3: high token velocity ────────────────────────────────────
    // Heuristic: >50k tokens/s is near-quota for typical minute limits.
    const tkSignal = Math.min(tkVel / 50_000, 1);

    // ── Signal 4: upcoming request size vs. median ────────────────────────
    // If the next request is much larger than median, it may push over quota.
    const sizeSignal =
      medTokens > 0 ? Math.min(estimatedTokens / (medTokens * 3), 1) : 0;

    // ── Signal 5: quota reset proximity ──────────────────────────────────
    let resetSignal = 0;
    let msUntilReset: number | undefined;
    if (model.lastQuotaReset > 0 && model.estimatedResetIntervalMs > 0) {
      const elapsed = now - model.lastQuotaReset;
      const remaining = model.estimatedResetIntervalMs - elapsed;
      msUntilReset = Math.max(0, remaining);
      // High signal when we're in the last 10% of the reset window and
      // there's significant traffic
      const windowFraction = elapsed / model.estimatedResetIntervalMs;
      if (windowFraction > 0.9 && (rqVel > 0.5 || tkVel > 5_000)) {
        resetSignal = Math.min((windowFraction - 0.9) / 0.1, 1);
      }
    }

    // ── Composite confidence ──────────────────────────────────────────────
    // Weights tuned so a single dominant signal can breach the threshold,
    // but two moderate signals together also cross it.
    const confidence = Math.min(
      rlSignal * 0.40 +
      rqSignal * 0.25 +
      tkSignal * 0.20 +
      sizeSignal * 0.10 +
      resetSignal * 0.05,
      1,
    );

    if (confidence < CONFIDENCE_THRESHOLD) {
      return {
        action: "proceed",
        confidence,
        reason: `Risk ${(confidence * 100).toFixed(0)}% — below threshold`,
        msUntilReset,
      };
    }

    // ── Determine recommended action ──────────────────────────────────────
    // If the dominant signal is a known reset approaching, suggest delay until reset.
    if (resetSignal > 0.8 && msUntilReset !== undefined && msUntilReset < 10_000) {
      return {
        action: "delay",
        confidence,
        delayMs: msUntilReset + 500, // a little buffer
        reason: `Quota reset in ~${msUntilReset}ms — waiting`,
        msUntilReset,
      };
    }

    // If history shows very high rate-limit rate, switching provider is better.
    if (rlRate > 0.5) {
      return {
        action: "switch_provider",
        confidence,
        reason: `${(rlRate * 100).toFixed(0)}% of past requests rate-limited on ${provider}`,
        msUntilReset,
      };
    }

    // Default: short proactive delay
    return {
      action: "delay",
      confidence,
      delayMs: PROACTIVE_DELAY_MS,
      reason: `Predicted rate-limit risk ${(confidence * 100).toFixed(0)}% — applying proactive delay`,
      msUntilReset,
    };
  }

  /**
   * Evaluate multiple providers and return the one least likely to hit
   * a rate limit right now. Returns `null` if only one provider is available.
   *
   * @param providers List of candidate provider names
   * @param estimatedTokens Estimated token count for the upcoming request
   */
  rankProviders(providers: string[], estimatedTokens = 0): string[] {
    return [...providers].sort((a, b) => {
      const pa = this.predict(a, estimatedTokens);
      const pb = this.predict(b, estimatedTokens);
      return pa.confidence - pb.confidence; // lower risk first
    });
  }

  /** Return a read-only snapshot of the model for a provider (for testing/inspection). */
  getModel(provider: string): ProviderModel | undefined {
    return this.models.get(provider);
  }

  /** Reset all learned models (useful in tests). */
  reset(): void {
    this.models.clear();
    this.recordsSinceLastSave = 0;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private getOrCreate(provider: string): ProviderModel {
    let model = this.models.get(provider);
    if (!model) {
      model = emptyModel(provider);
      this.models.set(provider, model);
    }
    return model;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

/**
 * Module-level singleton loaded on first import.
 * The ProviderRouter imports this instance so all predictions share state.
 */
export const globalPredictor = new RateLimitPredictor();
globalPredictor.load();
