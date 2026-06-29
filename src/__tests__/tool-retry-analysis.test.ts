/**
 * Tool Retry Analysis — test suite for tool-retry-analyzer.ts
 *
 * Covers:
 *  - classifyFailure() for each error category
 *  - buildRetryStrategy() strategy selection and input mutation
 *  - retry history ring buffer and stats
 *  - edge cases (unknown errors, recoverable flag, maxRetries=0)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  classifyFailure,
  buildRetryStrategy,
  recordRetryAttempt,
  getRetryHistory,
  getRetryStats,
  formatRetryStats,
  resetRetryHistory,
} from "../agent/tool-retry-analyzer.ts";
import type { RetryAttemptRecord } from "../agent/tool-retry-analyzer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(msg: string): Error {
  return new Error(msg);
}

function makeRecord(
  toolName: string,
  category: RetryAttemptRecord["category"],
  succeeded: boolean,
  attempt = 1
): RetryAttemptRecord {
  return {
    toolName,
    attempt,
    category,
    succeeded,
    timestamp: new Date().toISOString(),
    errorMessage: "test error",
  };
}

// ---------------------------------------------------------------------------
// classifyFailure — timeout category
// ---------------------------------------------------------------------------

describe("classifyFailure — timeout", () => {
  test("classifies 'timed out' message as timeout", () => {
    const r = classifyFailure("Bash", err("Command timed out after 120000ms"));
    expect(r.category).toBe("timeout");
    expect(r.recoverable).toBe(true);
  });

  test("classifies ETIMEDOUT as timeout", () => {
    const r = classifyFailure("Bash", err("ETIMEDOUT connect ETIMEDOUT 127.0.0.1:3000"));
    expect(r.category).toBe("timeout");
    expect(r.recoverable).toBe(true);
  });

  test("classifies 'deadline' as timeout", () => {
    const r = classifyFailure("WebFetch", err("Request deadline exceeded"));
    expect(r.category).toBe("timeout");
    expect(r.recoverable).toBe(true);
  });

  test("suggestedAction mentions the tool name", () => {
    const r = classifyFailure("MyTool", err("Execution timed out"));
    expect(r.suggestedAction).toContain("MyTool");
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — permission category
// ---------------------------------------------------------------------------

describe("classifyFailure — permission", () => {
  test("classifies EACCES as permission", () => {
    const r = classifyFailure("Write", err("EACCES: permission denied, open '/etc/hosts'"));
    expect(r.category).toBe("permission");
    expect(r.recoverable).toBe(false);
  });

  test("classifies EPERM as permission", () => {
    const r = classifyFailure("Bash", err("EPERM: operation not permitted"));
    expect(r.category).toBe("permission");
    expect(r.recoverable).toBe(false);
  });

  test("classifies 'access denied' as permission", () => {
    const r = classifyFailure("FileWrite", err("Access denied: /root/secret"));
    expect(r.category).toBe("permission");
    expect(r.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — not-found category
// ---------------------------------------------------------------------------

describe("classifyFailure — not-found", () => {
  test("classifies ENOENT as not-found", () => {
    const r = classifyFailure("Read", err("ENOENT: no such file or directory, open '/tmp/missing.ts'"));
    expect(r.category).toBe("not-found");
    expect(r.recoverable).toBe(true);
  });

  test("classifies 'file not found' as not-found", () => {
    const r = classifyFailure("Edit", err("File not found: /src/missing.ts"));
    expect(r.category).toBe("not-found");
    expect(r.recoverable).toBe(true);
  });

  test("includes path hint in suggestedAction when context provided", () => {
    const r = classifyFailure(
      "Read",
      err("ENOENT: no such file"),
      { input: { file_path: "/src/foo.ts" } }
    );
    expect(r.suggestedAction).toContain("/src/foo.ts");
  });

  test("works without context (no path hint)", () => {
    const r = classifyFailure("Read", err("ENOENT: no such file"));
    expect(r.category).toBe("not-found");
    expect(r.suggestedAction).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — parse category
// ---------------------------------------------------------------------------

describe("classifyFailure — parse", () => {
  test("classifies JSON parse error as parse", () => {
    const r = classifyFailure("Bash", err("JSON parse error: Unexpected token < at position 0"));
    expect(r.category).toBe("parse");
    expect(r.recoverable).toBe(true);
  });

  test("classifies 'Unexpected token' as parse", () => {
    const r = classifyFailure("WebFetch", err("Unexpected token } in JSON at position 42"));
    expect(r.category).toBe("parse");
  });

  test("classifies 'malformed' as parse", () => {
    const r = classifyFailure("Bash", err("Malformed output: expected JSON object"));
    expect(r.category).toBe("parse");
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — transient category
// ---------------------------------------------------------------------------

describe("classifyFailure — transient", () => {
  test("classifies ECONNREFUSED as transient", () => {
    const r = classifyFailure("WebFetch", err("ECONNREFUSED 127.0.0.1:8080"));
    expect(r.category).toBe("transient");
    expect(r.recoverable).toBe(true);
  });

  test("classifies 503 as transient", () => {
    const r = classifyFailure("mcp__chrome__read", err("503 Service Unavailable"));
    expect(r.category).toBe("transient");
  });

  test("classifies 'mcp tool unavailable' as transient", () => {
    const r = classifyFailure("mcp__plugin__tool", err("MCP tool unavailable: server not connected"));
    expect(r.category).toBe("transient");
    expect(r.recoverable).toBe(true);
  });

  test("classifies unknown errors as transient (safe default)", () => {
    const r = classifyFailure("SomeTool", err("Something went terribly wrong (unknown cause)"));
    expect(r.category).toBe("transient");
    expect(r.recoverable).toBe(true);
  });

  test("works with non-Error thrown values", () => {
    const r = classifyFailure("Bash", "plain string error");
    expect(r.category).toBe("transient");
    expect(r.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRetryStrategy — timeout
// ---------------------------------------------------------------------------

describe("buildRetryStrategy — timeout", () => {
  test("returns maxRetries=3 for timeout", () => {
    const s = buildRetryStrategy({ category: "timeout", recoverable: true, suggestedAction: "" });
    expect(s.maxRetries).toBe(3);
  });

  test("mutate increases timeout by 1.5× on first retry", () => {
    const s = buildRetryStrategy({ category: "timeout", recoverable: true, suggestedAction: "" });
    const result = s.mutate!({ timeout: 10_000 }, 1);
    expect(result.timeout).toBe(15_000);
  });

  test("mutate uses 120_000 as default when no timeout in input", () => {
    const s = buildRetryStrategy({ category: "timeout", recoverable: true, suggestedAction: "" });
    const result = s.mutate!({}, 1);
    expect(typeof result.timeout).toBe("number");
    expect(result.timeout as number).toBeGreaterThan(120_000);
  });

  test("mutate compounds correctly on retry 2 (2.25×)", () => {
    const s = buildRetryStrategy({ category: "timeout", recoverable: true, suggestedAction: "" });
    const result = s.mutate!({ timeout: 10_000 }, 2);
    expect(result.timeout).toBe(22_500);
  });

  test("preserves other input fields during mutation", () => {
    const s = buildRetryStrategy({ category: "timeout", recoverable: true, suggestedAction: "" });
    const result = s.mutate!({ timeout: 5_000, command: "bun test" }, 1);
    expect(result.command).toBe("bun test");
  });
});

// ---------------------------------------------------------------------------
// buildRetryStrategy — not-found
// ---------------------------------------------------------------------------

describe("buildRetryStrategy — not-found", () => {
  test("returns maxRetries=2", () => {
    const s = buildRetryStrategy({ category: "not-found", recoverable: true, suggestedAction: "" });
    expect(s.maxRetries).toBe(2);
  });

  test("mutate is a no-op (path correction happens externally via Glob)", () => {
    const s = buildRetryStrategy({ category: "not-found", recoverable: true, suggestedAction: "" });
    const input = { file_path: "/old/path.ts" };
    const result = s.mutate!(input, 1);
    expect(result).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// buildRetryStrategy — parse
// ---------------------------------------------------------------------------

describe("buildRetryStrategy — parse", () => {
  test("returns maxRetries=1 on first occurrence", () => {
    const s = buildRetryStrategy({ category: "parse", recoverable: true, suggestedAction: "" }, []);
    expect(s.maxRetries).toBe(1);
  });

  test("returns maxRetries=0 when prior parse attempts exist (ask once only)", () => {
    const prior = [makeRecord("Bash", "parse", false)];
    const s = buildRetryStrategy({ category: "parse", recoverable: true, suggestedAction: "" }, prior);
    expect(s.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildRetryStrategy — permission
// ---------------------------------------------------------------------------

describe("buildRetryStrategy — permission", () => {
  test("returns maxRetries=0 (cannot self-heal)", () => {
    const s = buildRetryStrategy({ category: "permission", recoverable: false, suggestedAction: "" });
    expect(s.maxRetries).toBe(0);
  });

  test("returns delay=0 (no point waiting)", () => {
    const s = buildRetryStrategy({ category: "permission", recoverable: false, suggestedAction: "" });
    expect(s.delay).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildRetryStrategy — transient
// ---------------------------------------------------------------------------

describe("buildRetryStrategy — transient", () => {
  test("returns maxRetries=3", () => {
    const s = buildRetryStrategy({ category: "transient", recoverable: true, suggestedAction: "" });
    expect(s.maxRetries).toBe(3);
  });

  test("delay doubles with each prior attempt (exponential back-off)", () => {
    const s0 = buildRetryStrategy({ category: "transient", recoverable: true, suggestedAction: "" }, []);
    const s1 = buildRetryStrategy(
      { category: "transient", recoverable: true, suggestedAction: "" },
      [makeRecord("T", "transient", false)]
    );
    expect(s1.delay).toBeGreaterThan(s0.delay);
    expect(s1.delay).toBe(s0.delay * 2);
  });
});

// ---------------------------------------------------------------------------
// Retry history ring buffer
// ---------------------------------------------------------------------------

describe("retry history ring buffer", () => {
  beforeEach(() => resetRetryHistory());

  test("starts empty", () => {
    expect(getRetryHistory()).toHaveLength(0);
  });

  test("records attempts", () => {
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    recordRetryAttempt(makeRecord("Read", "not-found", false));
    expect(getRetryHistory()).toHaveLength(2);
  });

  test("reset clears all records", () => {
    recordRetryAttempt(makeRecord("Bash", "transient", true));
    resetRetryHistory();
    expect(getRetryHistory()).toHaveLength(0);
  });

  test("getRetryHistory returns a snapshot (not a live ref)", () => {
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    const snap = getRetryHistory();
    recordRetryAttempt(makeRecord("Read", "not-found", false));
    expect(snap).toHaveLength(1);
    expect(getRetryHistory()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getRetryStats / formatRetryStats
// ---------------------------------------------------------------------------

describe("getRetryStats", () => {
  beforeEach(() => resetRetryHistory());

  test("returns empty array when no retries recorded", () => {
    expect(getRetryStats()).toHaveLength(0);
  });

  test("computes correct success rate", () => {
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    recordRetryAttempt(makeRecord("Bash", "timeout", false));
    recordRetryAttempt(makeRecord("Bash", "transient", true));

    const stats = getRetryStats();
    expect(stats).toHaveLength(1);
    const bashStats = stats[0]!;
    expect(bashStats.toolName).toBe("Bash");
    expect(bashStats.totalRetries).toBe(3);
    expect(bashStats.successfulRetries).toBe(2);
    expect(bashStats.successRate).toBeCloseTo(2 / 3);
  });

  test("aggregates category counts correctly", () => {
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    recordRetryAttempt(makeRecord("Bash", "transient", false));

    const stats = getRetryStats();
    const bash = stats[0]!;
    expect(bash.categoryCounts.timeout).toBe(2);
    expect(bash.categoryCounts.transient).toBe(1);
  });

  test("sorts by total retries descending", () => {
    recordRetryAttempt(makeRecord("Read", "not-found", true));
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    recordRetryAttempt(makeRecord("Bash", "timeout", false));
    recordRetryAttempt(makeRecord("Bash", "transient", true));

    const stats = getRetryStats();
    expect(stats[0]!.toolName).toBe("Bash");
    expect(stats[1]!.toolName).toBe("Read");
  });
});

describe("formatRetryStats", () => {
  beforeEach(() => resetRetryHistory());

  test("returns no-data message when empty", () => {
    expect(formatRetryStats()).toContain("No tool retries");
  });

  test("includes overall recovery rate", () => {
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    recordRetryAttempt(makeRecord("Bash", "timeout", true));
    const output = formatRetryStats();
    expect(output).toContain("100%");
  });

  test("includes tool name in output", () => {
    recordRetryAttempt(makeRecord("MySpecialTool", "transient", false));
    const output = formatRetryStats();
    expect(output).toContain("MySpecialTool");
  });
});
