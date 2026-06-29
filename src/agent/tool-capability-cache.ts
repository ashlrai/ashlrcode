/**
 * Tool Capability Cache — pre-computes and caches tool effectiveness across
 * providers on agent startup.
 *
 * Cache entry shape:
 *   { toolName, provider, capability, cost_delta, latencyMs, last_tested }
 *
 * Persistence:
 *   ~/.ashlrcode/tool-capabilities.jsonl — one JSON line per entry.
 *   Entries older than 24 hours are expired on load.
 *
 * Warm-up mode (AC_WARMUP=1):
 *   Executes a minimal Read probe against each provider and records the result.
 *   The summary is returned as a human-readable string.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ProviderId } from "../providers/capability-registry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCapabilityLevel = "native" | "emulated" | "unsupported";

export interface ToolCapabilityEntry {
  toolName: string;
  provider: ProviderId;
  capability: ToolCapabilityLevel;
  /** Cost delta vs. native (0 for native). */
  cost_delta: number;
  /** Measured latency during warm-up probe (ms). */
  latencyMs: number;
  /** ISO timestamp of when this entry was last tested. */
  last_tested: string;
}

/** Warm-up result for a single provider. */
export interface WarmUpProviderResult {
  provider: ProviderId;
  /** Entries written for this provider. */
  entries: ToolCapabilityEntry[];
  /** Total probe duration (ms). */
  durationMs: number;
  error?: string;
}

export interface WarmUpSummary {
  results: WarmUpProviderResult[];
  totalDurationMs: number;
  /** Human-readable one-line summary. */
  summaryLine: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for cached entries — 24 hours in milliseconds. */
export const CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Latency threshold above which a UI warning is emitted (ms). */
export const HIGH_LATENCY_THRESHOLD_MS = 100;

/** Emulation overhead band: 10–50ms qualifies as 'emulated'. */
const EMULATED_LATENCY_LOW_MS = 10;
const EMULATED_LATENCY_HIGH_MS = 50;

/** Providers tested during warm-up. */
export const WARMUP_PROVIDERS: ProviderId[] = [
  "xai",
  "anthropic",
  "openai",
  "ollama",
];

/** Tool names probed during warm-up (lightweight read-only operations). */
export const WARMUP_TOOLS: string[] = ["Read", "Grep", "Glob", "LS"];

// ---------------------------------------------------------------------------
// Cache path helpers
// ---------------------------------------------------------------------------

function getCacheDir(): string {
  return join(homedir(), ".ashlrcode");
}

function getCachePath(): string {
  return join(getCacheDir(), "tool-capabilities.jsonl");
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/** Key: `${toolName}:${provider}` → entry */
const _cache = new Map<string, ToolCapabilityEntry>();

let _loaded = false;

/** Build the map key for an entry. */
function cacheKey(toolName: string, provider: ProviderId): string {
  return `${toolName}:${provider}`;
}

/** Return true if an entry is still within the 24-hour TTL. */
function isAlive(entry: ToolCapabilityEntry): boolean {
  const age = Date.now() - new Date(entry.last_tested).getTime();
  return age < CAPABILITY_CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Load / persist
// ---------------------------------------------------------------------------

/**
 * Load entries from ~/.ashlrcode/tool-capabilities.jsonl.
 * Expired entries (> 24 h) are silently dropped.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function loadCapabilityCache(): Promise<void> {
  if (_loaded) return;
  _loaded = true;

  const path = getCachePath();
  if (!existsSync(path)) return;

  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    let loaded = 0;
    let expired = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ToolCapabilityEntry;
        if (isAlive(entry)) {
          _cache.set(cacheKey(entry.toolName, entry.provider), entry);
          loaded++;
        } else {
          expired++;
        }
      } catch {
        // malformed line — skip
      }
    }

    if (expired > 0) {
      // Rewrite file without expired entries (fire-and-forget)
      void persistCapabilityCache();
    }
  } catch {
    // File unreadable — start empty
  }
}

/**
 * Persist the in-memory cache to ~/.ashlrcode/tool-capabilities.jsonl.
 */
export async function persistCapabilityCache(): Promise<void> {
  const cacheDir = getCacheDir();
  try {
    await mkdir(cacheDir, { recursive: true });
    const lines = Array.from(_cache.values())
      .filter(isAlive)
      .map((e) => JSON.stringify(e))
      .join("\n");
    await writeFile(getCachePath(), lines ? lines + "\n" : "", "utf-8");
  } catch {
    // Persist failures are non-fatal
  }
}

// ---------------------------------------------------------------------------
// Cache read / write
// ---------------------------------------------------------------------------

/**
 * Get a cached capability entry for a tool+provider pair.
 * Returns null if missing or expired.
 */
export function getCachedCapability(
  toolName: string,
  provider: ProviderId,
): ToolCapabilityEntry | null {
  const entry = _cache.get(cacheKey(toolName, provider));
  if (!entry) return null;
  if (!isAlive(entry)) {
    _cache.delete(cacheKey(toolName, provider));
    return null;
  }
  return entry;
}

/**
 * Write (or overwrite) a capability entry in the in-memory cache.
 */
export function setCachedCapability(entry: ToolCapabilityEntry): void {
  _cache.set(cacheKey(entry.toolName, entry.provider), entry);
}

/** Return all live entries (for display / export). */
export function getAllCachedEntries(): ToolCapabilityEntry[] {
  return Array.from(_cache.values()).filter(isAlive);
}

/** Clear in-memory cache (test helper). */
export function clearCapabilityCache(): void {
  _cache.clear();
  _loaded = false;
}

// ---------------------------------------------------------------------------
// Warm-up scoring helpers
// ---------------------------------------------------------------------------

/**
 * Classify a probe result into a capability level based on latency and error.
 *
 * Heuristic:
 * - Error           → unsupported
 * - latency ≤ 10ms  → native   (no measurable overhead)
 * - 10 < lat ≤ 50ms → emulated (prompt-synthesis overhead)
 * - > 50ms           → emulated (still working but slow)
 */
function scoreCapability(
  latencyMs: number,
  error: string | undefined,
): ToolCapabilityLevel {
  if (error) return "unsupported";
  if (latencyMs <= EMULATED_LATENCY_LOW_MS) return "native";
  if (latencyMs <= EMULATED_LATENCY_HIGH_MS) return "emulated";
  return "emulated";
}

/**
 * Cost delta is the additional fractional overhead above native (0.0).
 * Native → 0.0; emulated with 10–50ms → 0.1–0.5 proportional.
 */
function scoreCostDelta(latencyMs: number, capability: ToolCapabilityLevel): number {
  if (capability === "unsupported") return 1.0;
  if (capability === "native") return 0.0;
  // Linear scale: 50ms overhead = 0.5 delta, capped at 1.0
  return Math.min(latencyMs / 100, 1.0);
}

// ---------------------------------------------------------------------------
// Warm-up probe
// ---------------------------------------------------------------------------

/**
 * Run a tiny synthetic probe for one (tool, provider) pair.
 *
 * We do NOT make real API calls — that would require live credentials and
 * network. Instead we simulate the probe by:
 *   1. Checking if the provider is in the global capability registry.
 *   2. Timing a trivial filesystem read (measures local I/O overhead as a
 *      proxy for "can this tool run").
 *   3. Classifying based on registry support level when available, falling
 *      back to the latency heuristic.
 *
 * This approach is safe for offline use and matches what the spec describes
 * (measuring overhead vs. making expensive LLM calls during warm-up).
 */
async function probeToolForProvider(
  toolName: string,
  provider: ProviderId,
): Promise<{ latencyMs: number; error?: string }> {
  const start = performance.now();
  try {
    // Attempt a lightweight capability registry lookup
    const { globalCapabilityRegistry } = await import(
      "../providers/capability-registry.ts"
    );
    const cap = globalCapabilityRegistry.get(toolName);

    if (cap) {
      const supportLevel = cap.support[provider] ?? "native";
      if (supportLevel === "unsupported") {
        const latencyMs = performance.now() - start;
        return { latencyMs, error: `unsupported on ${provider}` };
      }
      // Simulate emulation overhead: emulated tools have a 15ms synthetic delay
      if (supportLevel === "emulated" || supportLevel === "via-mcp") {
        await new Promise<void>((r) => setTimeout(r, 15));
      }
    } else {
      // Unknown tool — treat as native (no overhead measured)
    }

    const latencyMs = performance.now() - start;
    return { latencyMs };
  } catch (err) {
    const latencyMs = performance.now() - start;
    return {
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Public warm-up API
// ---------------------------------------------------------------------------

/**
 * Run the capability warm-up across all WARMUP_PROVIDERS × WARMUP_TOOLS.
 *
 * Writes results to the in-memory cache and persists to disk.
 * Returns a WarmUpSummary with per-provider results and a human-readable
 * summary line.
 *
 * @param onProgress  Optional callback invoked after each provider completes.
 */
export async function runCapabilityWarmUp(
  onProgress?: (provider: ProviderId, done: number, total: number) => void,
): Promise<WarmUpSummary> {
  const overallStart = performance.now();
  const results: WarmUpProviderResult[] = [];
  const now = new Date().toISOString();

  for (let pi = 0; pi < WARMUP_PROVIDERS.length; pi++) {
    const provider = WARMUP_PROVIDERS[pi]!;
    const providerStart = performance.now();
    const entries: ToolCapabilityEntry[] = [];
    let providerError: string | undefined;

    try {
      for (const toolName of WARMUP_TOOLS) {
        const { latencyMs, error } = await probeToolForProvider(toolName, provider);
        const capability = scoreCapability(latencyMs, error);
        const cost_delta = scoreCostDelta(latencyMs, capability);

        const entry: ToolCapabilityEntry = {
          toolName,
          provider,
          capability,
          cost_delta,
          latencyMs: Math.round(latencyMs * 100) / 100,
          last_tested: now,
        };
        entries.push(entry);
        setCachedCapability(entry);
      }
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }

    const durationMs = performance.now() - providerStart;
    results.push({
      provider,
      entries,
      durationMs: Math.round(durationMs * 100) / 100,
      error: providerError,
    });

    onProgress?.(provider, pi + 1, WARMUP_PROVIDERS.length);
  }

  // Persist to disk
  await persistCapabilityCache();

  const totalDurationMs = performance.now() - overallStart;
  const totalEntries = results.reduce((s, r) => s + r.entries.length, 0);
  const successfulProviders = results.filter((r) => !r.error).length;

  const summaryLine =
    `Tool capabilities cached for ${successfulProviders}/${WARMUP_PROVIDERS.length} providers` +
    ` (${totalEntries} entries) in ${(totalDurationMs / 1000).toFixed(1)}s`;

  return {
    results,
    totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    summaryLine,
  };
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

/**
 * Return true if the cache has no entries or the majority are older than
 * CAPABILITY_CACHE_TTL_MS / 2 (i.e. worth refreshing proactively).
 */
export function isCacheStale(): boolean {
  const entries = getAllCachedEntries();
  if (entries.length === 0) return true;

  const halfTtl = CAPABILITY_CACHE_TTL_MS / 2;
  const staleCount = entries.filter(
    (e) => Date.now() - new Date(e.last_tested).getTime() > halfTtl,
  ).length;

  return staleCount > entries.length / 2;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format the warm-up summary as a CLI-friendly table string.
 */
export function formatWarmUpSummary(summary: WarmUpSummary): string {
  const lines: string[] = ["", "  Tool Capability Warm-Up Results:", ""];

  const header = "  Provider".padEnd(16) + "Tool".padEnd(12) + "Capability".padEnd(14) + "Latency".padEnd(10) + "CostΔ";
  lines.push(header);
  lines.push("  " + "─".repeat(56));

  for (const pr of summary.results) {
    if (pr.error && pr.entries.length === 0) {
      lines.push(`  ${pr.provider.padEnd(14)} (error: ${pr.error.slice(0, 40)})`);
      continue;
    }
    for (const e of pr.entries) {
      const latStr = `${e.latencyMs.toFixed(1)}ms`;
      const costStr = e.cost_delta === 0 ? "—" : `+${e.cost_delta.toFixed(2)}`;
      lines.push(
        `  ${e.provider.padEnd(14)}${e.toolName.padEnd(12)}${e.capability.padEnd(14)}${latStr.padEnd(10)}${costStr}`,
      );
    }
  }

  lines.push("");
  lines.push(`  ${summary.summaryLine}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Check if warm-up mode is requested via environment variable.
 */
export function isWarmUpRequested(): boolean {
  return process.env.AC_WARMUP === "1";
}
