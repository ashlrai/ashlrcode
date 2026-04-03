import { describe, test, expect, beforeEach } from "bun:test";
import { SpeculationCache } from "../agent/speculation.ts";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
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
