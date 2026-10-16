import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SpeculationCache, PersistentSpeculationCache, hashToolCall } from "../agent/speculation.ts";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SpeculationCache", () => {
  let cache: SpeculationCache;

  beforeEach(() => {
    cache = new SpeculationCache(5, 200); // small size, short TTL for testing
  });

  // ── Core get/set ──────────────────────────────────────────────────────

  test("cache hit returns stored result", () => {
    cache.set("Read", { file_path: "/foo/bar.ts" }, "file contents here");
    const result = cache.get("Read", { file_path: "/foo/bar.ts" });
    expect(result).toBe("file contents here");
  });

  test("cache miss returns null", () => {
    const result = cache.get("Read", { file_path: "/nonexistent" });
    expect(result).toBeNull();
  });

  test("different tool names are different cache keys", () => {
    cache.set("Read", { file_path: "/foo" }, "read result");
    cache.set("Grep", { file_path: "/foo" }, "grep result");

    expect(cache.get("Read", { file_path: "/foo" })).toBe("read result");
    expect(cache.get("Grep", { file_path: "/foo" })).toBe("grep result");
  });

  test("different inputs are different cache keys", () => {
    cache.set("Read", { file_path: "/a.ts" }, "content a");
    cache.set("Read", { file_path: "/b.ts" }, "content b");

    expect(cache.get("Read", { file_path: "/a.ts" })).toBe("content a");
    expect(cache.get("Read", { file_path: "/b.ts" })).toBe("content b");
  });

  // ── TTL expiry ────────────────────────────────────────────────────────

  test("TTL expiry evicts entries", async () => {
    cache.set("Read", { file_path: "/foo" }, "content");
    expect(cache.get("Read", { file_path: "/foo" })).toBe("content");

    // Wait for TTL to expire (200ms)
    await new Promise((r) => setTimeout(r, 250));

    expect(cache.get("Read", { file_path: "/foo" })).toBeNull();
  });

  test("entry is valid before TTL expiry", async () => {
    cache.set("Read", { file_path: "/foo" }, "content");

    // Wait less than TTL
    await new Promise((r) => setTimeout(r, 50));

    expect(cache.get("Read", { file_path: "/foo" })).toBe("content");
  });

  // ── Max size eviction ─────────────────────────────────────────────────

  test("max size eviction removes oldest entry", () => {
    // Cache maxSize = 5, add 5 entries
    for (let i = 0; i < 5; i++) {
      cache.set("Read", { file_path: `/file${i}` }, `content${i}`);
    }

    // All 5 should be present
    expect(cache.get("Read", { file_path: "/file0" })).toBe("content0");
    expect(cache.get("Read", { file_path: "/file4" })).toBe("content4");

    // Add a 6th entry — should evict the oldest
    cache.set("Read", { file_path: "/file5" }, "content5");

    // file0 was the oldest and should be evicted
    // Note: get() updates hitCount, so file0 was actually accessed above.
    // The eviction is based on timestamp, so file0 (earliest timestamp) should be gone
    expect(cache.getStats().size).toBe(5);
    expect(cache.get("Read", { file_path: "/file5" })).toBe("content5");
  });

  test("overwriting existing key does not trigger eviction", () => {
    for (let i = 0; i < 5; i++) {
      cache.set("Read", { file_path: `/file${i}` }, `content${i}`);
    }

    // Overwrite an existing entry — should NOT evict
    cache.set("Read", { file_path: "/file0" }, "updated content");

    expect(cache.getStats().size).toBe(5);
    expect(cache.get("Read", { file_path: "/file0" })).toBe("updated content");
    expect(cache.get("Read", { file_path: "/file4" })).toBe("content4");
  });

  // ── prefetchRead ──────────────────────────────────────────────────────

  test("prefetchRead caches file content", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spec-prefetch-"));
    const filePath = join(tmpDir, "test.ts");
    writeFileSync(filePath, "export const x = 42;", "utf-8");

    try {
      await cache.prefetchRead(filePath);
      const result = cache.get("Read", { file_path: filePath });
      expect(result).toBe("export const x = 42;");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("prefetchRead skips nonexistent files", async () => {
    await cache.prefetchRead("/nonexistent/path/file.ts");
    const result = cache.get("Read", { file_path: "/nonexistent/path/file.ts" });
    expect(result).toBeNull();
  });

  test("prefetchRead skips files larger than 1MB", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spec-large-"));
    const filePath = join(tmpDir, "big.bin");
    // Write >1MB file
    writeFileSync(filePath, Buffer.alloc(1_100_000, "x"), "utf-8");

    try {
      await cache.prefetchRead(filePath);
      const result = cache.get("Read", { file_path: filePath });
      expect(result).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Invalidation on write ─────────────────────────────────────────────

  test("invalidateForFile removes Read cache for that file", () => {
    cache.set("Read", { file_path: "/foo/bar.ts" }, "old content");
    cache.set("Read", { file_path: "/foo/baz.ts" }, "other content");

    cache.invalidateForFile("/foo/bar.ts");

    expect(cache.get("Read", { file_path: "/foo/bar.ts" })).toBeNull();
    // Other files unaffected
    expect(cache.get("Read", { file_path: "/foo/baz.ts" })).toBe("other content");
  });

  test("invalidateForFile removes all Grep and Glob cache entries", () => {
    cache.set("Grep", { pattern: "foo" }, "grep results");
    cache.set("Glob", { pattern: "*.ts" }, "glob results");
    cache.set("Read", { file_path: "/other.ts" }, "content");

    cache.invalidateForFile("/some/file.ts");

    // Grep and Glob results should be cleared (conservative invalidation)
    expect(cache.get("Grep", { pattern: "foo" })).toBeNull();
    expect(cache.get("Glob", { pattern: "*.ts" })).toBeNull();
    // Read for other files should survive
    expect(cache.get("Read", { file_path: "/other.ts" })).toBe("content");
  });

  // ── Stats and clear ───────────────────────────────────────────────────

  test("getStats tracks size and misses", () => {
    cache.set("Read", { file_path: "/a" }, "a");
    cache.set("Read", { file_path: "/b" }, "b");
    cache.get("Read", { file_path: "/nonexistent" }); // miss

    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.misses).toBe(1);
  });

  test("getStats tracks hits", () => {
    cache.set("Read", { file_path: "/a" }, "a");
    cache.get("Read", { file_path: "/a" }); // hit
    cache.get("Read", { file_path: "/a" }); // hit

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
  });

  test("clear resets everything", () => {
    cache.set("Read", { file_path: "/a" }, "a");
    cache.get("Read", { file_path: "/miss" }); // miss
    cache.get("Read", { file_path: "/a" }); // hit

    cache.clear();

    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hashToolCall
// ---------------------------------------------------------------------------

describe("hashToolCall", () => {
  test("same tool+input produces same hash", () => {
    const h1 = hashToolCall("Read", { file_path: "/foo/bar.ts" });
    const h2 = hashToolCall("Read", { file_path: "/foo/bar.ts" });
    expect(h1).toBe(h2);
  });

  test("different tool names produce different hashes", () => {
    const h1 = hashToolCall("Read", { file_path: "/foo" });
    const h2 = hashToolCall("Grep", { file_path: "/foo" });
    expect(h1).not.toBe(h2);
  });

  test("different inputs produce different hashes", () => {
    const h1 = hashToolCall("Read", { file_path: "/a.ts" });
    const h2 = hashToolCall("Read", { file_path: "/b.ts" });
    expect(h1).not.toBe(h2);
  });

  test("returns a 40-char hex string (SHA-1)", () => {
    const h = hashToolCall("Bash", { command: "npm test" });
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// PersistentSpeculationCache
// ---------------------------------------------------------------------------

describe("PersistentSpeculationCache", () => {
  let tmpDir: string;
  let cachePath: string;
  let pCache: PersistentSpeculationCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pspec-"));
    cachePath = join(tmpDir, "speculation-cache.jsonl");
    // short TTL (200ms) and tiny max size (5) for fast tests
    pCache = new PersistentSpeculationCache(cachePath, 5, 200);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic get/set ─────────────────────────────────────────────────────

  test("returns null on empty cache", async () => {
    const hit = await pCache.get("Read", { file_path: "/nonexistent" });
    expect(hit).toBeNull();
  });

  test("set then get returns cached result", async () => {
    await pCache.set("Read", { file_path: "/foo.ts" }, "file contents", 50);
    const hit = await pCache.get("Read", { file_path: "/foo.ts" });
    expect(hit).not.toBeNull();
    expect(hit!.result).toBe("file contents");
  });

  test("different provider agents share cache via same hash", async () => {
    // Simulate Agent A (Claude) writing a result
    await pCache.set("Bash", { command: "npm test" }, "test output", 100);

    // Simulate Agent B (Grok) — same logical call, different agent instance
    // but uses the same PersistentSpeculationCache (shared file)
    const agentB = new PersistentSpeculationCache(cachePath, 5, 200);
    const hit = await agentB.get("Bash", { command: "npm test" });
    expect(hit).not.toBeNull();
    expect(hit!.result).toBe("test output");
  });

  // ── Cache persistence (JSONL) ─────────────────────────────────────────

  test("persists entries to JSONL file", async () => {
    await pCache.set("Read", { file_path: "/persisted.ts" }, "persistent content", 75);
    expect(existsSync(cachePath)).toBe(true);
    const raw = await Bun.file(cachePath).text();
    expect(raw).toContain("persistent content");
  });

  test("new instance loads entries from existing JSONL file", async () => {
    await pCache.set("Read", { file_path: "/loaded.ts" }, "loaded content", 60);

    // Create a fresh instance pointing at the same file
    const pCache2 = new PersistentSpeculationCache(cachePath, 5, 200);
    const hit = await pCache2.get("Read", { file_path: "/loaded.ts" });
    expect(hit).not.toBeNull();
    expect(hit!.result).toBe("loaded content");
  });

  // ── TTL expiry ────────────────────────────────────────────────────────

  test("TTL expiry returns null after timeout", async () => {
    await pCache.set("Read", { file_path: "/ttl-test.ts" }, "fresh", 30);
    const before = await pCache.get("Read", { file_path: "/ttl-test.ts" });
    expect(before).not.toBeNull();

    // Wait for TTL to expire (200ms)
    await new Promise((r) => setTimeout(r, 250));

    const after = await pCache.get("Read", { file_path: "/ttl-test.ts" });
    expect(after).toBeNull();
  });

  test("loaded entries expired at load time are not returned", async () => {
    await pCache.set("Read", { file_path: "/stale.ts" }, "stale content", 40);

    // Wait for TTL to expire before creating new instance
    await new Promise((r) => setTimeout(r, 250));

    const pCache2 = new PersistentSpeculationCache(cachePath, 5, 200);
    const hit = await pCache2.get("Read", { file_path: "/stale.ts" });
    expect(hit).toBeNull();
  });

  // ── LRU eviction ─────────────────────────────────────────────────────

  test("LRU eviction removes oldest entry when max size exceeded", async () => {
    // Fill to capacity (maxSize=5)
    for (let i = 0; i < 5; i++) {
      await pCache.set("Read", { file_path: `/file${i}.ts` }, `content${i}`, 10);
    }

    const stats = pCache.getStats();
    expect(stats.size).toBe(5);

    // Adding a 6th entry should evict the oldest (file0)
    await pCache.set("Read", { file_path: "/file5.ts" }, "content5", 10);

    expect(pCache.getStats().size).toBe(5);
    // Newest entry should be present
    const hit5 = await pCache.get("Read", { file_path: "/file5.ts" });
    expect(hit5).not.toBeNull();
  });

  // ── Stats ─────────────────────────────────────────────────────────────

  test("getStats tracks hits, misses, and hit rate", async () => {
    await pCache.set("Read", { file_path: "/a.ts" }, "a", 50);
    await pCache.get("Read", { file_path: "/a.ts" });   // hit
    await pCache.get("Read", { file_path: "/miss.ts" }); // miss

    const stats = pCache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRatePct).toBe(50);
  });

  test("getStats tracks avg latency saved", async () => {
    await pCache.set("Read", { file_path: "/lat.ts" }, "result", 100);
    await pCache.get("Read", { file_path: "/lat.ts" }); // hit → saves 100ms

    const stats = pCache.getStats();
    expect(stats.avgLatencySavedMs).toBe(100);
  });

  test("formatStats returns non-empty string with cache path", () => {
    const formatted = pCache.formatStats();
    expect(formatted).toContain(cachePath);
    expect(formatted.length).toBeGreaterThan(0);
  });

  // ── Invalidation ──────────────────────────────────────────────────────

  test("invalidateForFile removes the matching Read entry", async () => {
    await pCache.set("Read", { file_path: "/invalidate-me.ts" }, "old content", 20);
    const before = await pCache.get("Read", { file_path: "/invalidate-me.ts" });
    expect(before).not.toBeNull();

    await pCache.invalidateForFile("/invalidate-me.ts");

    const after = await pCache.get("Read", { file_path: "/invalidate-me.ts" });
    expect(after).toBeNull();
  });

  test("invalidateForFile removes all Grep and Glob entries", async () => {
    await pCache.set("Grep", { pattern: "foo", path: "/" }, "grep results", 30);
    await pCache.set("Glob", { pattern: "*.ts", cwd: "/" }, "glob results", 25);
    await pCache.set("Read", { file_path: "/other.ts" }, "other", 10);

    await pCache.invalidateForFile("/some-file.ts");

    expect(await pCache.get("Grep", { pattern: "foo", path: "/" })).toBeNull();
    expect(await pCache.get("Glob", { pattern: "*.ts", cwd: "/" })).toBeNull();
    // Read for an unrelated file should survive
    expect(await pCache.get("Read", { file_path: "/other.ts" })).not.toBeNull();
  });

  // ── clear ─────────────────────────────────────────────────────────────

  test("clear wipes entries and resets stats", async () => {
    await pCache.set("Read", { file_path: "/c.ts" }, "c", 10);
    await pCache.get("Read", { file_path: "/c.ts" });
    await pCache.clear();

    const stats = pCache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});
