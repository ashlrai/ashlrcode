/**
 * Tests for tool-capability-cache.ts
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  getCachedCapability,
  setCachedCapability,
  clearCapabilityCache,
  getAllCachedEntries,
  isCacheStale,
  isWarmUpRequested,
  runCapabilityWarmUp,
  formatWarmUpSummary,
  CAPABILITY_CACHE_TTL_MS,
  HIGH_LATENCY_THRESHOLD_MS,
  WARMUP_PROVIDERS,
  WARMUP_TOOLS,
  type ToolCapabilityEntry,
} from "../agent/tool-capability-cache.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  toolName: string,
  provider: "xai" | "anthropic" | "openai" | "ollama",
  capability: "native" | "emulated" | "unsupported" = "native",
  latencyMs = 5,
  ageMs = 0,
): ToolCapabilityEntry {
  return {
    toolName,
    provider,
    capability,
    cost_delta: capability === "native" ? 0 : capability === "unsupported" ? 1.0 : 0.15,
    latencyMs,
    last_tested: new Date(Date.now() - ageMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// In-memory cache CRUD
// ---------------------------------------------------------------------------

describe("ToolCapabilityCache — in-memory CRUD", () => {
  beforeEach(() => clearCapabilityCache());
  afterEach(() => clearCapabilityCache());

  test("getCachedCapability returns null for missing entry", () => {
    expect(getCachedCapability("Read", "xai")).toBeNull();
  });

  test("setCachedCapability + getCachedCapability round-trip", () => {
    const entry = makeEntry("Read", "xai", "native", 3);
    setCachedCapability(entry);
    const got = getCachedCapability("Read", "xai");
    expect(got).not.toBeNull();
    expect(got!.toolName).toBe("Read");
    expect(got!.provider).toBe("xai");
    expect(got!.capability).toBe("native");
    expect(got!.latencyMs).toBe(3);
  });

  test("setCachedCapability overwrites existing entry", () => {
    setCachedCapability(makeEntry("Read", "xai", "native", 3));
    setCachedCapability(makeEntry("Read", "xai", "emulated", 25));
    const got = getCachedCapability("Read", "xai");
    expect(got!.capability).toBe("emulated");
    expect(got!.latencyMs).toBe(25);
  });

  test("getCachedCapability returns null for expired entry", () => {
    const expired = makeEntry("Grep", "anthropic", "native", 4, CAPABILITY_CACHE_TTL_MS + 1000);
    setCachedCapability(expired);
    expect(getCachedCapability("Grep", "anthropic")).toBeNull();
  });

  test("getCachedCapability returns entry within TTL", () => {
    const fresh = makeEntry("Glob", "openai", "native", 6, CAPABILITY_CACHE_TTL_MS / 2);
    setCachedCapability(fresh);
    expect(getCachedCapability("Glob", "openai")).not.toBeNull();
  });

  test("getAllCachedEntries returns all live entries", () => {
    setCachedCapability(makeEntry("Read", "xai"));
    setCachedCapability(makeEntry("Grep", "anthropic"));
    setCachedCapability(makeEntry("Glob", "openai", "emulated", 30, CAPABILITY_CACHE_TTL_MS + 1000)); // expired
    const entries = getAllCachedEntries();
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.toolName);
    expect(names).toContain("Read");
    expect(names).toContain("Grep");
  });

  test("clearCapabilityCache removes all entries", () => {
    setCachedCapability(makeEntry("Read", "xai"));
    setCachedCapability(makeEntry("Grep", "anthropic"));
    clearCapabilityCache();
    expect(getAllCachedEntries()).toHaveLength(0);
  });

  test("different providers stored independently", () => {
    setCachedCapability(makeEntry("Read", "xai", "native", 2));
    setCachedCapability(makeEntry("Read", "anthropic", "emulated", 20));
    expect(getCachedCapability("Read", "xai")!.capability).toBe("native");
    expect(getCachedCapability("Read", "anthropic")!.capability).toBe("emulated");
  });

  test("unsupported entries are stored and retrieved", () => {
    setCachedCapability(makeEntry("Bash", "ollama", "unsupported", 0));
    const got = getCachedCapability("Bash", "ollama");
    expect(got!.capability).toBe("unsupported");
    expect(got!.cost_delta).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe("isCacheStale", () => {
  beforeEach(() => clearCapabilityCache());
  afterEach(() => clearCapabilityCache());

  test("returns true when cache is empty", () => {
    expect(isCacheStale()).toBe(true);
  });

  test("returns false when entries are fresh", () => {
    for (const tool of ["Read", "Grep", "Glob", "LS"]) {
      setCachedCapability(makeEntry(tool, "xai", "native", 3, 0));
    }
    expect(isCacheStale()).toBe(false);
  });

  test("returns true when majority of entries are older than half TTL", () => {
    const halfTtl = CAPABILITY_CACHE_TTL_MS / 2;
    for (const tool of ["Read", "Grep", "Glob"]) {
      setCachedCapability(makeEntry(tool, "xai", "native", 3, halfTtl + 60_000));
    }
    setCachedCapability(makeEntry("LS", "xai", "native", 3, 0));
    expect(isCacheStale()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isWarmUpRequested
// ---------------------------------------------------------------------------

describe("isWarmUpRequested", () => {
  test("returns false when AC_WARMUP is unset", () => {
    const prev = process.env.AC_WARMUP;
    delete process.env.AC_WARMUP;
    expect(isWarmUpRequested()).toBe(false);
    if (prev !== undefined) process.env.AC_WARMUP = prev;
  });

  test("returns true when AC_WARMUP=1", () => {
    const prev = process.env.AC_WARMUP;
    process.env.AC_WARMUP = "1";
    expect(isWarmUpRequested()).toBe(true);
    if (prev !== undefined) process.env.AC_WARMUP = prev;
    else delete process.env.AC_WARMUP;
  });

  test("returns false when AC_WARMUP=0", () => {
    const prev = process.env.AC_WARMUP;
    process.env.AC_WARMUP = "0";
    expect(isWarmUpRequested()).toBe(false);
    if (prev !== undefined) process.env.AC_WARMUP = prev;
    else delete process.env.AC_WARMUP;
  });
});

// ---------------------------------------------------------------------------
// runCapabilityWarmUp
// ---------------------------------------------------------------------------

describe("runCapabilityWarmUp", () => {
  beforeEach(() => clearCapabilityCache());
  afterEach(() => clearCapabilityCache());

  test("runs without throwing", async () => {
    const summary = await runCapabilityWarmUp();
    expect(summary).toBeDefined();
    expect(summary.results).toBeArray();
    expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("returns results for all WARMUP_PROVIDERS", async () => {
    const summary = await runCapabilityWarmUp();
    const providersSeen = summary.results.map((r) => r.provider);
    for (const p of WARMUP_PROVIDERS) {
      expect(providersSeen).toContain(p);
    }
  });

  test("populates entries for each provider", async () => {
    const summary = await runCapabilityWarmUp();
    for (const pr of summary.results) {
      if (!pr.error) {
        expect(pr.entries.length).toBeGreaterThan(0);
      }
    }
  });

  test("entries are stored in the in-memory cache", async () => {
    await runCapabilityWarmUp();
    const entries = getAllCachedEntries();
    // At minimum the tools × providers that had no errors
    expect(entries.length).toBeGreaterThan(0);
  });

  test("each entry has required fields", async () => {
    const summary = await runCapabilityWarmUp();
    for (const pr of summary.results) {
      for (const e of pr.entries) {
        expect(e.toolName).toBeString();
        expect(e.provider).toBeString();
        expect(["native", "emulated", "unsupported"]).toContain(e.capability);
        expect(typeof e.cost_delta).toBe("number");
        expect(typeof e.latencyMs).toBe("number");
        expect(e.last_tested).toBeString();
        // last_tested should be parseable as ISO date
        expect(new Date(e.last_tested).getTime()).toBeGreaterThan(0);
      }
    }
  });

  test("summaryLine mentions providers and entries", async () => {
    const summary = await runCapabilityWarmUp();
    expect(summary.summaryLine).toContain("provider");
    expect(summary.summaryLine).toContain("entries");
  });

  test("invokes progress callback for each provider", async () => {
    const calls: Array<{ provider: string; done: number; total: number }> = [];
    await runCapabilityWarmUp((provider, done, total) => {
      calls.push({ provider, done, total });
    });
    expect(calls.length).toBe(WARMUP_PROVIDERS.length);
    expect(calls[0]!.done).toBe(1);
    expect(calls[WARMUP_PROVIDERS.length - 1]!.done).toBe(WARMUP_PROVIDERS.length);
    for (const c of calls) {
      expect(c.total).toBe(WARMUP_PROVIDERS.length);
    }
  });

  test("totalDurationMs is positive", async () => {
    const summary = await runCapabilityWarmUp();
    expect(summary.totalDurationMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatWarmUpSummary
// ---------------------------------------------------------------------------

describe("formatWarmUpSummary", () => {
  test("returns a non-empty string", async () => {
    const summary = await runCapabilityWarmUp();
    const str = formatWarmUpSummary(summary);
    expect(str).toBeString();
    expect(str.length).toBeGreaterThan(0);
  });

  test("includes provider names", async () => {
    clearCapabilityCache();
    const summary = await runCapabilityWarmUp();
    const str = formatWarmUpSummary(summary);
    // At least one provider should appear
    const hasProvider = WARMUP_PROVIDERS.some((p) => str.includes(p));
    expect(hasProvider).toBe(true);
  });

  test("includes summaryLine in output", async () => {
    clearCapabilityCache();
    const summary = await runCapabilityWarmUp();
    const str = formatWarmUpSummary(summary);
    expect(str).toContain(summary.summaryLine);
  });

  test("includes capability column header", async () => {
    clearCapabilityCache();
    const summary = await runCapabilityWarmUp();
    const str = formatWarmUpSummary(summary);
    expect(str).toContain("Capability");
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("CAPABILITY_CACHE_TTL_MS is 24 hours", () => {
    expect(CAPABILITY_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("HIGH_LATENCY_THRESHOLD_MS is 100", () => {
    expect(HIGH_LATENCY_THRESHOLD_MS).toBe(100);
  });

  test("WARMUP_PROVIDERS includes core providers", () => {
    expect(WARMUP_PROVIDERS).toContain("xai");
    expect(WARMUP_PROVIDERS).toContain("anthropic");
    expect(WARMUP_PROVIDERS).toContain("openai");
    expect(WARMUP_PROVIDERS).toContain("ollama");
  });

  test("WARMUP_TOOLS includes standard read tools", () => {
    expect(WARMUP_TOOLS).toContain("Read");
    expect(WARMUP_TOOLS).toContain("Grep");
    expect(WARMUP_TOOLS).toContain("Glob");
    expect(WARMUP_TOOLS).toContain("LS");
  });
});
