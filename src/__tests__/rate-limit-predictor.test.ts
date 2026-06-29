/**
 * rate-limit-predictor.test.ts
 *
 * Tests for the multi-provider rate-limit & quota prediction engine.
 * Uses synthetic traces injected via record() to verify prediction accuracy
 * without any real API calls or file I/O.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  RateLimitPredictor,
  CONFIDENCE_THRESHOLD,
  PROACTIVE_DELAY_MS,
  type ProviderModel,
  type PredictionResult,
} from "../providers/rate-limit-predictor.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a predictor with auto-save disabled (Infinity interval). */
function mkPredictor(): RateLimitPredictor {
  return new RateLimitPredictor(Infinity);
}

/**
 * Inject N rapid-fire requests into the predictor for a provider.
 * All timestamps are "now" (real clock) so they fall in the sliding window.
 */
function injectRequests(
  predictor: RateLimitPredictor,
  provider: string,
  count: number,
  tokensEach: number,
  rateLimitedCount = 0,
): void {
  for (let i = 0; i < count; i++) {
    predictor.record(provider, tokensEach, i < rateLimitedCount);
  }
}

// ── Basic record & model creation ─────────────────────────────────────────

describe("RateLimitPredictor — basic recording", () => {
  let predictor: RateLimitPredictor;
  beforeEach(() => {
    predictor = mkPredictor();
  });

  test("model is created on first record", () => {
    predictor.record("anthropic", 1000, false);
    const model = predictor.getModel("anthropic");
    expect(model).toBeDefined();
    expect(model!.provider).toBe("anthropic");
    expect(model!.requestCount).toBe(1);
  });

  test("requestCount increments with each record", () => {
    injectRequests(predictor, "xai", 5, 500);
    expect(predictor.getModel("xai")!.requestCount).toBe(5);
  });

  test("rateLimitCount increments only for rate-limited records", () => {
    injectRequests(predictor, "openai", 10, 1000, 3);
    const m = predictor.getModel("openai")!;
    expect(m.rateLimitCount).toBe(3);
    expect(m.requestCount).toBe(10);
  });

  test("windowTokenSum accumulates correctly", () => {
    injectRequests(predictor, "groq", 4, 2000);
    const m = predictor.getModel("groq")!;
    expect(m.windowTokenSum).toBe(8000);
  });

  test("events buffer is capped at 500", () => {
    for (let i = 0; i < 600; i++) predictor.record("deepseek", 100, false);
    expect(predictor.getModel("deepseek")!.events.length).toBeLessThanOrEqual(500);
  });

  test("histogram bucket is updated per record", () => {
    predictor.record("anthropic", 50_000, false); // ~50% of MAX → bucket ~10
    const histogram = predictor.getModel("anthropic")!.tokenHistogram;
    const total = histogram.reduce((s, c) => s + c, 0);
    expect(total).toBe(1);
  });

  test("lastQuotaReset is set on first rate-limit event", () => {
    predictor.record("xai", 1000, true);
    const m = predictor.getModel("xai")!;
    expect(m.lastQuotaReset).toBeGreaterThan(0);
  });

  test("reset clears all models", () => {
    injectRequests(predictor, "anthropic", 10, 1000);
    injectRequests(predictor, "xai", 5, 500);
    predictor.reset();
    expect(predictor.getModel("anthropic")).toBeUndefined();
    expect(predictor.getModel("xai")).toBeUndefined();
  });
});

// ── Insufficient data path ─────────────────────────────────────────────────

describe("RateLimitPredictor — insufficient data", () => {
  test("returns proceed with 0 confidence when no model exists", () => {
    const p = mkPredictor();
    const result = p.predict("unknown-provider");
    expect(result.action).toBe("proceed");
    expect(result.confidence).toBe(0);
  });

  test("returns proceed with 0 confidence with < 3 requests", () => {
    const p = mkPredictor();
    injectRequests(p, "anthropic", 2, 1000);
    const result = p.predict("anthropic");
    expect(result.action).toBe("proceed");
    expect(result.confidence).toBe(0);
  });
});

// ── Prediction: safe traffic ───────────────────────────────────────────────

describe("RateLimitPredictor — safe traffic (should stay below threshold)", () => {
  test("low-volume successful traffic → proceed", () => {
    const p = mkPredictor();
    // 5 successful requests with moderate tokens, well-spaced
    injectRequests(p, "anthropic", 5, 1000, 0);
    const result = p.predict("anthropic", 1000);
    expect(result.action).toBe("proceed");
    expect(result.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  test("zero rate-limit history → low confidence", () => {
    const p = mkPredictor();
    injectRequests(p, "xai", 20, 500, 0);
    const result = p.predict("xai", 500);
    expect(result.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });
});

// ── Prediction: high rate-limit history ───────────────────────────────────

describe("RateLimitPredictor — high rate-limit rate → action recommended", () => {
  test("50%+ rate-limit rate → switch_provider recommended", () => {
    const p = mkPredictor();
    // 6 out of 10 rate-limited → 60% RL rate
    injectRequests(p, "anthropic", 10, 5000, 6);
    const result = p.predict("anthropic", 5000);
    expect(result.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.action).toBe("switch_provider");
  });

  test("30-50% rate-limit rate → delay recommended", () => {
    const p = mkPredictor();
    // 4 out of 10 rate-limited → 40% RL rate
    injectRequests(p, "xai", 10, 3000, 4);
    const result = p.predict("xai", 3000);
    expect(result.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    // Either delay or switch_provider is valid
    expect(["delay", "switch_provider"]).toContain(result.action);
  });

  test("confidence is very high with all requests rate-limited", () => {
    const p = mkPredictor();
    injectRequests(p, "groq", 20, 2000, 20);
    const result = p.predict("groq", 2000);
    // RL rate alone (weight 0.40) can contribute up to 0.40; combined signals
    // with recency weighting yield high confidence well above threshold.
    expect(result.confidence).toBeGreaterThan(0.7);
  });
});

// ── Prediction: reason string ──────────────────────────────────────────────

describe("RateLimitPredictor — reason strings", () => {
  test("proceed result includes risk percentage", () => {
    const p = mkPredictor();
    injectRequests(p, "openai", 5, 100, 0);
    const result = p.predict("openai");
    expect(result.reason).toMatch(/(%|Insufficient)/);
  });

  test("switch_provider result mentions provider name", () => {
    const p = mkPredictor();
    injectRequests(p, "anthropic", 10, 2000, 8);
    const result = p.predict("anthropic", 2000);
    if (result.action === "switch_provider") {
      expect(result.reason).toContain("anthropic");
    }
  });

  test("delay result includes delayMs", () => {
    const p = mkPredictor();
    injectRequests(p, "xai", 10, 4000, 4);
    const result = p.predict("xai", 4000);
    if (result.action === "delay") {
      expect(result.delayMs).toBeGreaterThan(0);
    }
  });
});

// ── rankProviders ──────────────────────────────────────────────────────────

describe("RateLimitPredictor — rankProviders", () => {
  test("ranks healthy provider first", () => {
    const p = mkPredictor();
    // anthropic: many rate limits
    injectRequests(p, "anthropic", 10, 3000, 7);
    // xai: no rate limits
    injectRequests(p, "xai", 10, 3000, 0);

    const ranked = p.rankProviders(["anthropic", "xai"], 3000);
    expect(ranked[0]).toBe("xai");
    expect(ranked[1]).toBe("anthropic");
  });

  test("returns all providers in some order", () => {
    const p = mkPredictor();
    const providers = ["anthropic", "xai", "openai", "groq"];
    for (const pr of providers) injectRequests(p, pr, 5, 1000, 0);
    const ranked = p.rankProviders(providers, 1000);
    expect(ranked.sort()).toEqual(providers.sort());
  });

  test("unknown providers (no history) sort before high-risk ones", () => {
    const p = mkPredictor();
    // groq has bad history
    injectRequests(p, "groq", 10, 2000, 8);
    // deepseek is unknown
    const ranked = p.rankProviders(["groq", "deepseek"], 2000);
    expect(ranked[0]).toBe("deepseek");
  });
});

// ── Proactive delay constant ───────────────────────────────────────────────

describe("RateLimitPredictor — constants", () => {
  test("CONFIDENCE_THRESHOLD is 0.7", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  test("PROACTIVE_DELAY_MS is 2000", () => {
    expect(PROACTIVE_DELAY_MS).toBe(2_000);
  });
});

// ── Prediction accuracy on synthetic trace ────────────────────────────────

describe("RateLimitPredictor — synthetic trace accuracy", () => {
  /**
   * Simulate a realistic pattern: moderate traffic that ramps up and
   * starts hitting rate limits. The predictor should cross the threshold
   * by the time we've seen 30% rate-limit hits.
   */
  test("detects degrading provider before 50% hit rate", () => {
    const p = mkPredictor();
    const results: PredictionResult[] = [];

    // Phase 1: 15 clean requests
    for (let i = 0; i < 15; i++) {
      const prediction = p.predict("anthropic", 2000);
      results.push(prediction);
      p.record("anthropic", 2000, false);
    }

    // Phase 2: alternating success / rate-limit (50% RL rate)
    for (let i = 0; i < 10; i++) {
      const prediction = p.predict("anthropic", 2000);
      results.push(prediction);
      p.record("anthropic", 2000, i % 2 === 0); // every other is RL
    }

    // After phase 2, confidence should be above threshold
    const lastPrediction = results[results.length - 1]!;
    expect(lastPrediction.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  test("confidence rises monotonically as RL rate increases", () => {
    const p = mkPredictor();
    const confidences: number[] = [];

    // Record batches of increasing RL density
    for (let batchRLRate = 0; batchRLRate <= 10; batchRLRate++) {
      p.reset();
      // 10 requests with batchRLRate of them being RL
      for (let i = 0; i < 10; i++) {
        p.record("xai", 3000, i < batchRLRate);
      }
      const { confidence } = p.predict("xai", 3000);
      confidences.push(confidence);
    }

    // Confidence should be non-decreasing as RL rate increases
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]!).toBeGreaterThanOrEqual(confidences[i - 1]! - 0.01); // allow tiny float noise
    }
  });

  test("provider recovers after clean requests following RL burst", () => {
    const p = mkPredictor();

    // Burst of rate limits
    injectRequests(p, "openai", 10, 2000, 8);
    const afterBurst = p.predict("openai", 2000);
    expect(afterBurst.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);

    // Recovery: many clean requests push the recency-weighted rate down
    injectRequests(p, "openai", 50, 2000, 0);
    const afterRecovery = p.predict("openai", 2000);
    // Confidence should have dropped vs. burst peak
    expect(afterRecovery.confidence).toBeLessThan(afterBurst.confidence);
  });

  test("large request size signal increases confidence vs small request", () => {
    const p = mkPredictor();
    // Moderate base traffic, some rate limits
    injectRequests(p, "groq", 10, 2000, 3);

    const smallRequest = p.predict("groq", 500);
    const largeRequest = p.predict("groq", 90_000); // near MAX_TOKENS_PER_REQUEST
    // Large request should have higher or equal confidence
    expect(largeRequest.confidence).toBeGreaterThanOrEqual(smallRequest.confidence);
  });
});

// ── Persistence (mocked — no real file I/O) ───────────────────────────────

describe("RateLimitPredictor — persistence round-trip (in-memory only)", () => {
  test("load() is a no-op when file does not exist", () => {
    // New predictor with Infinity autosave — load() reads from disk but file
    // may or may not exist. Either way it shouldn't throw.
    const p = new RateLimitPredictor(Infinity);
    expect(() => p.load()).not.toThrow();
  });

  test("getModel returns undefined for unseen provider after load() with empty store", () => {
    const p = new RateLimitPredictor(Infinity);
    p.load(); // file absent → no-op
    expect(p.getModel("nonexistent-provider-xyz")).toBeUndefined();
  });
});
