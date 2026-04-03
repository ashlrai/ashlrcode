/**
 * Local event telemetry — ring-buffer event log for debugging.
 * Events stored to ~/.ashlrcode/telemetry/events.jsonl
 * No external transmission — purely local diagnostics.
 */

import { appendFile, mkdir, readFile, stat, rename } from "fs/promises";
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
  | "kairos_tick" | "kairos_start" | "kairos_stop";

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
