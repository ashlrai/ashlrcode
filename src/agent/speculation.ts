/**
 * Speculation — pre-fetch likely tool results while the model streams.
 *
 * When the model starts generating a tool_use block, we can sometimes
 * predict the full call and start executing early. This hides latency
 * for read-only tools like Read, Glob, Grep.
 *
 * Only read-only tools are eligible — we never speculatively execute
 * writes, edits, or shell commands.
 *
 * Multi-Provider Persistent Cache
 * --------------------------------
 * PersistentSpeculationCache extends SpeculationCache with a JSONL backing
 * store at ~/.ashlrcode/speculation-cache.jsonl.  Cache keys are a SHA-1
 * hash of (tool_name + JSON.stringify(input)) so the same logical call from
 * Agent A on Claude and Agent B on Grok will resolve to the same entry.
 *
 * Parameters:
 *   - max 500 entries (LRU eviction)
 *   - TTL 5 minutes (300 000 ms)
 *   - flush to disk after every write (append-only) + periodic compaction
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, extname, join } from "path";
import { homedir } from "os";

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
    }>,
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

// ---------------------------------------------------------------------------
// hashToolCall — stable cross-provider cache key
// ---------------------------------------------------------------------------

/**
 * Return a SHA-1 hex digest of `toolName + JSON.stringify(input)`.
 * Used as the primary key in the persistent cross-provider cache so that
 * identical logical calls from different agents/providers collide correctly.
 */
export function hashToolCall(toolName: string, input: Record<string, unknown>): string {
  return createHash("sha1").update(toolName + JSON.stringify(input)).digest("hex");
}

// ---------------------------------------------------------------------------
// PersistentCacheEntry — serialised to JSONL
// ---------------------------------------------------------------------------

interface PersistentCacheEntry {
  /** SHA-1 of toolName+input */
  hash: string;
  /** Original tool name (informational) */
  toolName: string;
  /** Tool result */
  result: string;
  /** Unix ms when the entry was written */
  timestamp: number;
  /** Unix ms when last hit */
  lastAccessed: number;
  /** Number of times this entry has been returned from cache */
  hitCount: number;
  /** Total ms of actual execution time saved so far */
  latencySavedMs: number;
}

// ---------------------------------------------------------------------------
// PersistentSpeculationCache
// ---------------------------------------------------------------------------

/**
 * Cross-provider, cross-session speculation cache backed by a JSONL file at
 * ~/.ashlrcode/speculation-cache.jsonl.
 *
 * Key properties:
 * - Keyed by hash(toolName + JSON.stringify(input)) so Agent A on Claude and
 *   Agent B on Grok share the same cache slot for identical tool calls.
 * - Max 500 entries; LRU eviction when the limit is reached.
 * - TTL: 5 minutes (300 000 ms) — configurable via constructor.
 * - Appends new/updated entries to the JSONL file; compacts the file
 *   whenever the write count reaches COMPACT_THRESHOLD.
 * - Tracks hit rate and avg latency saved for /stats output.
 */
export class PersistentSpeculationCache {
  private readonly cachePath: string;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  /** In-memory LRU map: hash → entry */
  private entries = new Map<string, PersistentCacheEntry>();

  /** Stats counters */
  private sessionHits = 0;
  private sessionMisses = 0;
  private sessionLatencySavedMs = 0;

  /** How many writes since last compaction */
  private writesSinceCompact = 0;
  private static readonly COMPACT_THRESHOLD = 100;

  /** Whether the initial load from disk has completed */
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(
    cachePath?: string,
    maxSize = 500,
    ttlMs = 300_000, // 5 minutes
  ) {
    this.cachePath = cachePath ?? join(homedir(), ".ashlrcode", "speculation-cache.jsonl");
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    // Start loading eagerly but don't block construction
    this.loadPromise = this._loadFromDisk();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check the persistent cache for a matching tool call result.
   * Returns the cached result string plus the original execution latency
   * (so callers can accumulate latency-saved stats), or null on miss.
   *
   * @param toolName   Name of the tool
   * @param input      Tool input parameters
   * @param actualLatencyMs  (optional) Latency of the real call that produced
   *                         this result, used to track avg savings on hits.
   */
  async get(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ result: string; latencySavedMs: number } | null> {
    await this._ensureLoaded();
    const h = hashToolCall(toolName, input);
    const entry = this.entries.get(h);

    if (!entry) {
      this.sessionMisses++;
      return null;
    }

    // TTL check
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(h);
      this.sessionMisses++;
      return null;
    }

    // LRU: move to end
    this.entries.delete(h);
    entry.hitCount++;
    entry.lastAccessed = Date.now();
    this.entries.set(h, entry);

    this.sessionHits++;
    this.sessionLatencySavedMs += entry.latencySavedMs;

    // Persist updated hit metadata (fire-and-forget)
    this._appendEntry(entry).catch(() => {});

    return { result: entry.result, latencySavedMs: entry.latencySavedMs };
  }

  /**
   * Store a tool result.
   *
   * @param toolName       Tool name
   * @param input          Tool input
   * @param result         The tool's output string
   * @param executionMs    How long the real execution took (used for latency stats)
   */
  async set(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
    executionMs = 0,
  ): Promise<void> {
    await this._ensureLoaded();
    const h = hashToolCall(toolName, input);

    if (this.entries.has(h)) {
      this.entries.delete(h);
    } else if (this.entries.size >= this.maxSize) {
      // Evict LRU (first entry in Map iteration order)
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) this.entries.delete(lruKey);
    }

    const now = Date.now();
    const entry: PersistentCacheEntry = {
      hash: h,
      toolName,
      result,
      timestamp: now,
      lastAccessed: now,
      hitCount: 0,
      latencySavedMs: executionMs,
    };
    this.entries.set(h, entry);

    await this._appendEntry(entry);
    this.writesSinceCompact++;
    if (this.writesSinceCompact >= PersistentSpeculationCache.COMPACT_THRESHOLD) {
      this._compact().catch(() => {});
    }
  }

  /**
   * Invalidate any entries whose toolName matches Read/Grep/Glob for the
   * given file path.  Mirrors the in-memory cache invalidation contract.
   */
  async invalidateForFile(filePath: string): Promise<void> {
    await this._ensureLoaded();
    const toDelete: string[] = [];
    for (const [h, entry] of this.entries) {
      if (entry.toolName === "Read") {
        // We don't store the original input, but we can re-hash to check
        const candidateHash = hashToolCall("Read", { file_path: filePath });
        if (h === candidateHash) toDelete.push(h);
      } else if (entry.toolName === "Grep" || entry.toolName === "Glob") {
        toDelete.push(h);
      }
    }
    for (const h of toDelete) this.entries.delete(h);
    if (toDelete.length > 0) this._compact().catch(() => {});
  }

  /** Return stats suitable for /stats output. */
  getStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRatePct: number;
    avgLatencySavedMs: number;
    cachePath: string;
  } {
    const total = this.sessionHits + this.sessionMisses;
    const hitRatePct = total > 0 ? Math.round((this.sessionHits / total) * 100) : 0;
    const avgLatencySavedMs =
      this.sessionHits > 0 ? Math.round(this.sessionLatencySavedMs / this.sessionHits) : 0;
    return {
      size: this.entries.size,
      hits: this.sessionHits,
      misses: this.sessionMisses,
      hitRatePct,
      avgLatencySavedMs,
      cachePath: this.cachePath,
    };
  }

  /** Format persistent cache stats for /stats display. */
  formatStats(): string {
    const s = this.getStats();
    const total = s.hits + s.misses;
    return [
      `Persistent Speculation Cache (cross-provider):`,
      `  Entries : ${s.size} / ${this.maxSize}`,
      `  Session : ${s.hits} hits / ${total} calls (${s.hitRatePct}% hit rate)`,
      `  Avg saved: ${s.avgLatencySavedMs}ms per hit`,
      `  File     : ${s.cachePath}`,
    ].join("\n");
  }

  /** Clear in-memory state and wipe the JSONL file. */
  async clear(): Promise<void> {
    this.entries.clear();
    this.sessionHits = 0;
    this.sessionMisses = 0;
    this.sessionLatencySavedMs = 0;
    this.writesSinceCompact = 0;
    try {
      await writeFile(this.cachePath, "", "utf-8");
    } catch {
      // ignore — dir may not exist yet
    }
  }

  // -------------------------------------------------------------------------
  // Disk I/O
  // -------------------------------------------------------------------------

  private async _ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) await this.loadPromise;
  }

  private async _loadFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.cachePath)) {
        this.loaded = true;
        return;
      }
      const raw = await readFile(this.cachePath, "utf-8");
      const now = Date.now();
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);

      // Parse all lines; last write for each hash wins
      const byHash = new Map<string, PersistentCacheEntry>();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PersistentCacheEntry;
          if (entry.hash && entry.toolName && typeof entry.result === "string") {
            byHash.set(entry.hash, entry);
          }
        } catch {
          // skip malformed lines
        }
      }

      // Filter expired, then sort by lastAccessed to restore LRU order
      const valid = Array.from(byHash.values())
        .filter((e) => now - e.timestamp <= this.ttlMs)
        .sort((a, b) => a.lastAccessed - b.lastAccessed);

      // Respect maxSize — keep the most-recently-accessed entries
      const kept = valid.slice(-this.maxSize);
      for (const e of kept) this.entries.set(e.hash, e);
    } catch {
      // Silently ignore load errors — cache is optional
    } finally {
      this.loaded = true;
    }
  }

  private async _appendEntry(entry: PersistentCacheEntry): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await appendFile(this.cachePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // ignore — persistence is best-effort
    }
  }

  /** Rewrite the JSONL file to contain only the current in-memory entries. */
  private async _compact(): Promise<void> {
    try {
      const lines = Array.from(this.entries.values())
        .map((e) => JSON.stringify(e))
        .join("\n");
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, lines ? lines + "\n" : "", "utf-8");
      this.writesSinceCompact = 0;
    } catch {
      // ignore
    }
  }
}
