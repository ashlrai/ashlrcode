import { describe, test, expect, beforeEach } from "bun:test";
import { withRetry, CircuitBreaker, RetryError } from "../providers/retry.ts";

describe("withRetry", () => {
  test("succeeds on first attempt", async () => {
    const result = await withRetry(() => Promise.resolve("ok"), {
      providerName: "test",
    });
    expect(result).toBe("ok");
  });

  test("retries on rate limit (429) and succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 3) throw new Error("429 Too Many Requests");
        return Promise.resolve("recovered");
      },
      { providerName: "test", baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("recovered");
    expect(attempt).toBe(3);
  });

  test("retries on server error (500) and succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 2) throw new Error("500 Internal Server Error");
        return Promise.resolve("recovered");
      },
      { providerName: "test", baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("recovered");
    expect(attempt).toBe(2);
  });

  test("retries on 502 Bad Gateway", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 2) throw new Error("502 Bad Gateway");
        return Promise.resolve("ok");
      },
      { providerName: "test", baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("ok");
  });

  test("retries on 503 Service Unavailable", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 2) throw new Error("503 Service Unavailable");
        return Promise.resolve("ok");
      },
      { providerName: "test", baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("ok");
  });

  test("fails immediately on 400 (non-retryable)", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("400 Bad Request — invalid schema");
          return Promise.resolve("never");
        },
        { providerName: "test", baseDelayMs: 1 },
      );
      expect(true).toBe(false); // Should not reach
    } catch (err: any) {
      expect(attempt).toBe(1);
      expect(err.message).toContain("400");
    }
  });

  test("fails immediately on 401 (auth error) with clear message", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("401 Unauthorized");
        },
        { providerName: "myProvider", baseDelayMs: 1 },
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(attempt).toBe(1);
      expect(err.message).toContain("myProvider");
      expect(err.message).toContain("Authentication failed");
    }
  });

  test("fails immediately on 403 (auth error)", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("403 Forbidden");
        },
        { providerName: "test", baseDelayMs: 1 },
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(attempt).toBe(1);
      expect(err.message).toContain("Authentication failed");
    }
  });

  test("respects maxRetries for rate limits", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("429 rate_limit exceeded");
        },
        {
          providerName: "test",
          baseDelayMs: 1,
          maxDelayMs: 10,
          maxRetriesRateLimit: 2,
        },
      );
      expect(true).toBe(false);
    } catch (err: any) {
      // 1 initial + 2 retries = 3 attempts total
      expect(attempt).toBe(3);
    }
  });

  test("respects maxRetries for server errors", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("500 internal server error");
        },
        {
          providerName: "test",
          baseDelayMs: 1,
          maxDelayMs: 10,
          maxRetriesServer: 1,
        },
      );
      expect(true).toBe(false);
    } catch (err: any) {
      // 1 initial + 1 retry = 2 attempts
      expect(attempt).toBe(2);
    }
  });

  test("respects maxRetries for network errors", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("ECONNREFUSED");
        },
        {
          providerName: "test",
          baseDelayMs: 1,
          maxDelayMs: 10,
          maxRetriesNetwork: 1,
        },
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(attempt).toBe(2);
    }
  });
});

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker(3, 100); // low threshold and reset time for testing
  });

  test("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
  });

  test("allows requests in closed state", () => {
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.canRequest()).toBe(true);
  });

  test("opens after threshold consecutive failures", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");

    breaker.recordFailure(); // threshold = 3
    expect(breaker.getState()).toBe("open");
    expect(breaker.canRequest()).toBe(false);
  });

  test("success resets failure count", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();

    // Should be back to closed with 0 failures
    expect(breaker.getState()).toBe("closed");

    // Need 3 more failures to open again
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  test("transitions to half-open after reset time", async () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");

    // Wait for reset time
    await new Promise((r) => setTimeout(r, 150));

    // Should transition to half-open
    expect(breaker.getState()).toBe("half-open");
  });

  test("allows one probe request in half-open state", async () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // Wait for reset time
    await new Promise((r) => setTimeout(r, 150));

    // First request should be allowed (probe)
    expect(breaker.canRequest()).toBe(true);
    // Second request should be blocked (probe in flight)
    expect(breaker.canRequest()).toBe(false);
  });

  test("probe success resets to closed", async () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // Wait for reset time
    await new Promise((r) => setTimeout(r, 150));

    // Probe request
    expect(breaker.canRequest()).toBe(true);

    // Probe succeeds
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.canRequest()).toBe(true); // all requests allowed again
  });

  test("probe failure keeps circuit open", async () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // Wait for reset time
    await new Promise((r) => setTimeout(r, 150));

    // Probe request allowed
    expect(breaker.canRequest()).toBe(true);

    // Probe fails — failures now >= threshold so still open
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canRequest()).toBe(false);
  });

  test("probeInFlight prevents multiple simultaneous probes", async () => {
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // Wait for reset time — enters half-open via canRequest
    await new Promise((r) => setTimeout(r, 150));

    // First probe allowed
    expect(breaker.canRequest()).toBe(true);
    // probeInFlight is now true — second probe blocked
    expect(breaker.canRequest()).toBe(false);
    expect(breaker.canRequest()).toBe(false);

    // After recording failure, probeInFlight resets but state is still open
    breaker.recordFailure();
    expect(breaker.canRequest()).toBe(false); // still open, timer restarted
  });

  test("getStatus returns descriptive string", () => {
    const status = breaker.getStatus();
    expect(status).toContain("closed");
    expect(status).toContain("0/3");

    breaker.recordFailure();
    expect(breaker.getStatus()).toContain("1/3");
  });
});
