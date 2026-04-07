/**
 * Genome embeddings — semantic search via local Ollama embeddings.
 *
 * Generates embeddings for genome sections using a local Ollama instance,
 * caches them on disk to avoid recomputation, and provides cosine-similarity
 * based semantic search as a retrieval alternative to keyword TF-IDF.
 *
 * Gracefully degrades: if Ollama is not running, all functions return null/empty
 * and the caller falls back to keyword search.
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { estimateTokens, genomeDir, loadManifest, type SectionMeta } from "./manifest.ts";
import type { RetrievedSection } from "./retriever.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingCache {
  /** Relative section path within genome dir */
  sectionPath: string;
  /** Float32 embedding vector */
  embedding: number[];
  /** MD5 hash of the section content — used to detect stale embeddings */
  contentHash: string;
  /** ISO timestamp of last embedding generation */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const CACHE_FILE = "evolution/embeddings.json";

/** Timeout for Ollama connectivity check (ms) */
const AVAILABILITY_TIMEOUT_MS = 2000;
/** Timeout for individual embedding generation (ms) */
const EMBEDDING_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Ollama connectivity
// ---------------------------------------------------------------------------

/**
 * Check whether a local Ollama instance is reachable.
 * Uses a short timeout so it never blocks the critical path.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

/**
 * Generate an embedding vector for a text string via the Ollama embeddings API.
 * Returns null if Ollama is unreachable or the request fails.
 */
export async function generateEmbedding(
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<number[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = (await res.json()) as { embedding?: number[] };
    return data.embedding ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 for zero-length or mismatched vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dotProduct / denom;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * MD5 hash of a string — used to detect when section content has changed
 * and embeddings need regeneration.
 */
export function contentHash(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Cache persistence
// ---------------------------------------------------------------------------

function cachePath(cwd: string): string {
  return join(genomeDir(cwd), CACHE_FILE);
}

/**
 * Load the embedding cache from disk.
 * Returns an empty array if the file doesn't exist or is corrupt.
 */
export async function loadEmbeddingCache(cwd: string): Promise<EmbeddingCache[]> {
  const path = cachePath(cwd);
  if (!existsSync(path)) return [];

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as EmbeddingCache[];
  } catch {
    return [];
  }
}

/**
 * Save the embedding cache to disk atomically.
 */
export async function saveEmbeddingCache(cwd: string, cache: EmbeddingCache[]): Promise<void> {
  const path = cachePath(cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Update embeddings
// ---------------------------------------------------------------------------

/**
 * Update embeddings for all genome sections.
 *
 * Reads the manifest, checks each section against the cache (by content hash),
 * and generates new embeddings only for sections whose content has changed.
 *
 * Returns counts of updated and skipped (already cached) sections.
 */
export async function updateEmbeddings(
  cwd: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<{ updated: number; skipped: number; failed: number }> {
  const manifest = await loadManifest(cwd);
  if (!manifest || manifest.sections.length === 0) {
    return { updated: 0, skipped: 0, failed: 0 };
  }

  const cache = await loadEmbeddingCache(cwd);
  const cacheMap = new Map<string, EmbeddingCache>();
  for (const entry of cache) {
    cacheMap.set(entry.sectionPath, entry);
  }

  const dir = genomeDir(cwd);
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const section of manifest.sections) {
    const fullPath = join(dir, section.path);
    if (!existsSync(fullPath)) {
      failed++;
      continue;
    }

    const content = await readFile(fullPath, "utf-8");
    const hash = contentHash(content);

    // Check if cached embedding is still fresh
    const cached = cacheMap.get(section.path);
    if (cached && cached.contentHash === hash && cached.embedding.length > 0) {
      skipped++;
      continue;
    }

    // Generate new embedding
    const embedding = await generateEmbedding(content, model);
    if (!embedding) {
      failed++;
      continue;
    }

    cacheMap.set(section.path, {
      sectionPath: section.path,
      embedding,
      contentHash: hash,
      updatedAt: new Date().toISOString(),
    });
    updated++;
  }

  // Remove cache entries for sections that no longer exist
  const sectionPaths = new Set(manifest.sections.map((s) => s.path));
  for (const key of cacheMap.keys()) {
    if (!sectionPaths.has(key)) {
      cacheMap.delete(key);
    }
  }

  await saveEmbeddingCache(cwd, Array.from(cacheMap.values()));

  return { updated, skipped, failed };
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

/**
 * Semantic search: find the most relevant genome sections for a query
 * using embedding cosine similarity.
 *
 * Returns sections ordered by similarity score (descending), packed within
 * the given token budget. Returns an empty array if embeddings are unavailable.
 */
export async function semanticSearch(
  cwd: string,
  query: string,
  maxTokens: number,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<RetrievedSection[]> {
  // Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query, model);
  if (!queryEmbedding) return [];

  // Load cached embeddings
  const cache = await loadEmbeddingCache(cwd);
  if (cache.length === 0) return [];

  // Score all cached sections by cosine similarity
  const scored = cache
    .map((entry) => ({
      path: entry.sectionPath,
      similarity: cosineSimilarity(queryEmbedding, entry.embedding),
    }))
    .filter((s) => s.similarity > 0.3) // Minimum relevance threshold
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) return [];

  // Pack sections within token budget
  const dir = genomeDir(cwd);
  const manifest = await loadManifest(cwd);
  const sectionMap = new Map<string, SectionMeta>();
  if (manifest) {
    for (const s of manifest.sections) {
      sectionMap.set(s.path, s);
    }
  }

  const results: RetrievedSection[] = [];
  let usedTokens = 0;

  for (const { path, similarity } of scored) {
    if (usedTokens >= maxTokens) break;

    const fullPath = join(dir, path);
    if (!existsSync(fullPath)) continue;

    const content = await readFile(fullPath, "utf-8");
    const tokens = estimateTokens(content);
    const meta = sectionMap.get(path);
    const title = meta?.title ?? path;

    if (usedTokens + tokens > maxTokens) {
      // Try truncating to fit
      const remaining = maxTokens - usedTokens;
      if (remaining > 200) {
        const truncated = content.slice(0, remaining * 4) + "\n\n[... section truncated ...]";
        results.push({
          path,
          title,
          content: truncated,
          tokens: remaining,
          score: similarity,
        });
        usedTokens += remaining;
      }
      break;
    }

    results.push({
      path,
      title,
      content,
      tokens,
      score: similarity,
    });
    usedTokens += tokens;
  }

  return results;
}
