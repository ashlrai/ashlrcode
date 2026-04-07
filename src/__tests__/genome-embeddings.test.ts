import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  contentHash,
  cosineSimilarity,
  type EmbeddingCache,
  loadEmbeddingCache,
  saveEmbeddingCache,
} from "../genome/embeddings.ts";
import { createEmptyManifest, genomeDir, saveManifest, writeSection } from "../genome/manifest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "ashlrcode-embeddings-test-"));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity tests
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  test("identical vectors have similarity 1", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  test("orthogonal vectors have similarity 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  test("opposite vectors have similarity -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  test("empty vectors return 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("mismatched lengths return 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test("zero vectors return 0", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  test("similar vectors have high similarity", () => {
    const a = [1, 2, 3, 4];
    const b = [1.1, 2.1, 3.1, 4.1];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });

  test("dissimilar vectors have low similarity", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 0, 0, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// Content hash tests
// ---------------------------------------------------------------------------

describe("contentHash", () => {
  test("produces consistent MD5 hash", () => {
    const hash = contentHash("hello world");
    // MD5 of "hello world" is well-known
    expect(hash).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
  });

  test("different content produces different hashes", () => {
    const a = contentHash("content A");
    const b = contentHash("content B");
    expect(a).not.toBe(b);
  });

  test("same content produces same hash", () => {
    const a = contentHash("identical");
    const b = contentHash("identical");
    expect(a).toBe(b);
  });

  test("returns 32-char hex string", () => {
    const hash = contentHash("test");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Embedding cache persistence tests
// ---------------------------------------------------------------------------

describe("Embedding Cache", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("loadEmbeddingCache returns empty for missing file", async () => {
    const cache = await loadEmbeddingCache(tmpDir);
    expect(cache).toEqual([]);
  });

  test("saveEmbeddingCache + loadEmbeddingCache round-trips", async () => {
    // Need genome dir structure
    const m = createEmptyManifest("test");
    await saveManifest(tmpDir, m);

    const entries: EmbeddingCache[] = [
      {
        sectionPath: "vision/north-star.md",
        embedding: [0.1, 0.2, 0.3],
        contentHash: "abc123",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        sectionPath: "knowledge/deps.md",
        embedding: [0.4, 0.5, 0.6],
        contentHash: "def456",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ];

    await saveEmbeddingCache(tmpDir, entries);
    const loaded = await loadEmbeddingCache(tmpDir);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.sectionPath).toBe("vision/north-star.md");
    expect(loaded[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(loaded[1]!.contentHash).toBe("def456");
  });

  test("saveEmbeddingCache creates evolution directory if missing", async () => {
    // Create genome dir but not evolution subdir
    const m = createEmptyManifest("test");
    await saveManifest(tmpDir, m);

    const dir = join(genomeDir(tmpDir), "evolution");
    // Evolution dir may or may not exist from init; that's fine.
    // The point is saveEmbeddingCache doesn't crash.

    await saveEmbeddingCache(tmpDir, [
      {
        sectionPath: "test.md",
        embedding: [1, 2, 3],
        contentHash: "abc",
        updatedAt: new Date().toISOString(),
      },
    ]);

    const cachePath = join(dir, "embeddings.json");
    expect(existsSync(cachePath)).toBe(true);
  });

  test("loadEmbeddingCache handles corrupt JSON gracefully", async () => {
    const m = createEmptyManifest("test");
    await saveManifest(tmpDir, m);

    // Write corrupt JSON to cache file
    const { mkdir, writeFile } = await import("fs/promises");
    const dir = join(genomeDir(tmpDir), "evolution");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "embeddings.json"), "not valid json{{{", "utf-8");

    const cache = await loadEmbeddingCache(tmpDir);
    expect(cache).toEqual([]);
  });

  test("loadEmbeddingCache handles non-array JSON gracefully", async () => {
    const m = createEmptyManifest("test");
    await saveManifest(tmpDir, m);

    const { mkdir, writeFile } = await import("fs/promises");
    const dir = join(genomeDir(tmpDir), "evolution");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "embeddings.json"), '{"not": "an array"}', "utf-8");

    const cache = await loadEmbeddingCache(tmpDir);
    expect(cache).toEqual([]);
  });

  test("empty cache round-trips", async () => {
    const m = createEmptyManifest("test");
    await saveManifest(tmpDir, m);

    await saveEmbeddingCache(tmpDir, []);
    const loaded = await loadEmbeddingCache(tmpDir);
    expect(loaded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// retrieveSectionsV2 fallback tests
// ---------------------------------------------------------------------------

describe("retrieveSectionsV2", () => {
  beforeEach(setup);
  afterEach(cleanup);

  async function seedGenome(): Promise<void> {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    await writeSection(tmpDir, "vision/north-star.md", "# North Star\n\nBuild an API gateway with auth.", {
      title: "North Star Vision",
      summary: "Build API gateway with authentication",
      tags: ["vision", "api", "gateway", "auth"],
    });

    await writeSection(tmpDir, "milestones/current.md", "# Auth Module\n\nImplement JWT authentication.", {
      title: "Current Milestone",
      summary: "JWT authentication implementation",
      tags: ["milestone", "auth", "jwt"],
    });
  }

  test("falls back to keyword search when Ollama unavailable", async () => {
    await seedGenome();

    // Ollama is not running in test environment, so this should fall back
    const { retrieveSectionsV2 } = await import("../genome/retriever.ts");
    const results = await retrieveSectionsV2(tmpDir, "auth jwt authentication", 50_000);

    // Should still get results from keyword fallback
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("milestones/current.md");
  });

  test("falls back to keyword search for empty query", async () => {
    await seedGenome();

    const { retrieveSectionsV2 } = await import("../genome/retriever.ts");
    const results = await retrieveSectionsV2(tmpDir, "", 50_000);

    // Empty query returns core sections via keyword path
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("vision/north-star.md");
  });

  test("returns empty for no genome", async () => {
    const { retrieveSectionsV2 } = await import("../genome/retriever.ts");
    const results = await retrieveSectionsV2(tmpDir, "anything", 50_000);
    expect(results).toEqual([]);
  });
});
