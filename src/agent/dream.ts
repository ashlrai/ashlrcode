/**
 * Dream Task — background memory consolidation.
 *
 * When the user goes idle, summarize recent conversation into a
 * persistent "dream" file. On next session, load dreams to restore
 * project context without token bloat.
 */

import { existsSync } from "fs";
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";
import type { Message } from "../providers/types.ts";

interface Dream {
  id: string;
  timestamp: string;
  summary: string;
  sessionId: string;
  turnCount: number;
  toolsUsed: string[];
}

function getDreamsDir(): string {
  return join(getConfigDir(), "dreams");
}

/**
 * Generate a dream (conversation summary) from recent messages.
 */
export async function generateDream(
  messages: Message[],
  sessionId: string,
): Promise<Dream> {
  await mkdir(getDreamsDir(), { recursive: true });

  // Extract key info from messages
  const toolsUsed = new Set<string>();
  const summaryParts: string[] = [];

  for (const msg of messages.slice(-20)) {
    if (typeof msg.content === "string") {
      summaryParts.push(`${msg.role}: ${msg.content.slice(0, 150)}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolsUsed.add(block.name);
        }
        if (block.type === "text") {
          summaryParts.push(`${msg.role}: ${block.text.slice(0, 150)}`);
        }
        if (block.type === "tool_result") {
          summaryParts.push(`tool_result: ${String(block.content).slice(0, 100)}`);
        }
      }
    }
  }

  const summary = summaryParts.join("\n");
  const userMessages = messages.filter(m => m.role === "user");

  const dream: Dream = {
    id: `dream-${Date.now()}`,
    timestamp: new Date().toISOString(),
    summary,
    sessionId,
    turnCount: userMessages.length,
    toolsUsed: Array.from(toolsUsed),
  };

  // Persist
  const dreamPath = join(getDreamsDir(), `${dream.id}.json`);
  await writeFile(dreamPath, JSON.stringify(dream, null, 2), "utf-8");

  return dream;
}

/**
 * Load recent dreams for context injection.
 */
export async function loadRecentDreams(limit: number = 3): Promise<Dream[]> {
  const dir = getDreamsDir();
  if (!existsSync(dir)) return [];

  try {
    const files = await readdir(dir);
    const dreams: Dream[] = [];

    for (const file of files.filter(f => f.endsWith(".json")).sort().reverse().slice(0, limit * 2)) {
      try {
        const raw = await readFile(join(dir, file), "utf-8");
        dreams.push(JSON.parse(raw) as Dream);
      } catch {
        // Skip malformed dream files
      }
    }

    return dreams
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Format dreams as context for system prompt injection.
 */
export function formatDreamsForPrompt(dreams: Dream[]): string {
  if (dreams.length === 0) return "";

  const lines = dreams.map(d => {
    const date = new Date(d.timestamp).toLocaleDateString();
    const tools = d.toolsUsed.length > 0 ? ` (tools: ${d.toolsUsed.join(", ")})` : "";
    return `### ${date} — ${d.turnCount} turns${tools}\n${d.summary.slice(0, 500)}`;
  });

  return `## Recent Session Dreams\n\n${lines.join("\n\n---\n\n")}`;
}

/**
 * Idle detector — tracks time since last user input.
 * Calls onIdle when the user has been idle for `thresholdMs`.
 */
export class IdleDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callback: () => void;
  private thresholdMs: number;

  constructor(callback: () => void, thresholdMs: number = 60_000) {
    this.callback = callback;
    this.thresholdMs = thresholdMs;
  }

  /** Call this on every user action to reset the timer */
  ping(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.callback(), this.thresholdMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Clean up old dreams (keep last N).
 */
export async function pruneOldDreams(keepCount: number = 10): Promise<number> {
  const dir = getDreamsDir();
  if (!existsSync(dir)) return 0;

  const files = (await readdir(dir)).filter(f => f.endsWith(".json")).sort();
  const toDelete = files.slice(0, Math.max(0, files.length - keepCount));

  const { unlink } = await import("fs/promises");
  for (const file of toDelete) {
    await unlink(join(dir, file)).catch(() => {});
  }

  return toDelete.length;
}
