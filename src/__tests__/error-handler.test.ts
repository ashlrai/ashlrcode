import { test, expect, describe } from "bun:test";
import { categorizeError, retryWithBackoff } from "../agent/error-handler.ts";

describe("categorizeError", () => {
  describe("rate_limit", () => {
    test("detects 429 status code", () => {
      const result = categorizeError(new Error("HTTP 429 Too Many Requests"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    test("detects rate_limit keyword", () => {
      const result = categorizeError("rate_limit exceeded");
      expect(result.category).toBe("rate_limit");
      expect(result.retryable).toBe(true);
    });

    test("detects quota keyword", () => {
      const result = categorizeError(new Error("quota exceeded for this key"));
      expect(result.category).toBe("rate_limit");
    });

    test("detects 'too many requests'", () => {
      const result = categorizeError("Too many requests, please slow down");
      expect(result.category).toBe("rate_limit");
    });

    test("extracts retry-after from message", () => {
      const result = categorizeError(new Error("429 rate_limit: retry after 30 seconds"));
      expect(result.category).toBe("rate_limit");
      expect(result.retryAfterMs).toBe(30000);
    });

    test("defaults to 5000ms when no retry-after found", () => {
      const result = categorizeError(new Error("429"));
      expect(result.retryAfterMs).toBe(5000);
    });
  });

  describe("auth", () => {
    test("detects 401 status", () => {
      const result = categorizeError(new Error("HTTP 401 Unauthorized"));
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });

    test("detects 403 status", () => {
      const result = categorizeError(new Error("403 Forbidden"));
      expect(result.category).toBe("auth");
    });

    test("detects 'unauthorized'", () => {
      const result = categorizeError("Request unauthorized");
      expect(result.category).toBe("auth");
    });

    test("detects 'invalid api key'", () => {
      const result = categorizeError(new Error("Invalid API key provided"));
      expect(result.category).toBe("auth");
    });
  });

  describe("network", () => {
    test("detects ECONNREFUSED", () => {
      const result = categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:443"));
      expect(result.category).toBe("network");
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(2000);
    });

    test("detects ENOTFOUND", () => {
      const result = categorizeError(new Error("getaddrinfo ENOTFOUND api.example.com"));
      expect(result.category).toBe("network");
    });

    test("detects timeout", () => {
      const result = categorizeError("Request timeout after 30s");
      expect(result.category).toBe("network");
    });

    test("detects fetch failed", () => {
      const result = categorizeError(new Error("fetch failed"));
      expect(result.category).toBe("network");
    });

    test("detects socket errors", () => {
      const result = categorizeError(new Error("socket hang up"));
      expect(result.category).toBe("network");
    });
  });

  describe("validation", () => {
    test("detects validation keyword", () => {
      const result = categorizeError(new Error("Validation error: missing field"));
      expect(result.category).toBe("validation");
      expect(result.retryable).toBe(false);
    });

    test("detects invalid keyword", () => {
      const result = categorizeError("Invalid parameter: model");
      expect(result.category).toBe("validation");
    });

    test("detects schema keyword", () => {
      const result = categorizeError(new Error("Schema mismatch on input"));
      expect(result.category).toBe("validation");
    });
  });

  describe("unknown", () => {
    test("returns unknown for unrecognized errors", () => {
      const result = categorizeError(new Error("Something unexpected happened"));
      expect(result.category).toBe("unknown");
      expect(result.retryable).toBe(false);
    });

    test("handles string errors", () => {
      const result = categorizeError("just a string error");
      expect(result.category).toBe("unknown");
      expect(result.message).toBe("just a string error");
    });
  });

  describe("priority: rate_limit before auth", () => {
    // If a message contains both "429" and "unauthorized", rate_limit should win
    // because it's checked first
    test("rate_limit takes priority when both match", () => {
      const result = categorizeError(new Error("429 unauthorized"));
      expect(result.category).toBe("rate_limit");
    });
  });
});

describe("retryWithBackoff", () => {
  test("returns result on first success", async () => {
    const result = await retryWithBackoff(async () => "success", 3, 10);
    expect(result).toBe("success");
  });

  test("retries on retryable error and succeeds", async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("fetch failed");
        return "recovered";
      },
      3,
      10 // Short delay for test speed
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("throws on non-retryable error immediately", async () => {
    let attempts = 0;
    try {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("401 Unauthorized");
        },
        3,
        10
      );
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect((err as Error).message).toContain("401");
    }
    expect(attempts).toBe(1);
  });

  test("throws after max retries exhausted", async () => {
    let attempts = 0;
    try {
      await retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("fetch failed"); // network = retryable
        },
        2,
        10
      );
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("fetch failed");
    }
    // 1 initial + 2 retries = 3 attempts
    expect(attempts).toBe(3);
  });
});
