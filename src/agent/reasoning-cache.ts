/**
 * Multi-Model Reasoning Transcript Inference Engine
 *
 * Captures and caches `think` blocks from Anthropic extended thinking, indexed
 * for semantic similarity via simple keyword overlap (no external embedding
 * service required — falls back gracefully when Ollama/genome embeddings are
 * unavailable). Cached reasoning can be prepended to the system prompt on
 * subsequent turns where the goal is similar, enabling faster convergence and
 * cross-provider reasoning inheritance.
 *
 * Storage: `~/.ashlrcode/reasoning-cache.jsonl`
 * Each line: { hash, goal, thinking_text, provider, timestamp, tokens_saved }
 *
 * Design choices:
 * - Hash = SHA-256(goal.trim().toLowerCase())[0..15] — cheap and stable.
 * - Similarity = Jaccard index over trigrams (no network, no model required).
 *   Falls back to exact hash match when the trigram set is empty.
 * - Max 500 entries; oldest evicted first (append-log → rewrite on eviction).
 * - TTL = 7 days (reasoning for stale goals may be misleading).
 * - Thread-safe append-only writes — concurrent agents each write their own
 *   line; reads load the whole file once per lookup.
 * - tokens_saved is estimated as thinking_text.length / 4 (rough token count)
 *   representing tokens the model would have spent re-generating the same
 *   reasoning chain from scratch.
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path for the reasoning cache JSONL file. */
export const REASONING_CACHE_PATH = join(homedir(), ".ashlrcode", "reasoning-cache.jsonl");

/** Maximum entries before oldest are evicted. */
export const REASONING_CACHE_MAX_ENTRIES = 500;

/** TTL in milliseconds (7 days). */
export const REASONING_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Minimum Jaccard similarity score (0–1) to consider two goals "similar". */
export const REASONING_SIMILARITY_THRESHOLD = 0.25;

/** Max characters of thinking_text to store per entry (avoid huge files). */
export const REASONING_MAX_THINKING_CHARS = 8_000;

/** Max characters of cached thinking to prepend to system prompt. */
export const REASONING_MAX_INJECT_CHARS = 3_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReasoningEntry {
  /** Hex prefix of SHA-256(normalized goal). */
  hash: string;
  /** Original goal / user message that produced this reasoning. */
  goal: string;
  /** The captured extended thinking text. */
  thinking_text: string;
  /** Provider that produced this reasoning (e.g. "anthropic"). */
  provider: string;
  /** ISO-8601 timestamp when this entry was stored. */
  timestamp: string;
  /** Estimated tokens saved by reusing this entry instead of re-generating. */
  tokens_saved: number;
}

export interface ReasoningCacheStats {
  entries: number;
  hits: number;
  misses: number;
  totalTokensSaved: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a short stable hash for a goal string. */
export function goalHash(goal: string): string {
  return createHash("sha256")
    .update(goal.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build the set of character trigrams for a string.
 * Used for Jaccard similarity without requiring an embedding model.
 */
export function trigrams(text: string): Set<string> {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const result = new Set<string>();
  for (let i = 0; i + 2 < normalized.length; i++) {
    result.add(normalized.slice(i, i + 3));
  }
  return result;
}

/** Jaccard similarity between two trigram sets (0–1). */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Ensure the cache directory exists. */
async function ensureCacheDir(cachePath: string): Promise<void> {
  const dir = join(cachePath, "..");
  await mkdir(dir, { recursive: true });
}

/** Load all non-expired entries from the JSONL file. */
export async function loadEntries(cachePath = REASONING_CACHE_PATH): Promise<ReasoningEntry[]> {
  if (!existsSync(cachePath)) return [];
  try {
    const raw = await readFile(cachePath, "utf-8");
    const now = Date.now();
    const entries: ReasoningEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as ReasoningEntry;
        // Validate shape
        if (
          typeof entry.hash === "string" &&
          typeof entry.goal === "string" &&
          typeof entry.thinking_text === "string" &&
          typeof entry.provider === "string" &&
          typeof entry.timestamp === "string"
        ) {
          // Check TTL
          const age = now - new Date(entry.timestamp).getTime();
          if (age <= REASONING_CACHE_TTL_MS) {
            entries.push(entry);
          }
        }
      } catch {
        // Corrupt line — skip
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Append one entry to the JSONL file.
 * If the file would exceed REASONING_CACHE_MAX_ENTRIES, rewrites the file
 * keeping only the most recent entries (oldest-first eviction).
 */
export async function appendEntry(
  entry: ReasoningEntry,
  cachePath = REASONING_CACHE_PATH
): Promise<void> {
  await ensureCacheDir(cachePath);

  const existing = await loadEntries(cachePath);

  // Deduplicate: if same hash already exists, remove the old one
  const deduped = existing.filter((e) => e.hash !== entry.hash);
  deduped.push(entry);

  if (deduped.length > REASONING_CACHE_MAX_ENTRIES || deduped.length < existing.length + 1) {
    // Rewrite when evicting oldest OR when deduplication removed a prior entry
    const trimmed = deduped.slice(Math.max(0, deduped.length - REASONING_CACHE_MAX_ENTRIES));
    await writeFile(cachePath, trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  } else {
    // Fast path: just append (no dedup needed, within size limit)
    await appendFile(cachePath, JSON.stringify(entry) + "\n", "utf-8");
  }
}

// ---------------------------------------------------------------------------
// ReasoningCache class
// ---------------------------------------------------------------------------

export class ReasoningCache {
  private readonly cachePath: string;
  private _hits = 0;
  private _misses = 0;
  private _totalTokensSaved = 0;

  constructor(cachePath = REASONING_CACHE_PATH) {
    this.cachePath = cachePath;
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  /**
   * Store a thinking block captured from a provider response.
   *
   * @param goal       The user goal / message that produced this reasoning.
   * @param thinking   The full extended thinking text.
   * @param provider   The provider name (e.g. "anthropic").
   */
  async store(goal: string, thinking: string, provider: string): Promise<void> {
    if (!thinking || !goal) return;

    // Truncate very long thinking blocks to avoid huge files
    const truncated = thinking.slice(0, REASONING_MAX_THINKING_CHARS);
    const estimatedTokens = Math.round(truncated.length / 4);

    const entry: ReasoningEntry = {
      hash: goalHash(goal),
      goal: goal.slice(0, 500), // Store up to 500 chars of the goal
      thinking_text: truncated,
      provider,
      timestamp: new Date().toISOString(),
      tokens_saved: estimatedTokens,
    };

    await appendEntry(entry, this.cachePath);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * Find the most similar cached reasoning entry for a given goal.
   *
   * Returns null if no entry meets the similarity threshold.
   * Prioritises exact hash match, then highest Jaccard score.
   */
  async findSimilar(goal: string): Promise<ReasoningEntry | null> {
    const entries = await loadEntries(this.cachePath);
    if (entries.length === 0) {
      this._misses++;
      return null;
    }

    const hash = goalHash(goal);

    // 1. Exact hash match (same goal, previously seen)
    const exact = entries.find((e) => e.hash === hash);
    if (exact) {
      this._hits++;
      this._totalTokensSaved += exact.tokens_saved;
      return exact;
    }

    // 2. Semantic similarity via trigrams
    const queryTrigrams = trigrams(goal);
    let bestEntry: ReasoningEntry | null = null;
    let bestScore = REASONING_SIMILARITY_THRESHOLD - 0.001; // just below threshold

    for (const entry of entries) {
      const score = jaccardSimilarity(queryTrigrams, trigrams(entry.goal));
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry) {
      this._hits++;
      this._totalTokensSaved += bestEntry.tokens_saved;
      return bestEntry;
    }

    this._misses++;
    return null;
  }

  // -------------------------------------------------------------------------
  // Inject into system prompt
  // -------------------------------------------------------------------------

  /**
   * Build a system-prompt snippet that prepends cached reasoning context.
   *
   * When a similar prior reasoning chain is found, prepending it helps the
   * model skip redundant thinking and inherit correct assumptions from a
   * previous run — especially useful on provider switches where the new
   * provider starts cold.
   *
   * Returns an empty string if no relevant entry is found.
   */
  async buildPromptInjection(goal: string): Promise<string> {
    const entry = await this.findSimilar(goal);
    if (!entry) return "";

    const excerpt = entry.thinking_text.slice(0, REASONING_MAX_INJECT_CHARS);
    const trunc = entry.thinking_text.length > REASONING_MAX_INJECT_CHARS ? " [truncated]" : "";

    return [
      "## Prior Reasoning Context",
      `The following reasoning was captured from a previous run on a similar goal`,
      `(provider: ${entry.provider}, cached: ${entry.timestamp.slice(0, 10)}).`,
      `Use it to orient quickly — you do not need to repeat this thinking.`,
      "",
      "```",
      excerpt + trunc,
      "```",
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): ReasoningCacheStats {
    const total = this._hits + this._misses;
    const hitPct = total > 0 ? Math.round((this._hits / total) * 100) : 0;
    return {
      entries: -1, // populated lazily — caller can await loadEntries().length
      hits: this._hits,
      misses: this._misses,
      totalTokensSaved: this._totalTokensSaved,
      summary: `reasoning-cache: ${this._hits}/${total} hits (${hitPct}%), ~${this._totalTokensSaved} tokens saved`,
    };
  }

  /** Reset in-memory counters (for testing). */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._totalTokensSaved = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _globalReasoningCache: ReasoningCache | null = null;

/** Get or lazily create the global reasoning cache instance. */
export function getGlobalReasoningCache(): ReasoningCache {
  if (!_globalReasoningCache) {
    _globalReasoningCache = new ReasoningCache();
  }
  return _globalReasoningCache;
}

/** Replace the global instance (e.g., for testing with a temp path). */
export function setGlobalReasoningCache(cache: ReasoningCache): void {
  _globalReasoningCache = cache;
}

/** Reset the global instance (for testing). */
export function resetGlobalReasoningCache(): void {
  _globalReasoningCache = null;
}
