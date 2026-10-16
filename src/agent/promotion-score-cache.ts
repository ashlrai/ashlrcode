/**
 * PromotionScoreCache — memoizes tier promotion scores to cut latency in the agent loop.
 *
 * Cache key: SHA-256 of (codebase context hash + recent edits fingerprint).
 * TTL: 30 seconds (configurable).
 * Invalidation: any file change seen via notifyFileChange() evicts the matching entry.
 *
 * Thread-safety note: all operations are synchronous and single-threaded in Bun's
 * event loop, so no mutex is needed.
 */

import { createHash } from "crypto";
import type { CodebaseContext, TierScores } from "./surgical-proposer.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedTierScores {
  /** The memoized tier scores. */
  scores: TierScores;
  /** Millisecond timestamp when the entry was stored. */
  storedAt: number;
  /** The cache key so callers can log hits. */
  key: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stable cache key from a goal string + CodebaseContext. */
export function buildCacheKey(goal: string, ctx: CodebaseContext): string {
  const parts: string[] = [
    goal,
    String(ctx.fileCount ?? ""),
    (ctx.recentEdits ?? []).slice().sort().join("|"),
    ctx.description?.slice(0, 200) ?? "",
    ctx.cwd ?? "",
  ];
  return createHash("sha256").update(parts.join("\x00")).digest("hex").slice(0, 16);
}

/** Build a lightweight fingerprint for the recent-edits list only (used for file-change eviction). */
export function buildEditsFingerprint(recentEdits: string[]): string {
  return recentEdits.slice().sort().join("|");
}

// ---------------------------------------------------------------------------
// PromotionScoreCache
// ---------------------------------------------------------------------------

/**
 * In-memory LRU-style cache for tier scores with TTL-based expiry.
 *
 * Typical usage:
 *
 *   const cache = new PromotionScoreCache();
 *   const key = buildCacheKey(goal, ctx);
 *   const hit = cache.get(key);
 *   if (hit) return hit.scores;
 *   const scores = await computeExpensive(goal, ctx);
 *   cache.set(key, scores, goal, ctx);
 *   return scores;
 */
export class PromotionScoreCache {
  /** TTL in milliseconds (default 30 s). */
  private readonly ttlMs: number;

  /** Maximum number of entries (oldest evicted when full). */
  private readonly maxEntries: number;

  /** Key → entry map (insertion-ordered for LRU). */
  private readonly store = new Map<string, CachedTierScores>();

  /**
   * Tracks which file paths appear in each cache entry's recentEdits fingerprint,
   * so we can evict on file change.
   * key → Set<filePath>
   */
  private readonly fileIndex = new Map<string, Set<string>>();

  // Instrumentation counters
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 256;
  }

  // ── Core operations ──────────────────────────────────────────────────────

  /**
   * Retrieve a cached entry. Returns undefined if absent or expired.
   * Expired entries are lazily evicted on read.
   */
  get(key: string): CachedTierScores | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    const age = Date.now() - entry.storedAt;
    if (age > this.ttlMs) {
      // Lazy TTL eviction
      this._evict(key);
      this._misses++;
      return undefined;
    }

    this._hits++;
    return entry;
  }

  /**
   * Store a tier scores result.
   *
   * @param key      Cache key from buildCacheKey().
   * @param scores   The tier scores to store.
   * @param ctx      Original context (used to index file paths for invalidation).
   */
  set(key: string, scores: TierScores, ctx: CodebaseContext = {}): void {
    // Evict LRU entry if at capacity (Map iteration order = insertion order)
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this._evict(oldest);
    }

    const entry: CachedTierScores = {
      scores: { ...scores },
      storedAt: Date.now(),
      key,
    };
    this.store.set(key, entry);

    // Build reverse file index
    const files = ctx.recentEdits ?? [];
    if (files.length > 0) {
      const fileSet = new Set<string>(files);
      this.fileIndex.set(key, fileSet);
    }
  }

  /**
   * Notify the cache that a file has changed.
   * All entries whose recentEdits list contains this file path are evicted.
   *
   * @param filePath Absolute or relative path of the changed file.
   */
  notifyFileChange(filePath: string): void {
    const keysToEvict: string[] = [];
    for (const [key, fileSet] of this.fileIndex) {
      if (fileSet.has(filePath)) {
        keysToEvict.push(key);
      }
    }
    for (const k of keysToEvict) {
      this._evict(k);
    }
  }

  /**
   * Evict all entries that are older than the TTL.
   * Can be called periodically by a scheduler to keep memory tidy.
   */
  sweepExpired(): number {
    const now = Date.now();
    const keysToEvict: string[] = [];
    for (const [key, entry] of this.store) {
      if (now - entry.storedAt > this.ttlMs) {
        keysToEvict.push(key);
      }
    }
    for (const k of keysToEvict) this._evict(k);
    return keysToEvict.length;
  }

  /** Remove all entries. */
  clear(): void {
    this._evictions += this.store.size;
    this.store.clear();
    this.fileIndex.clear();
  }

  /** Number of currently live (non-expired) entries. */
  get size(): number {
    return this.store.size;
  }

  /** Return current instrumentation counters. */
  stats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      size: this.store.size,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  /** Reset instrumentation counters (does not clear the cache). */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _evict(key: string): void {
    if (this.store.has(key)) {
      this.store.delete(key);
      this.fileIndex.delete(key);
      this._evictions++;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (shared across the agent loop session)
// ---------------------------------------------------------------------------

let _moduleCache: PromotionScoreCache | null = null;

/** Get or create the module-level singleton cache. */
export function getPromotionScoreCache(): PromotionScoreCache {
  if (!_moduleCache) {
    _moduleCache = new PromotionScoreCache({ ttlMs: 30_000, maxEntries: 256 });
  }
  return _moduleCache;
}

/** Replace the module-level cache (for testing or reconfiguration). */
export function setPromotionScoreCache(cache: PromotionScoreCache): void {
  _moduleCache = cache;
}

/** Reset the module-level cache (for testing). */
export function resetPromotionScoreCache(): void {
  _moduleCache = null;
}
