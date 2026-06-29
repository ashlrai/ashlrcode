/**
 * Tests for PromotionScoreCache — tier score memoization with TTL + file invalidation.
 *
 * Coverage:
 *   - buildCacheKey: same inputs → same key, different inputs → different key
 *   - PromotionScoreCache.get/set: basic round-trip
 *   - PromotionScoreCache: TTL expiry (lazy eviction on get)
 *   - PromotionScoreCache: LRU capacity eviction
 *   - PromotionScoreCache: file-change invalidation via notifyFileChange()
 *   - PromotionScoreCache: sweepExpired() bulk TTL eviction
 *   - PromotionScoreCache: stats() hit/miss/eviction counters
 *   - PromotionScoreCache: resetStats() zeros counters without clearing entries
 *   - PromotionScoreCache: clear() removes all entries
 *   - Module singleton: getPromotionScoreCache, setPromotionScoreCache, resetPromotionScoreCache
 */

import { describe, test, it, expect, beforeEach } from "bun:test";

import {
  PromotionScoreCache,
  buildCacheKey,
  buildEditsFingerprint,
  getPromotionScoreCache,
  setPromotionScoreCache,
  resetPromotionScoreCache,
} from "../agent/promotion-score-cache.ts";
import type { TierScores, CodebaseContext } from "../agent/surgical-proposer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scores(n: number, m: number, w: number): TierScores {
  return { narrow: n, medium: m, wide: w };
}

const CTX_A: CodebaseContext = { fileCount: 10, recentEdits: ["src/a.ts", "src/b.ts"], cwd: "/proj" };
const CTX_B: CodebaseContext = { fileCount: 200, recentEdits: ["lib/c.ts"], cwd: "/proj" };

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
  it("returns a non-empty string", () => {
    const k = buildCacheKey("fix typo", CTX_A);
    expect(typeof k).toBe("string");
    expect(k.length).toBeGreaterThan(0);
  });

  it("same goal + context → same key", () => {
    expect(buildCacheKey("fix typo", CTX_A)).toBe(buildCacheKey("fix typo", CTX_A));
  });

  it("different goal → different key", () => {
    expect(buildCacheKey("fix typo", CTX_A)).not.toBe(buildCacheKey("refactor auth", CTX_A));
  });

  it("different context → different key", () => {
    expect(buildCacheKey("fix typo", CTX_A)).not.toBe(buildCacheKey("fix typo", CTX_B));
  });

  it("recentEdits order doesn't affect key (sorted internally)", () => {
    const k1 = buildCacheKey("g", { recentEdits: ["a.ts", "b.ts"] });
    const k2 = buildCacheKey("g", { recentEdits: ["b.ts", "a.ts"] });
    expect(k1).toBe(k2);
  });

  it("empty context is handled", () => {
    expect(() => buildCacheKey("fix typo", {})).not.toThrow();
  });

  it("key length is 16 hex chars (truncated SHA-256)", () => {
    const k = buildCacheKey("fix typo", CTX_A);
    expect(k).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// buildEditsFingerprint
// ---------------------------------------------------------------------------

describe("buildEditsFingerprint", () => {
  it("returns sorted join", () => {
    expect(buildEditsFingerprint(["b.ts", "a.ts"])).toBe("a.ts|b.ts");
  });

  it("empty list returns empty string", () => {
    expect(buildEditsFingerprint([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PromotionScoreCache — basic get/set
// ---------------------------------------------------------------------------

describe("PromotionScoreCache — get/set", () => {
  let cache: PromotionScoreCache;

  beforeEach(() => {
    cache = new PromotionScoreCache({ ttlMs: 30_000 });
  });

  it("get on empty cache returns undefined", () => {
    expect(cache.get("missing-key")).toBeUndefined();
  });

  it("set then get returns the stored scores", () => {
    const key = buildCacheKey("fix typo", CTX_A);
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A);
    const entry = cache.get(key);
    expect(entry).toBeDefined();
    expect(entry!.scores.narrow).toBeCloseTo(0.9);
    expect(entry!.scores.medium).toBeCloseTo(0.05);
    expect(entry!.scores.wide).toBeCloseTo(0.05);
  });

  it("stored entry has a storedAt timestamp", () => {
    const key = buildCacheKey("fix typo", CTX_A);
    const before = Date.now();
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A);
    const after = Date.now();
    const entry = cache.get(key);
    expect(entry!.storedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.storedAt).toBeLessThanOrEqual(after);
  });

  it("stored entry key matches the lookup key", () => {
    const key = buildCacheKey("fix typo", CTX_A);
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A);
    const entry = cache.get(key);
    expect(entry!.key).toBe(key);
  });

  it("size increases with each new entry", () => {
    expect(cache.size).toBe(0);
    cache.set(buildCacheKey("fix typo", CTX_A), scores(0.9, 0.05, 0.05), CTX_A);
    expect(cache.size).toBe(1);
    cache.set(buildCacheKey("refactor", CTX_A), scores(0.1, 0.2, 0.7), CTX_A);
    expect(cache.size).toBe(2);
  });

  it("overwriting an existing key does not increase size", () => {
    const key = buildCacheKey("fix typo", CTX_A);
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A);
    cache.set(key, scores(0.8, 0.10, 0.10), CTX_A);
    expect(cache.size).toBe(1);
    expect(cache.get(key)!.scores.narrow).toBeCloseTo(0.8);
  });
});

// ---------------------------------------------------------------------------
// PromotionScoreCache — TTL expiry
// ---------------------------------------------------------------------------

describe("PromotionScoreCache — TTL expiry", () => {
  it("entry is available before TTL expires", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    const key = "ttl-key";
    cache.set(key, scores(0.9, 0.05, 0.05));
    expect(cache.get(key)).toBeDefined();
  });

  it("entry returns undefined after TTL (via artificial storedAt manipulation)", () => {
    const cache = new PromotionScoreCache({ ttlMs: 100 });
    const key = "expired-key";
    cache.set(key, scores(0.9, 0.05, 0.05));

    // Manually expire by reaching into the store (white-box)
    const store = (cache as unknown as { store: Map<string, { storedAt: number }> }).store;
    store.get(key)!.storedAt = Date.now() - 200; // 200ms ago, TTL=100ms

    expect(cache.get(key)).toBeUndefined();
  });

  it("expired entry is evicted (size decreases) on lazy read", () => {
    const cache = new PromotionScoreCache({ ttlMs: 100 });
    const key = "evict-key";
    cache.set(key, scores(0.9, 0.05, 0.05));
    expect(cache.size).toBe(1);

    const store = (cache as unknown as { store: Map<string, { storedAt: number }> }).store;
    store.get(key)!.storedAt = Date.now() - 200;

    cache.get(key); // triggers lazy eviction
    expect(cache.size).toBe(0);
  });

  it("sweepExpired removes all expired entries", () => {
    const cache = new PromotionScoreCache({ ttlMs: 100 });
    cache.set("k1", scores(0.9, 0.05, 0.05));
    cache.set("k2", scores(0.8, 0.10, 0.10));

    const store = (cache as unknown as { store: Map<string, { storedAt: number }> }).store;
    for (const entry of store.values()) {
      entry.storedAt = Date.now() - 200;
    }

    const evicted = cache.sweepExpired();
    expect(evicted).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("sweepExpired leaves non-expired entries intact", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    cache.set("k1", scores(0.9, 0.05, 0.05));
    cache.set("k2", scores(0.8, 0.10, 0.10));

    const evicted = cache.sweepExpired();
    expect(evicted).toBe(0);
    expect(cache.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PromotionScoreCache — capacity / LRU eviction
// ---------------------------------------------------------------------------

describe("PromotionScoreCache — capacity eviction", () => {
  it("evicts oldest entry when maxEntries is exceeded", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000, maxEntries: 3 });
    cache.set("k1", scores(0.9, 0.05, 0.05));
    cache.set("k2", scores(0.8, 0.10, 0.10));
    cache.set("k3", scores(0.7, 0.20, 0.10));
    // Adding k4 should evict k1 (oldest)
    cache.set("k4", scores(0.6, 0.30, 0.10));

    expect(cache.size).toBe(3);
    expect(cache.get("k1")).toBeUndefined(); // evicted
    expect(cache.get("k4")).toBeDefined();
  });

  it("does not evict when capacity is not exceeded", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000, maxEntries: 5 });
    cache.set("k1", scores(0.9, 0.05, 0.05));
    cache.set("k2", scores(0.8, 0.10, 0.10));
    expect(cache.size).toBe(2);
    expect(cache.get("k1")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PromotionScoreCache — file-change invalidation
// ---------------------------------------------------------------------------

describe("PromotionScoreCache — file-change invalidation", () => {
  it("notifyFileChange evicts entries that include the changed file", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    const key = buildCacheKey("fix typo", CTX_A);
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A); // CTX_A has src/a.ts, src/b.ts
    expect(cache.get(key)).toBeDefined();

    cache.notifyFileChange("src/a.ts");
    expect(cache.get(key)).toBeUndefined(); // evicted
  });

  it("notifyFileChange does NOT evict entries that don't include the changed file", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    const keyA = buildCacheKey("fix typo", CTX_A); // has src/a.ts
    const keyB = buildCacheKey("refactor", CTX_B);  // has lib/c.ts
    cache.set(keyA, scores(0.9, 0.05, 0.05), CTX_A);
    cache.set(keyB, scores(0.1, 0.2, 0.7), CTX_B);

    cache.notifyFileChange("lib/c.ts"); // only affects keyB
    expect(cache.get(keyA)).toBeDefined(); // untouched
    expect(cache.get(keyB)).toBeUndefined(); // evicted
  });

  it("notifyFileChange for unknown file has no effect", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    const key = buildCacheKey("fix typo", CTX_A);
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A);

    cache.notifyFileChange("totally/unknown/file.ts");
    expect(cache.get(key)).toBeDefined(); // still there
  });

  it("entry without recentEdits is not evicted by file change", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    const key = buildCacheKey("fix typo", {}); // no recentEdits
    cache.set(key, scores(0.9, 0.05, 0.05), {});

    cache.notifyFileChange("src/anything.ts");
    expect(cache.get(key)).toBeDefined(); // untouched
  });
});

// ---------------------------------------------------------------------------
// PromotionScoreCache — stats and clear
// ---------------------------------------------------------------------------

describe("PromotionScoreCache — stats", () => {
  it("starts with zero stats", () => {
    const cache = new PromotionScoreCache();
    const s = cache.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.evictions).toBe(0);
    expect(s.hitRate).toBe(0);
  });

  it("tracks misses", () => {
    const cache = new PromotionScoreCache();
    cache.get("nonexistent");
    cache.get("also-missing");
    expect(cache.stats().misses).toBe(2);
  });

  it("tracks hits", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    cache.set("k", scores(0.9, 0.05, 0.05));
    cache.get("k");
    cache.get("k");
    expect(cache.stats().hits).toBe(2);
  });

  it("hitRate = hits / (hits + misses)", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    cache.set("k", scores(0.9, 0.05, 0.05));
    cache.get("missing"); // miss
    cache.get("k");       // hit
    cache.get("k");       // hit
    const s = cache.stats();
    expect(s.hitRate).toBeCloseTo(2 / 3);
  });

  it("tracks evictions from notifyFileChange", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    const key = buildCacheKey("fix", CTX_A);
    cache.set(key, scores(0.9, 0.05, 0.05), CTX_A);
    cache.notifyFileChange("src/a.ts");
    expect(cache.stats().evictions).toBe(1);
  });

  it("tracks evictions from clear()", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    cache.set("k1", scores(0.9, 0.05, 0.05));
    cache.set("k2", scores(0.8, 0.1, 0.1));
    cache.clear();
    expect(cache.stats().evictions).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("resetStats zeros counters without clearing entries", () => {
    const cache = new PromotionScoreCache({ ttlMs: 60_000 });
    cache.set("k", scores(0.9, 0.05, 0.05));
    cache.get("k");     // hit
    cache.get("miss");  // miss
    cache.resetStats();
    const s = cache.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(cache.size).toBe(1); // entry still present
  });
});

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------

describe("Module-level singleton", () => {
  beforeEach(() => {
    resetPromotionScoreCache();
  });

  it("getPromotionScoreCache returns a PromotionScoreCache", () => {
    const c = getPromotionScoreCache();
    expect(c).toBeInstanceOf(PromotionScoreCache);
  });

  it("getPromotionScoreCache returns the same instance on repeated calls", () => {
    const c1 = getPromotionScoreCache();
    const c2 = getPromotionScoreCache();
    expect(c1).toBe(c2);
  });

  it("setPromotionScoreCache replaces the singleton", () => {
    const custom = new PromotionScoreCache({ ttlMs: 1_000 });
    setPromotionScoreCache(custom);
    expect(getPromotionScoreCache()).toBe(custom);
  });

  it("resetPromotionScoreCache causes getPromotionScoreCache to return a fresh instance", () => {
    const first = getPromotionScoreCache();
    resetPromotionScoreCache();
    const second = getPromotionScoreCache();
    expect(second).not.toBe(first);
  });
});
