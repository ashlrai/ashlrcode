/**
 * Local event telemetry — ring-buffer event log for debugging.
 * Events stored to ~/.ashlrcode/telemetry/events.jsonl
 * No external transmission — purely local diagnostics.
 */

import { appendFile, mkdir, readFile, stat, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export type EventType =
  | "session_start" | "session_end"
  | "turn_start" | "turn_end"
  | "tool_start" | "tool_end" | "tool_error"
  | "agent_spawn" | "agent_complete"
  | "compact" | "dream"
  | "error" | "retry" | "circuit_breaker"
  | "permission_granted" | "permission_denied"
  | "kairos_tick" | "kairos_start" | "kairos_stop"
  | "tool_dispatch";

/**
 * Structured payload for a tool_dispatch event.
 * Emitted when a tool is routed — including auto-fallback to a native provider.
 */
export interface ToolDispatchEvent {
  tool: string;
  provider: string;
  fallback_provider: string | null;
  cost_delta: number;
  reason: string;
}

interface TelemetryEvent {
  type: EventType;
  timestamp: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_FILES = 5; // Keep 5 rotated files

function getTelemetryDir(): string {
  return join(getConfigDir(), "telemetry");
}

function getEventLogPath(): string {
  return join(getTelemetryDir(), "events.jsonl");
}

let _sessionId: string | null = null;

export function initTelemetry(sessionId: string): void {
  _sessionId = sessionId;
}

export async function logEvent(type: EventType, data?: Record<string, unknown>): Promise<void> {
  const event: TelemetryEvent = {
    type,
    timestamp: new Date().toISOString(),
    sessionId: _sessionId ?? undefined,
    data,
  };

  try {
    const dir = getTelemetryDir();
    await mkdir(dir, { recursive: true });
    const path = getEventLogPath();
    await appendFile(path, JSON.stringify(event) + "\n", "utf-8");

    // Rotate if too large
    if (existsSync(path)) {
      const s = await stat(path);
      if (s.size > MAX_FILE_SIZE) {
        await rotateLog(path);
      }
    }
  } catch {
    // Never let telemetry crash the app
  }
}

async function rotateLog(path: string): Promise<void> {
  const dir = getTelemetryDir();
  // Delete the oldest file before shifting to prevent unbounded growth
  const oldestPath = join(dir, `events.${MAX_FILES}.jsonl`);
  if (existsSync(oldestPath)) await unlink(oldestPath).catch(() => {});
  // Shift existing rotated files
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const from = join(dir, `events.${i}.jsonl`);
    const to = join(dir, `events.${i + 1}.jsonl`);
    if (existsSync(from)) {
      await rename(from, to).catch(() => {});
    }
  }
  // Move current to .1
  await rename(path, join(dir, "events.1.jsonl")).catch(() => {});
}

/**
 * Read recent events for debugging.
 */
export async function readRecentEvents(count: number = 100): Promise<TelemetryEvent[]> {
  const path = getEventLogPath();
  if (!existsSync(path)) return [];

  const content = await readFile(path, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const events: TelemetryEvent[] = [];

  for (const line of lines.slice(-count)) {
    try { events.push(JSON.parse(line)); } catch {}
  }

  return events;
}

/**
 * Format events for display.
 */
export function formatEvents(events: TelemetryEvent[]): string {
  return events.map(e => {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const data = e.data ? ` ${JSON.stringify(e.data).slice(0, 80)}` : "";
    return `  ${time} ${e.type}${data}`;
  }).join("\n");
}

/**
 * Log a structured tool dispatch event.
 * Call this each time a tool is dispatched — including auto-promoted fallbacks.
 *
 * @param payload  Structured dispatch info: tool, providers, cost_delta, reason.
 */
export async function logToolDispatch(payload: ToolDispatchEvent): Promise<void> {
  return logEvent("tool_dispatch", payload as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// In-process dispatch stats (ring buffer, survives for the session lifetime)
// ---------------------------------------------------------------------------

const MAX_DISPATCH_STATS = 1000;

/** Accumulated per-tool-per-provider dispatch counts and cost deltas. */
const _dispatchStats = new Map<string, {
  total: number;
  fallbacks: number;
  totalCostDelta: number;
}>();

/** Ordered ring of the last N raw dispatch events for recency queries. */
const _dispatchRing: ToolDispatchEvent[] = [];

/**
 * Record a dispatch event into the in-process ring buffer.
 * This is O(1) and never throws — safe to call on every tool invocation.
 */
export function recordDispatch(payload: ToolDispatchEvent): void {
  const key = `${payload.tool}@${payload.provider}`;
  const entry = _dispatchStats.get(key) ?? { total: 0, fallbacks: 0, totalCostDelta: 0 };
  entry.total += 1;
  if (payload.fallback_provider !== null) entry.fallbacks += 1;
  entry.totalCostDelta += payload.cost_delta;
  _dispatchStats.set(key, entry);

  // Ring: evict oldest when full
  if (_dispatchRing.length >= MAX_DISPATCH_STATS) _dispatchRing.shift();
  _dispatchRing.push(payload);
}

export interface DispatchStatEntry {
  tool: string;
  provider: string;
  total: number;
  fallbacks: number;
  fallbackRate: number;
  avgCostDelta: number;
}

/** Return accumulated dispatch stats sorted by fallback count descending. */
export function getDispatchStats(): DispatchStatEntry[] {
  const results: DispatchStatEntry[] = [];
  for (const [key, v] of _dispatchStats) {
    const [tool, provider] = key.split("@") as [string, string];
    results.push({
      tool,
      provider,
      total: v.total,
      fallbacks: v.fallbacks,
      fallbackRate: v.total > 0 ? v.fallbacks / v.total : 0,
      avgCostDelta: v.total > 0 ? v.totalCostDelta / v.total : 0,
    });
  }
  return results.sort((a, b) => b.fallbacks - a.fallbacks);
}

/** Return the raw dispatch ring (most recent last). */
export function getDispatchRing(): readonly ToolDispatchEvent[] {
  return _dispatchRing;
}

/** Reset all in-process dispatch stats (useful for tests). */
export function resetDispatchStats(): void {
  _dispatchStats.clear();
  _dispatchRing.length = 0;
}
