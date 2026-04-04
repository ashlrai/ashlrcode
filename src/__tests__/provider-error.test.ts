import { describe, test, expect } from "bun:test";
import { categorizeError } from "../agent/error-handler.ts";

/**
 * Test provider-specific error categorization patterns.
 * The categorizeError function is the core of error handling across all providers.
 * These tests verify the patterns used by the provider router for failover decisions.
 */

describe("Provider error categorization", () => {
  // ── Rate limit detection ────────────────────────────────────────────────

  describe("rate limit errors", () => {
    test("detects HTTP 429 status in message", () => {
      const result = categorizeError(new Error("Request failed with status 429"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryable).toBe(true);
    });

    test("detects rate_limit keyword", () => {
      const result = categorizeError(new Error("rate_limit: too many requests per minute"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryable).toBe(true);
    });

    test("detects 'too many requests' phrase", () => {
      const result = categorizeError(new Error("Too Many Requests"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryable).toBe(true);
    });

    test("detects quota exceeded", () => {
      const result = categorizeError(new Error("quota exceeded for this API key"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryable).toBe(true);
    });

    test("rate limit has retryAfterMs set", () => {
      const result = categorizeError(new Error("429 rate limited"));
      expect(result.retryAfterMs).toBeDefined();
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    test("extracts retry-after from message", () => {
      const result = categorizeError(new Error("429 rate limited, retry after 10 seconds"));
      expect(result.category).toBe("rate_limit");
      // Should extract 10 -> 10000ms
      expect(result.retryAfterMs).toBe(10000);
    });
  });

  // ── Auth errors ─────────────────────────────────────────────────────────

  describe("auth errors", () => {
    test("detects HTTP 401 status", () => {
      const result = categorizeError(new Error("Request failed with status 401"));
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });

    test("detects HTTP 403 status", () => {
      const result = categorizeError(new Error("Request failed with status 403"));
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });

    test("detects 'unauthorized' keyword", () => {
      const result = categorizeError(new Error("Unauthorized: invalid credentials"));
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });

    test("detects 'forbidden' keyword", () => {
      const result = categorizeError(new Error("Forbidden: insufficient permissions"));
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });

    test("detects 'invalid api key' phrase", () => {
      const result = categorizeError(new Error("Invalid API key provided"));
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });
  });

  // ── Network errors ──────────────────────────────────────────────────────

  describe("network errors", () => {
    test("detects ECONNREFUSED", () => {
      const result = categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
    });

    test("detects ENOTFOUND", () => {
      const result = categorizeError(new Error("getaddrinfo ENOTFOUND api.example.com"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
    });

    test("detects timeout", () => {
      const result = categorizeError(new Error("Request timeout after 30000ms"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
    });

    test("detects 'network' keyword", () => {
      const result = categorizeError(new Error("Network error occurred"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
    });

    test("detects 'fetch failed'", () => {
      const result = categorizeError(new Error("fetch failed"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
    });

    test("detects 'socket' errors", () => {
      const result = categorizeError(new Error("socket hang up"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
    });

    test("network errors have retryAfterMs", () => {
      const result = categorizeError(new Error("ECONNREFUSED"));
      expect(result.retryAfterMs).toBeDefined();
      expect(result.retryAfterMs).toBe(2000);
    });
  });

  // ── Server errors ───────────────────────────────────────────────────────

  describe("server errors", () => {
    test("detects HTTP 500", () => {
      const result = categorizeError(new Error("Request failed with status 500"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects HTTP 502", () => {
      const result = categorizeError(new Error("502 Bad Gateway"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects HTTP 503", () => {
      const result = categorizeError(new Error("503 Service Unavailable"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects HTTP 529 (Anthropic overloaded)", () => {
      const result = categorizeError(new Error("529 overloaded"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects 'overloaded' keyword", () => {
      const result = categorizeError(new Error("The model is currently overloaded"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects 'internal server error'", () => {
      const result = categorizeError(new Error("Internal Server Error"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects 'bad gateway'", () => {
      const result = categorizeError(new Error("Bad Gateway"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("detects 'service unavailable'", () => {
      const result = categorizeError(new Error("Service Unavailable"));
      expect(result.category).toBe("server");
      expect(result.retryable).toBe(true);
    });

    test("server errors have retryAfterMs", () => {
      const result = categorizeError(new Error("500 internal error"));
      expect(result.retryAfterMs).toBeDefined();
      expect(result.retryAfterMs).toBe(3000);
    });
  });

  // ── Validation errors ─────────────────────────────────────────────────

  describe("validation errors", () => {
    test("detects 'validation' keyword", () => {
      const result = categorizeError(new Error("Validation error: missing required field"));
      expect(result.category).toBe("validation");
      expect(result.retryable).toBe(false);
    });

    test("detects 'invalid' keyword", () => {
      const result = categorizeError(new Error("Invalid request body"));
      // Note: "invalid" also matches auth pattern if "invalid api key" is present
      // Plain "invalid" without "api key" should be validation
      expect(result.category).toBe("validation");
      expect(result.retryable).toBe(false);
    });

    test("detects 'schema' keyword", () => {
      const result = categorizeError(new Error("Schema validation failed"));
      expect(result.category).toBe("validation");
      expect(result.retryable).toBe(false);
    });
  });

  // ── Unknown errors ────────────────────────────────────────────────────

  describe("unknown errors", () => {
    test("unrecognized errors are categorized as unknown", () => {
      const result = categorizeError(new Error("Something completely unexpected happened"));
      expect(result.category).toBe("unknown");
      expect(result.retryable).toBe(false);
    });

    test("handles string input", () => {
      const result = categorizeError("A raw string error");
      expect(result.category).toBe("unknown");
    });
  });

  // ── Provider router failover patterns ─────────────────────────────────
  // These test the exact patterns the ProviderRouter.stream() checks
  // when deciding whether to failover to the next provider.

  describe("router failover detection", () => {
    test("429 in message triggers isRateLimit check", () => {
      const error = new Error("API returned 429");
      const isRateLimit =
        error.message.includes("429") ||
        error.message.includes("rate_limit") ||
        error.message.includes("quota");
      expect(isRateLimit).toBe(true);
    });

    test("rate_limit in message triggers isRateLimit check", () => {
      const error = new Error("rate_limit exceeded");
      const isRateLimit =
        error.message.includes("429") ||
        error.message.includes("rate_limit") ||
        error.message.includes("quota");
      expect(isRateLimit).toBe(true);
    });

    test("quota in message triggers isRateLimit check", () => {
      const error = new Error("API quota exceeded");
      const isRateLimit =
        error.message.includes("429") ||
        error.message.includes("rate_limit") ||
        error.message.includes("quota");
      expect(isRateLimit).toBe(true);
    });

    test("auth error does NOT trigger isRateLimit check", () => {
      const error = new Error("401 Unauthorized");
      const isRateLimit =
        error.message.includes("429") ||
        error.message.includes("rate_limit") ||
        error.message.includes("quota");
      expect(isRateLimit).toBe(false);
    });

    test("network error does NOT trigger isRateLimit check", () => {
      const error = new Error("ECONNREFUSED");
      const isRateLimit =
        error.message.includes("429") ||
        error.message.includes("rate_limit") ||
        error.message.includes("quota");
      expect(isRateLimit).toBe(false);
    });
  });
});
