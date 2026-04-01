/**
 * Error handler — categorized errors with retry logic.
 */

export type ErrorCategory = "rate_limit" | "network" | "auth" | "validation" | "tool_failure" | "unknown";

export interface CategorizedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/**
 * Categorize an error for appropriate handling.
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
 * Retry with exponential backoff.
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

function extractRetryAfter(message: string): number | null {
  const match = message.match(/retry.after.*?(\d+)/i);
  if (match) return parseInt(match[1]!, 10) * 1000;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
