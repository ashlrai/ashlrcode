/**
 * Speculation — pre-fetch likely tool results while the model streams.
 *
 * When the model starts generating a tool_use block, we can sometimes
 * predict the full call and start executing early. This hides latency
 * for read-only tools like Read, Glob, Grep.
 *
 * Only read-only tools are eligible — we never speculatively execute
 * writes, edits, or shell commands.
 */

import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { dirname } from "path";

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  result: string;
  timestamp: number;
  lastAccessed: number;
  hitCount: number;
}

// ---------------------------------------------------------------------------
// SpeculationCache
// ---------------------------------------------------------------------------

export class SpeculationCache {
  private cache = new Map<string, CacheEntry>();
  private missCount = 0;
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 200, ttlMs = 30_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  // -------------------------------------------------------------------------
  // Core get / set
  // -------------------------------------------------------------------------

  /** Check if we have a valid cached result for a tool call. */
  get(toolName: string, input: Record<string, unknown>): string | null {
    const key = this.makeKey(toolName, input);
    const entry = this.cache.get(key);
    if (!entry) {
      this.missCount++;
      return null;
    }

    // TTL check
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    entry.hitCount++;
    entry.lastAccessed = Date.now();

    // LRU: delete and re-insert to move to end of Map iteration order
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  /** Store a tool result in the cache. */
  set(toolName: string, input: Record<string, unknown>, result: string): void {
    const key = this.makeKey(toolName, input);

    // If key already exists, delete first so re-insert moves it to end (LRU)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict the least recently used entry (first key in Map iteration order)
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) this.cache.delete(lruKey);
    }

    const now = Date.now();
    this.cache.set(key, {
      key,
      result,
      timestamp: now,
      lastAccessed: now,
      hitCount: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Speculative pre-fetching
  // -------------------------------------------------------------------------

  /**
   * Speculatively pre-read a file into the cache.
   * Skips files that don't exist or are too large (>1 MB).
   */
  async prefetchRead(filePath: string): Promise<void> {
    try {
      if (!existsSync(filePath)) return;
      const stats = await stat(filePath);
      if (stats.size > 1_000_000) return; // skip large files

      const content = await readFile(filePath, "utf-8");
      this.set("Read", { file_path: filePath }, content);
    } catch {
      // Silently ignore — speculation failures are harmless
    }
  }

  /**
   * After each tool execution, look at the recent history and
   * speculatively pre-fetch results that the model is likely to
   * request next.
   *
   * Heuristics:
   * 1. After Glob → pre-read the first few matched files.
   * 2. After Read of file X → pre-read sibling files with same ext.
   * 3. After Grep returning file matches → pre-read those files.
   */
  async speculateFromHistory(
    recentToolCalls: Array<{
      name: string;
      input: Record<string, unknown>;
      result?: string;
    }>
  ): Promise<void> {
    if (recentToolCalls.length === 0) return;

    const last = recentToolCalls[recentToolCalls.length - 1]!;

    // Heuristic 1: After Glob, pre-read the first few matched files
    if (last.name === "Glob" && typeof last.result === "string") {
      const paths = last.result
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 5); // limit to first 5

      await Promise.allSettled(paths.map((p) => this.prefetchRead(p)));
    }

    // Heuristic 2: After Grep returning file paths, pre-read them
    if (last.name === "Grep" && typeof last.result === "string") {
      const paths = last.result
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/"))
        .slice(0, 5);

      await Promise.allSettled(paths.map((p) => this.prefetchRead(p)));
    }

    // Heuristic 3: After Read, pre-read sibling files with same extension
    if (last.name === "Read" && typeof last.input.file_path === "string") {
      const filePath = last.input.file_path;
      const dir = dirname(filePath);
      try {
        const { readdir } = await import("fs/promises");
        const { extname, join } = await import("path");
        const ext = extname(filePath);
        const entries = await readdir(dir);
        const siblings = entries
          .filter((e) => extname(e) === ext && join(dir, e) !== filePath)
          .slice(0, 3) // limit to 3 siblings
          .map((e) => join(dir, e));

        await Promise.allSettled(siblings.map((p) => this.prefetchRead(p)));
      } catch {
        // Ignore — dir may not exist or may not be readable
      }
    }
  }

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------

  /** Invalidate cache entries that might be stale after a write/edit. */
  invalidateForFile(filePath: string): void {
    // Remove any Read cache for this exact file
    const readKey = this.makeKey("Read", { file_path: filePath });
    this.cache.delete(readKey);

    // Remove any Grep/Glob results that might reference this file
    // (conservative: remove all Grep/Glob entries since results may change)
    for (const [key] of this.cache) {
      if (key.startsWith("Grep:") || key.startsWith("Glob:")) {
        this.cache.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Return cache statistics for debugging. */
  getStats(): { size: number; hits: number; misses: number } {
    let hits = 0;
    for (const entry of this.cache.values()) hits += entry.hitCount;
    return { size: this.cache.size, hits, misses: this.missCount };
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
    this.missCount = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private makeKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }
}
