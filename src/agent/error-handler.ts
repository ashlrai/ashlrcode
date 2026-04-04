/**
 * Error handler — categorized errors.
 *
 * This module provides error categorization. For retry logic, use
 * withRetry/withStreamRetry from ../providers/retry.ts instead.
 * The retryWithBackoff function here is kept for backward compatibility
 * but delegates to the shared sleep utility.
 */

export type ErrorCategory = "rate_limit" | "network" | "auth" | "validation" | "tool_failure" | "server" | "unknown";

export interface CategorizedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Shared sleep utility — single implementation, no duplication. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract Retry-After header value from error message.
 */
export function extractRetryAfter(message: string): number | null {
  const match = message.match(/retry.after.*?(\d+)/i);
  if (match) return parseInt(match[1]!, 10) * 1000;
  return null;
}

/**
 * Categorize an error for appropriate handling.
 * Used by both this module and providers/retry.ts.
 */
export function categorizeError(error: Error | string): CategorizedError {
  const message = typeof error === "string" ? error : error.message;
  const msg = message.toLowerCase();

  if (msg.includes("429") || msg.includes("rate_limit") || msg.includes("quota") || msg.includes("too many requests")) {
    return {
      category: "rate_limit",
      message: "Rate limited by provider",
      retryable: true,
      retryAfterMs: extractRetryAfter(message) ?? 5000,
    };
  }

  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("invalid api key")) {
    return {
      category: "auth",
      message: "Authentication failed — check your API key",
      retryable: false,
    };
  }

  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("timeout") || msg.includes("network") || msg.includes("fetch failed") || msg.includes("socket")) {
    return {
      category: "network",
      message: "Network error — check your connection",
      retryable: true,
      retryAfterMs: 2000,
    };
  }

  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("529") || msg.includes("internal server error") || msg.includes("bad gateway") || msg.includes("service unavailable") || msg.includes("overloaded")) {
    return {
      category: "server",
      message: "Server error — provider may be experiencing issues",
      retryable: true,
      retryAfterMs: 3000,
    };
  }

  if (msg.includes("validation") || msg.includes("invalid") || msg.includes("schema")) {
    return {
      category: "validation",
      message,
      retryable: false,
    };
  }

  return {
    category: "unknown",
    message,
    retryable: false,
  };
}

/**
 * Simple retry with exponential backoff.
 * For production use, prefer withRetry() from providers/retry.ts which has
 * category-aware max retries, jitter, and circuit breaker integration.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const categorized = categorizeError(lastError);

      if (!categorized.retryable || attempt === maxRetries) {
        throw lastError;
      }

      const delay = categorized.retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Retry exhausted");
}
