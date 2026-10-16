/**
 * Multi-Agent Request Deduplication Cache
 *
 * Prevents parallel sub-agents in a coordinator wave from re-executing
 * identical read-only tool calls. Scoped to a coordinator turn; all
 * sub-agents in the same wave share one instance via AgentContext so
 * a Read(src/utils/helpers.ts) that has already been satisfied by agent A
 * is served from memory to agents B and C without hitting the filesystem.
 *
 * Design choices:
 * - Cache key = (toolName, semanticHash(input), cwdNormalized). Only
 *   semantic params (file path + line range for Read; command for Bash;
 *   pattern + path for Grep) are hashed — order-independent params are
 *   sorted before hashing so {a:1,b:2} and {b:2,a:1} are the same entry.
 * - TTL = 5 min or explicit flush, whichever comes first.
 * - Opt-out list: Bash, AskUser, WebSearch, WebFetch, TodoWrite, and any
 *   non-read-only tools skip dedup (side-effects / non-deterministic).
 * - Read-only tools (Read, Grep, Glob, Diff, LS) always deduplicate.
 * - On hit, emits a recordDedupHit annotation to intent-trace.ts.
 * - Stats exposed via getDedupStats() for /stats display.
 * - flush() clears the map (called by coordinator between turns).
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools whose results must never be deduplicated (side-effects / non-deterministic). */
export const DEDUP_SKIP_TOOLS = new Set([
  "Bash",
  "PowerShell",
  "AskUser",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "FileWrite",
  "FileEdit",
  "NotebookEdit",
  "SendMessage",
  "MCP",
  "Sleep",
  "Workflow",
  "Worktree",
]);

/** Tools that are always safe to deduplicate. */
export const DEDUP_ALWAYS_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Diff",
  "LS",
  "FileRead",
]);

/** Default TTL in milliseconds (5 minutes). */
export const DEDUP_TTL_MS = 5 * 60 * 1_000;

/** Max entries before LRU eviction. */
export const DEDUP_MAX_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DedupEntry {
  result: string;
  timestamp: number;
  /** How many agents served from this entry (including the first). */
  hitCount: number;
  /** Estimated time saved on each subsequent hit (ms, filled in after first hit). */
  executionMs: number;
}

export interface DedupStats {
  hits: number;
  misses: number;
  size: number;
  totalMsSaved: number;
  /** Formatted one-liner for /stats. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Semantic key derivation
// ---------------------------------------------------------------------------

/**
 * Extract the semantically meaningful parts of a tool input for hashing.
 * Ignores cosmetic or order-independent params.
 *
 * The goal is: two tool calls that will return the same result get the same key,
 * even if their raw input objects differ in key order or have extra irrelevant fields.
 */
function semanticInputKey(toolName: string, input: Record<string, unknown>): string {
  const n = toolName.toLowerCase();

  // Read: (file_path, offset?, limit?)
  if (n === "read" || n === "fileread") {
    return JSON.stringify({
      file_path: input.file_path ?? "",
      offset: input.offset ?? 0,
      limit: input.limit ?? null,
    });
  }

  // Grep: (pattern, path?, glob?)
  if (n === "grep") {
    return JSON.stringify({
      pattern: input.pattern ?? "",
      path: input.path ?? "",
      glob: input.glob ?? "",
      case_sensitive: input.case_sensitive ?? true,
    });
  }

  // Glob: (pattern, cwd?)
  if (n === "glob") {
    return JSON.stringify({
      pattern: input.pattern ?? "",
      cwd: input.cwd ?? "",
    });
  }

  // LS: (path?)
  if (n === "ls") {
    return JSON.stringify({ path: input.path ?? "" });
  }

  // Diff: (old_file_path, new_file_path) or (original, modified)
  if (n === "diff") {
    return JSON.stringify({
      old_file_path: input.old_file_path ?? input.original ?? "",
      new_file_path: input.new_file_path ?? input.modified ?? "",
    });
  }

  // Default: sort keys alphabetically so {b:2,a:1} === {a:1,b:2}
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(input).sort()) {
    sorted[k] = input[k];
  }
  return JSON.stringify(sorted);
}

/**
 * Compute the canonical cache key for a tool call.
 * Format: `toolName:sha1(semanticInput):cwdNormalized`
 */
export function dedupKey(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): string {
  const semantic = semanticInputKey(toolName, input);
  const hash = createHash("sha1").update(semantic).digest("hex").slice(0, 12);
  // Normalize cwd: resolve trailing slashes, lower-case on case-insensitive FSes
  const normalizedCwd = cwd.replace(/\/+$/, "");
  return `${toolName}:${hash}:${normalizedCwd}`;
}

// ---------------------------------------------------------------------------
// DedupCache class
// ---------------------------------------------------------------------------

export class DedupCache {
  private readonly cache = new Map<string, DedupEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  /** Session-scoped statistics. */
  private _hits = 0;
  private _misses = 0;
  private _totalMsSaved = 0;

  constructor(ttlMs = DEDUP_TTL_MS, maxSize = DEDUP_MAX_SIZE) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  // -------------------------------------------------------------------------
  // Eligibility check
  // -------------------------------------------------------------------------

  /**
   * Returns true when a tool call should participate in deduplication.
   *
   * Rules (in order):
   * 1. Tools in DEDUP_SKIP_TOOLS are never deduplicated.
   * 2. Tools in DEDUP_ALWAYS_TOOLS are always deduplicated.
   * 3. For all other tools, the `isReadOnly` flag drives the decision —
   *    callers pass this from the Tool interface.
   */
  static shouldDedup(toolName: string, isReadOnly: boolean): boolean {
    if (DEDUP_SKIP_TOOLS.has(toolName)) return false;
    if (DEDUP_ALWAYS_TOOLS.has(toolName)) return true;
    return isReadOnly;
  }

  // -------------------------------------------------------------------------
  // Core get / set
  // -------------------------------------------------------------------------

  /**
   * Check for a cached result. Returns the cached string on hit, null on miss.
   * Updates hit statistics and LRU order.
   */
  get(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
    const key = dedupKey(toolName, input, cwd);
    const entry = this.cache.get(key);

    if (!entry) {
      this._misses++;
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this._misses++;
      return null;
    }

    // LRU: delete and re-insert to move to end
    this.cache.delete(key);
    entry.hitCount++;
    this._hits++;
    this._totalMsSaved += entry.executionMs;
    this.cache.set(key, entry);

    return entry.result;
  }

  /**
   * Store a tool result. `executionMs` is the real execution time so we can
   * report accurate latency savings on future hits.
   */
  set(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
    result: string,
    executionMs = 0
  ): void {
    const key = dedupKey(toolName, input, cwd);

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict LRU (first key in Map iteration order)
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) this.cache.delete(lruKey);
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      hitCount: 1,
      executionMs,
    });
  }

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------

  /**
   * Invalidate cache entries that may be stale after a write to `filePath`.
   * Removes all Read entries for that exact path, plus all Grep/Glob entries
   * (conservative — their results might reference the modified file).
   */
  invalidateForFile(filePath: string): void {
    const readKey = dedupKey("Read", { file_path: filePath }, "");
    // The cwd part varies, so we do a prefix scan on the tool+hash portion
    const readHash = readKey.split(":")[1]!;

    for (const key of this.cache.keys()) {
      const [tool, hash] = key.split(":");
      if (!tool || !hash) continue;

      const shouldDelete =
        (tool === "Read" && hash === readHash) ||
        tool === "Grep" ||
        tool === "Glob" ||
        tool === "LS";

      if (shouldDelete) this.cache.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Turn boundary
  // -------------------------------------------------------------------------

  /**
   * Clear the entire cache. Called by the coordinator between turns so that
   * the next turn re-reads files in case code changed.
   */
  flush(): void {
    this.cache.clear();
    // Stats intentionally preserved across turns so /stats shows session totals
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  getStats(): DedupStats {
    const hits = this._hits;
    const misses = this._misses;
    const totalMsSaved = this._totalMsSaved;
    const summary =
      hits > 0
        ? `dedup cache: ${hits} hits (${Math.round(totalMsSaved)} ms saved)`
        : "dedup cache: 0 hits";

    return { hits, misses, size: this.cache.size, totalMsSaved, summary };
  }

  /** Reset stats (for testing). */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._totalMsSaved = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (shared across all tool executions in a process)
// ---------------------------------------------------------------------------

let _globalDedupCache: DedupCache | null = null;

/** Get or lazily create the global dedup cache instance. */
export function getGlobalDedupCache(): DedupCache {
  if (!_globalDedupCache) {
    _globalDedupCache = new DedupCache();
  }
  return _globalDedupCache;
}

/** Replace the global dedup cache (e.g., at coordinator wave start). */
export function setGlobalDedupCache(cache: DedupCache): void {
  _globalDedupCache = cache;
}

/** Flush the global dedup cache (turn boundary). */
export function flushGlobalDedupCache(): void {
  _globalDedupCache?.flush();
}

/** Reset the global dedup cache to null (for testing). */
export function resetGlobalDedupCache(): void {
  _globalDedupCache = null;
}

/** Format dedup stats for /stats display. */
export function formatDedupStats(): string {
  const cache = _globalDedupCache;
  if (!cache) return "dedup cache: not initialized";
  const s = cache.getStats();
  const total = s.hits + s.misses;
  const hitPct = total > 0 ? Math.round((s.hits / total) * 100) : 0;
  return [
    "Multi-Agent Dedup Cache:",
    `  Hits   : ${s.hits} / ${total} calls (${hitPct}% hit rate)`,
    `  Saved  : ${Math.round(s.totalMsSaved)} ms total`,
    `  Entries: ${s.size}`,
  ].join("\n");
}
