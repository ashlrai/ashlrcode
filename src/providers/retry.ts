/**
 * Retry logic — exponential backoff with jitter for API calls.
 * Circuit breaker pattern to stop hammering a failing provider.
 *
 * Centralizes retry behavior previously duplicated across xai.ts and anthropic.ts.
 */

import { categorizeError, type CategorizedError } from "../agent/error-handler.ts";

// ── Retry Config ──────────────────────────────────────────────────────

export interface RetryConfig {
  /** Max retry attempts per error category */
  maxRetriesRateLimit: number;
  maxRetriesNetwork: number;
  maxRetriesServer: number;
  /** Base delay in ms before first retry (doubles each attempt) */
  baseDelayMs: number;
  /** Absolute max delay cap */
  maxDelayMs: number;
  /** Provider name for log messages */
  providerName: string;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetriesRateLimit: 3,
  maxRetriesNetwork: 2,
  maxRetriesServer: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  providerName: "provider",
};

// ── Retry Error ───────────────────────────────────────────────────────

export class RetryError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastCategory?: string,
    public readonly lastStatus?: number,
  ) {
    super(message);
    this.name = "RetryError";
  }
}

// ── Core retry function ───────────────────────────────────────────────

/**
 * Execute a function with category-aware exponential backoff and jitter.
 *
 * - Rate limit (429): up to maxRetriesRateLimit retries
 * - Network errors: up to maxRetriesNetwork retries
 * - Server errors (500/502/503/504/529): up to maxRetriesServer retries
 * - Auth errors (401/403): fail immediately
 * - Unknown non-retryable errors: fail immediately
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | null = null;
  let lastCategorized: CategorizedError | null = null;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      lastCategorized = categorizeError(lastError);

      // Auth errors: fail immediately with clear message
      if (lastCategorized.category === "auth") {
        throw new Error(
          `[${cfg.providerName}] Authentication failed — check your API key. (${lastError.message})`,
        );
      }

      // Determine max retries for this error category
      const maxRetries = getMaxRetries(lastCategorized, cfg);

      if (!lastCategorized.retryable || attempt >= maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = calculateDelay(attempt, lastCategorized, cfg);

      process.stderr.write(
        `[${cfg.providerName}] ${lastCategorized.category} error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...\n`,
      );

      await sleep(delay);
    }
  }
}

/**
 * Wrap an async generator with retry — recreates the generator on failure.
 * Used for streaming API calls where errors can surface mid-iteration.
 */
export async function* withStreamRetry<T>(
  createStream: () => AsyncGenerator<T>,
  config: Partial<RetryConfig> = {},
): AsyncGenerator<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; ; attempt++) {
    const stream = createStream();
    try {
      for await (const event of stream) {
        yield event;
      }
      return; // Stream completed successfully
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const categorized = categorizeError(lastError);

      // Auth: fail fast
      if (categorized.category === "auth") {
        throw new Error(
          `[${cfg.providerName}] Authentication failed — check your API key. (${lastError.message})`,
        );
      }

      const maxRetries = getMaxRetries(categorized, cfg);

      if (!categorized.retryable || attempt >= maxRetries) {
        throw lastError;
      }

      const delay = calculateDelay(attempt, categorized, cfg);
      process.stderr.write(
        `[${cfg.providerName}] ${categorized.category} error mid-stream, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...\n`,
      );

      await sleep(delay);
      // Loop re-creates the stream from scratch
    }
  }
}

// ── Circuit Breaker ───────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

/**
 * Circuit breaker — stop hammering a provider after consecutive failures.
 *
 * States:
 * - closed: requests flow normally
 * - open: requests are blocked (too many failures)
 * - half-open: one probe request allowed to test recovery
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: CircuitState = "closed";

  constructor(
    /** Number of consecutive failures before opening the circuit */
    private readonly threshold: number = 5,
    /** Time in ms before an open circuit transitions to half-open */
    private readonly resetTimeMs: number = 60_000,
  ) {}

  /** Check if a request should be allowed through */
  canRequest(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      // Check if enough time has passed to try again
      if (Date.now() - this.lastFailureTime >= this.resetTimeMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }

    // half-open: allow one probe request
    return true;
  }

  /** Record a successful request — resets failure count */
  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  /** Record a failed request — may trip the breaker */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState {
    // Re-check for time-based transition
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.resetTimeMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  getStatus(): string {
    return `${this.getState()} (${this.failures}/${this.threshold} failures)`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function getMaxRetries(categorized: CategorizedError, cfg: RetryConfig): number {
  switch (categorized.category) {
    case "rate_limit":
      return cfg.maxRetriesRateLimit;
    case "network":
      return cfg.maxRetriesNetwork;
    default:
      // Server errors (5xx) are retryable if categorized as such
      return categorized.retryable ? cfg.maxRetriesServer : 0;
  }
}

function calculateDelay(
  attempt: number,
  categorized: CategorizedError,
  cfg: RetryConfig,
): number {
  // If the error includes a Retry-After hint, use it
  if (categorized.retryAfterMs && categorized.retryAfterMs > 0) {
    return Math.min(categorized.retryAfterMs, cfg.maxDelayMs);
  }

  // Rate limits get a higher base delay
  const baseDelay =
    categorized.category === "rate_limit"
      ? cfg.baseDelayMs
      : categorized.category === "network"
        ? cfg.baseDelayMs * 2
        : cfg.baseDelayMs;

  // Exponential backoff: base * 2^attempt
  const exponential = baseDelay * Math.pow(2, attempt);

  // Add jitter: ±25% randomization to prevent thundering herd
  const jitter = exponential * 0.25 * (Math.random() * 2 - 1);

  return Math.min(Math.round(exponential + jitter), cfg.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
