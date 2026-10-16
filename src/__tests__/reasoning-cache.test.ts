/**
 * Tests for Multi-Model Reasoning Transcript Inference Engine
 * src/agent/reasoning-cache.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ReasoningCache,
  REASONING_CACHE_MAX_ENTRIES,
  REASONING_CACHE_TTL_MS,
  REASONING_SIMILARITY_THRESHOLD,
  appendEntry,
  goalHash,
  jaccardSimilarity,
  loadEntries,
  trigrams,
  getGlobalReasoningCache,
  resetGlobalReasoningCache,
  setGlobalReasoningCache,
  type ReasoningEntry,
} from "../agent/reasoning-cache.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let cachePath: string;

function setup(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "reasoning-cache-test-"));
  cachePath = join(tmpDir, "reasoning-cache.jsonl");
}

function cleanup(): void {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  resetGlobalReasoningCache();
}

function makeEntry(overrides: Partial<ReasoningEntry> = {}): ReasoningEntry {
  return {
    hash: goalHash("default goal"),
    goal: "default goal",
    thinking_text: "Let me think step by step about this problem...",
    provider: "anthropic",
    timestamp: new Date().toISOString(),
    tokens_saved: 12,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// goalHash
// ---------------------------------------------------------------------------

describe("goalHash", () => {
  test("produces a 16-char hex string", () => {
    const h = goalHash("hello world");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic for the same input", () => {
    expect(goalHash("same")).toBe(goalHash("same"));
  });

  test("normalizes case and whitespace", () => {
    expect(goalHash("Hello World")).toBe(goalHash("hello world"));
    expect(goalHash("  hello  ")).toBe(goalHash("hello"));
  });

  test("different goals produce different hashes", () => {
    expect(goalHash("goal A")).not.toBe(goalHash("goal B"));
  });
});

// ---------------------------------------------------------------------------
// trigrams
// ---------------------------------------------------------------------------

describe("trigrams", () => {
  test("empty string produces empty set", () => {
    expect(trigrams("").size).toBe(0);
  });

  test("short string produces few trigrams", () => {
    // "ab" → 0 trigrams (needs length >= 3)
    expect(trigrams("ab").size).toBe(0);
    // "abc" → 1 trigram
    expect(trigrams("abc").size).toBe(1);
  });

  test("identical strings produce identical trigram sets", () => {
    const a = trigrams("hello world");
    const b = trigrams("hello world");
    expect(a.size).toBe(b.size);
    for (const t of a) expect(b.has(t)).toBe(true);
  });

  test("normalizes to lowercase", () => {
    const lower = trigrams("abc");
    const upper = trigrams("ABC");
    expect(lower.size).toBe(upper.size);
    for (const t of lower) expect(upper.has(t)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  test("identical sets → similarity 1", () => {
    const s = new Set(["abc", "bcd", "cde"]);
    expect(jaccardSimilarity(s, s)).toBeCloseTo(1.0);
  });

  test("disjoint sets → similarity 0", () => {
    const a = new Set(["abc", "bcd"]);
    const b = new Set(["xyz", "yza"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  test("both empty → similarity 1", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test("one empty → similarity 0", () => {
    expect(jaccardSimilarity(new Set(["abc"]), new Set())).toBe(0);
  });

  test("partial overlap returns fractional score", () => {
    const a = new Set(["abc", "bcd", "cde"]);
    const b = new Set(["abc", "bcd", "xyz"]);
    // intersection = 2, union = 4 → 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  test("similar goals score above threshold", () => {
    const goal1 = "implement authentication with JWT tokens";
    const goal2 = "add JWT token authentication to the API";
    const score = jaccardSimilarity(trigrams(goal1), trigrams(goal2));
    expect(score).toBeGreaterThan(REASONING_SIMILARITY_THRESHOLD);
  });

  test("unrelated goals score below threshold", () => {
    const goal1 = "fix the login button CSS alignment";
    const goal2 = "optimize database query performance";
    const score = jaccardSimilarity(trigrams(goal1), trigrams(goal2));
    expect(score).toBeLessThan(REASONING_SIMILARITY_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// loadEntries / appendEntry
// ---------------------------------------------------------------------------

describe("loadEntries", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("returns empty array for missing file", async () => {
    const entries = await loadEntries(cachePath);
    expect(entries).toEqual([]);
  });

  test("loads a valid entry", async () => {
    const entry = makeEntry();
    await appendEntry(entry, cachePath);
    const loaded = await loadEntries(cachePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.hash).toBe(entry.hash);
    expect(loaded[0]!.goal).toBe(entry.goal);
    expect(loaded[0]!.provider).toBe("anthropic");
  });

  test("skips expired entries (beyond TTL)", async () => {
    const old = makeEntry({
      timestamp: new Date(Date.now() - REASONING_CACHE_TTL_MS - 1000).toISOString(),
    });
    await appendEntry(old, cachePath);
    const loaded = await loadEntries(cachePath);
    expect(loaded).toHaveLength(0);
  });

  test("keeps entries within TTL", async () => {
    const recent = makeEntry({
      timestamp: new Date(Date.now() - 1000).toISOString(),
    });
    await appendEntry(recent, cachePath);
    const loaded = await loadEntries(cachePath);
    expect(loaded).toHaveLength(1);
  });

  test("handles corrupt JSON lines gracefully", async () => {
    const { writeFile } = await import("fs/promises");
    await writeFile(cachePath, 'not valid json\n{"hash":"a","goal":"g","thinking_text":"t","provider":"p","timestamp":"' + new Date().toISOString() + '","tokens_saved":1}\n', "utf-8");
    const loaded = await loadEntries(cachePath);
    expect(loaded).toHaveLength(1); // only the valid line
  });

  test("multiple entries round-trip", async () => {
    const e1 = makeEntry({ hash: goalHash("goal one"), goal: "goal one" });
    const e2 = makeEntry({ hash: goalHash("goal two"), goal: "goal two" });
    await appendEntry(e1, cachePath);
    await appendEntry(e2, cachePath);
    const loaded = await loadEntries(cachePath);
    expect(loaded).toHaveLength(2);
  });
});

describe("appendEntry — deduplication and eviction", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("deduplicates entries with the same hash", async () => {
    const e1 = makeEntry({ thinking_text: "first version" });
    const e2 = makeEntry({ thinking_text: "updated version" });
    await appendEntry(e1, cachePath);
    await appendEntry(e2, cachePath);
    const loaded = await loadEntries(cachePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.thinking_text).toBe("updated version");
  });

  test("evicts oldest entries when exceeding max size", async () => {
    // Write MAX + 10 entries
    const count = REASONING_CACHE_MAX_ENTRIES + 10;
    for (let i = 0; i < count; i++) {
      await appendEntry(
        makeEntry({
          hash: goalHash(`unique goal ${i}`),
          goal: `unique goal ${i}`,
        }),
        cachePath
      );
    }
    const loaded = await loadEntries(cachePath);
    expect(loaded.length).toBeLessThanOrEqual(REASONING_CACHE_MAX_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// ReasoningCache class
// ---------------------------------------------------------------------------

describe("ReasoningCache.store + findSimilar", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("stores and retrieves by exact hash match", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("fix the bug in auth module", "I should check the token expiry...", "anthropic");
    const found = await rc.findSimilar("fix the bug in auth module");
    expect(found).not.toBeNull();
    expect(found!.thinking_text).toBe("I should check the token expiry...");
    expect(found!.provider).toBe("anthropic");
  });

  test("returns null for unrelated goal", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("implement authentication", "thinking about JWT...", "anthropic");
    const found = await rc.findSimilar("deploy to production server now");
    expect(found).toBeNull();
  });

  test("finds similar goal via trigram similarity", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store(
      "implement JWT authentication for the API",
      "I need to check token signing and expiry validation...",
      "anthropic"
    );
    // Different phrasing but same topic
    const found = await rc.findSimilar("add JWT token authentication to API endpoints");
    expect(found).not.toBeNull();
    expect(found!.thinking_text).toContain("token");
  });

  test("returns null when cache is empty", async () => {
    const rc = new ReasoningCache(cachePath);
    const found = await rc.findSimilar("anything");
    expect(found).toBeNull();
  });

  test("truncates thinking_text at REASONING_MAX_THINKING_CHARS", async () => {
    const rc = new ReasoningCache(cachePath);
    const longThinking = "a".repeat(20_000);
    await rc.store("some goal", longThinking, "anthropic");
    const found = await rc.findSimilar("some goal");
    expect(found).not.toBeNull();
    expect(found!.thinking_text.length).toBeLessThanOrEqual(8_000);
  });

  test("does not store when thinking is empty", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("some goal", "", "anthropic");
    const entries = await loadEntries(cachePath);
    expect(entries).toHaveLength(0);
  });

  test("does not store when goal is empty", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("", "some thinking text", "anthropic");
    const entries = await loadEntries(cachePath);
    expect(entries).toHaveLength(0);
  });
});

describe("ReasoningCache.buildPromptInjection", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("returns empty string when no match found", async () => {
    const rc = new ReasoningCache(cachePath);
    const injection = await rc.buildPromptInjection("completely novel task");
    expect(injection).toBe("");
  });

  test("returns non-empty injection when match found", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("implement auth", "JWT tokens should be signed with RS256...", "anthropic");
    const injection = await rc.buildPromptInjection("implement auth");
    expect(injection.length).toBeGreaterThan(0);
    expect(injection).toContain("Prior Reasoning Context");
    expect(injection).toContain("JWT tokens");
  });

  test("injection contains provider and date info", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("refactor the router", "I should start by reading the existing...", "xai");
    const injection = await rc.buildPromptInjection("refactor the router");
    expect(injection).toContain("xai");
    expect(injection).toMatch(/\d{4}-\d{2}-\d{2}/); // date present
  });

  test("injection is bounded at REASONING_MAX_INJECT_CHARS + overhead", async () => {
    const rc = new ReasoningCache(cachePath);
    const longThinking = "b".repeat(8_000);
    await rc.store("large reasoning goal", longThinking, "anthropic");
    const injection = await rc.buildPromptInjection("large reasoning goal");
    // Injection text + surrounding boilerplate should be reasonable
    expect(injection.length).toBeLessThan(4_000);
  });
});

describe("ReasoningCache stats", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("starts at zero", () => {
    const rc = new ReasoningCache(cachePath);
    const stats = rc.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.totalTokensSaved).toBe(0);
  });

  test("tracks hits and misses", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("implement JWT authentication", "thinking...", "anthropic");

    await rc.findSimilar("implement JWT authentication");      // hit (exact)
    await rc.findSimilar("deploy the production kubernetes"); // miss (unrelated)

    const stats = rc.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  test("tracks tokens saved on hit", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("token goal", "x".repeat(400), "anthropic"); // ~100 tokens
    await rc.findSimilar("token goal");
    const stats = rc.getStats();
    expect(stats.totalTokensSaved).toBeGreaterThan(0);
  });

  test("resetStats zeroes counters", async () => {
    const rc = new ReasoningCache(cachePath);
    await rc.store("some goal", "some thinking", "anthropic");
    await rc.findSimilar("some goal");
    rc.resetStats();
    const stats = rc.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.totalTokensSaved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

describe("global singleton", () => {
  afterEach(cleanup);

  test("getGlobalReasoningCache returns same instance", () => {
    const a = getGlobalReasoningCache();
    const b = getGlobalReasoningCache();
    expect(a).toBe(b);
  });

  test("setGlobalReasoningCache replaces instance", () => {
    const custom = new ReasoningCache(cachePath);
    setGlobalReasoningCache(custom);
    expect(getGlobalReasoningCache()).toBe(custom);
  });

  test("resetGlobalReasoningCache returns fresh instance on next call", () => {
    const first = getGlobalReasoningCache();
    resetGlobalReasoningCache();
    const second = getGlobalReasoningCache();
    expect(first).not.toBe(second);
  });
});
