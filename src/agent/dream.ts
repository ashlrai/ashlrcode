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
import type { ProviderRouter } from "../providers/router.ts";

interface Dream {
  id: string;
  timestamp: string;
  summary: string;
  sessionId: string;
  turnCount: number;
  toolsUsed: string[];
  /** Whether this dream was consolidated by LLM (vs raw extraction) */
  llmConsolidated?: boolean;
}

function getDreamsDir(): string {
  return join(getConfigDir(), "dreams");
}

/**
 * Extract raw conversation data for dream generation.
 */
function extractConversationData(messages: Message[]): {
  toolsUsed: Set<string>;
  summaryParts: string[];
  userMessageCount: number;
} {
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

  const userMessageCount = messages.filter(m => m.role === "user").length;
  return { toolsUsed, summaryParts, userMessageCount };
}

/**
 * Generate a dream (conversation summary) from recent messages.
 * Uses raw extraction by default; pass a router for LLM-powered consolidation.
 */
export async function generateDream(
  messages: Message[],
  sessionId: string,
  router?: ProviderRouter,
): Promise<Dream> {
  await mkdir(getDreamsDir(), { recursive: true });

  const { toolsUsed, summaryParts, userMessageCount } = extractConversationData(messages);

  let summary: string;
  let llmConsolidated = false;

  // Try LLM consolidation if router is available
  if (router && summaryParts.length > 5) {
    try {
      summary = await consolidateWithLLM(summaryParts, router);
      llmConsolidated = true;
    } catch {
      // Fall back to raw extraction on LLM failure
      summary = summaryParts.join("\n");
    }
  } else {
    summary = summaryParts.join("\n");
  }

  const dream: Dream = {
    id: `dream-${Date.now()}`,
    timestamp: new Date().toISOString(),
    summary,
    sessionId,
    turnCount: userMessageCount,
    toolsUsed: Array.from(toolsUsed),
    llmConsolidated,
  };

  // Persist
  const dreamPath = join(getDreamsDir(), `${dream.id}.json`);
  await writeFile(dreamPath, JSON.stringify(dream, null, 2), "utf-8");

  return dream;
}

/**
 * Use the LLM to consolidate raw conversation excerpts into a concise,
 * structured dream summary.
 */
async function consolidateWithLLM(
  summaryParts: string[],
  router: ProviderRouter,
): Promise<string> {
  const rawContext = summaryParts.join("\n");

  const consolidationPrompt = `Summarize this coding session into a concise dream digest for future context recovery. Focus on:
1. What was the user trying to accomplish?
2. What key decisions were made?
3. What files/areas of code were touched?
4. What problems were encountered and how were they resolved?
5. What's the current state — is the work complete or in-progress?

Keep it under 300 words. Use bullet points. Be specific about file paths and function names.

Session transcript (excerpts):
${rawContext}`;

  let consolidatedText = "";

  const stream = router.stream({
    systemPrompt: "You are a session summarizer. Be concise and specific.",
    messages: [{ role: "user", content: consolidationPrompt }],
    tools: [],
  });

  for await (const event of stream) {
    if (event.type === "text_delta" && event.text) {
      consolidatedText += event.text;
    }
  }

  return consolidatedText || summaryParts.join("\n");
}

/**
 * Consolidate overlapping dreams by merging similar entries.
 * Returns the number of dreams that were merged.
 */
export async function consolidateDreams(
  router?: ProviderRouter,
  maxDreams: number = 10,
): Promise<number> {
  const dreams = await loadRecentDreams(maxDreams * 2);
  if (dreams.length <= maxDreams) return 0;

  // Group dreams by session
  const bySession = new Map<string, Dream[]>();
  for (const dream of dreams) {
    const existing = bySession.get(dream.sessionId) ?? [];
    existing.push(dream);
    bySession.set(dream.sessionId, existing);
  }

  let mergedCount = 0;

  // Merge dreams from the same session
  for (const [sessionId, sessionDreams] of bySession) {
    if (sessionDreams.length <= 1) continue;

    // Combine summaries
    const combined = sessionDreams.map(d => d.summary).join("\n---\n");
    const allTools = new Set(sessionDreams.flatMap(d => d.toolsUsed));
    const totalTurns = sessionDreams.reduce((s, d) => s + d.turnCount, 0);

    let mergedSummary: string;
    if (router) {
      try {
        mergedSummary = await consolidateWithLLM(combined.split("\n"), router);
      } catch {
        mergedSummary = combined.slice(0, 1500);
      }
    } else {
      mergedSummary = combined.slice(0, 1500);
    }

    // Create merged dream
    const merged: Dream = {
      id: `dream-merged-${Date.now()}-${sessionId.slice(0, 6)}`,
      timestamp: sessionDreams[0]!.timestamp,
      summary: mergedSummary,
      sessionId,
      turnCount: totalTurns,
      toolsUsed: Array.from(allTools),
      llmConsolidated: !!router,
    };

    // Write merged, delete originals
    const dir = getDreamsDir();
    await writeFile(join(dir, `${merged.id}.json`), JSON.stringify(merged, null, 2), "utf-8");

    const { unlink } = await import("fs/promises");
    for (const old of sessionDreams) {
      await unlink(join(dir, `${old.id}.json`)).catch(() => {});
    }

    mergedCount += sessionDreams.length - 1;
  }

  return mergedCount;
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
