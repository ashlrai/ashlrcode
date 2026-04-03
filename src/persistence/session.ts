/**
 * Session persistence — JSONL append-only logs.
 *
 * Pattern from Claude Code: each session is a JSONL file at
 * ~/.ashlrcode/sessions/<session-id>.jsonl
 *
 * Each line is a JSON object representing a message or event.
 */

import { existsSync } from "fs";
import { readFile, writeFile, appendFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { getConfigDir } from "../config/settings.ts";
import type { Message } from "../providers/types.ts";

export interface SessionMetadata {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  messageCount: number;
  title?: string;
}

interface SessionEntry {
  type: "message" | "metadata" | "compact";
  timestamp: string;
  data: Message | SessionMetadata | { summary: string; messageCountBefore: number };
}

function getSessionsDir(): string {
  return join(getConfigDir(), "sessions");
}

export class Session {
  readonly id: string;
  private filePath: string;
  private metadata: SessionMetadata;

  constructor(id?: string) {
    this.id = id ?? randomUUID().slice(0, 8);
    this.filePath = join(getSessionsDir(), `${this.id}.jsonl`);
    this.metadata = {
      id: this.id,
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider: "",
      model: "",
      messageCount: 0,
    };
  }

  async init(provider: string, model: string): Promise<void> {
    await mkdir(getSessionsDir(), { recursive: true });
    this.metadata.provider = provider;
    this.metadata.model = model;
    await this.appendEntry({
      type: "metadata",
      timestamp: new Date().toISOString(),
      data: this.metadata,
    });
  }

  async appendMessage(message: Message): Promise<void> {
    this.metadata.messageCount++;
    this.metadata.updatedAt = new Date().toISOString();
    await this.appendEntry({
      type: "message",
      timestamp: new Date().toISOString(),
      data: message,
    });
  }

  async appendMessages(messages: Message[]): Promise<void> {
    for (const msg of messages) {
      await this.appendMessage(msg);
    }
  }

  async insertCompactBoundary(summary: string, messageCountBefore: number): Promise<void> {
    await this.appendEntry({
      type: "compact",
      timestamp: new Date().toISOString(),
      data: { summary, messageCountBefore },
    });
  }

  /**
   * Load ALL messages, ignoring compact boundaries.
   * Used for forking and compaction where full history is needed.
   */
  async loadAllMessages(): Promise<Message[]> {
    if (!existsSync(this.filePath)) return [];

    const content = await readFile(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const messages: Message[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (entry.type === "message") {
          messages.push(entry.data as Message);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }

  /**
   * Load messages from the last compact boundary forward.
   * If a compact boundary exists, only messages after it are returned,
   * with a synthetic assistant message prepended containing the summary.
   */
  async loadMessages(): Promise<Message[]> {
    if (!existsSync(this.filePath)) return [];

    const content = await readFile(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Scan in reverse to find last compact boundary
    let lastCompactIndex = -1;
    let compactSummary = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as SessionEntry;
        if (entry.type === "compact") {
          lastCompactIndex = i;
          compactSummary = (entry.data as { summary: string; messageCountBefore: number }).summary;
          break;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Load messages after the boundary (or all if no boundary)
    const startIndex = lastCompactIndex >= 0 ? lastCompactIndex + 1 : 0;
    const messages: Message[] = [];

    for (let i = startIndex; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!) as SessionEntry;
        if (entry.type === "message") {
          messages.push(entry.data as Message);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Prepend synthetic summary message if we found a compact boundary
    if (lastCompactIndex >= 0) {
      messages.unshift({
        role: "user",
        content: "[Previous session context]\n" + compactSummary,
      });
    }

    return messages;
  }

  async setTitle(title: string): Promise<void> {
    this.metadata.title = title;
    // Persist the title update
    await this.appendEntry({
      type: "metadata",
      timestamp: new Date().toISOString(),
      data: { ...this.metadata, title },
    });
  }

  private async appendEntry(entry: SessionEntry): Promise<void> {
    await mkdir(getSessionsDir(), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }
}

/**
 * List recent sessions.
 */
export async function listSessions(limit = 10): Promise<SessionMetadata[]> {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return [];

  const files = await readdir(sessionsDir);
  const sessions: SessionMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;

    const content = await readFile(join(sessionsDir, file), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    try {
      // Find the LAST metadata entry (most recent, includes title updates)
      let latestMetadata: SessionMetadata | null = null;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SessionEntry;
          if (entry.type === "metadata") {
            latestMetadata = entry.data as SessionMetadata;
          }
        } catch { /* skip malformed lines */ }
      }
      if (latestMetadata) {
        sessions.push(latestMetadata);
      }
    } catch {
      // Skip malformed files
    }
  }

  // Sort by most recent first
  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return sessions.slice(0, limit);
}

/**
 * Resume a session by ID.
 */
export async function resumeSession(id: string): Promise<{
  session: Session;
  messages: Message[];
} | null> {
  const session = new Session(id);
  const messages = await session.loadMessages();
  if (messages.length === 0) return null;
  return { session, messages };
}

/**
 * Get the most recent session for a given working directory.
 */
export async function getLastSessionForCwd(cwd: string): Promise<string | null> {
  const sessions = await listSessions(50);
  const match = sessions.find((s) => s.cwd === cwd);
  return match?.id ?? null;
}

/**
 * Fork a session — create a new session with copied message history.
 */
export async function forkSession(
  sourceId: string,
  provider: string,
  model: string
): Promise<{ session: Session; messages: Message[] } | null> {
  const source = new Session(sourceId);
  const messages = await source.loadAllMessages();
  if (messages.length === 0) return null;

  const forked = new Session();
  await forked.init(provider, model);
  await forked.appendMessages(messages);

  return { session: forked, messages };
}

/**
 * Compact a session — insert a boundary marker with a summary of recent messages.
 * Messages before the boundary are excluded from loadMessages() but preserved on disk.
 */
export async function compactSession(id: string): Promise<{ messagesBefore: number; summary: string }> {
  const session = new Session(id);
  const allMessages = await session.loadAllMessages();
  const messagesBefore = allMessages.length;

  // Generate summary from recent messages
  const recentText = allMessages.slice(-10).map(m => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${content.slice(0, 200)}`;
  }).join("\n");

  const summary = `Session context (${messagesBefore} messages):\n${recentText}`;
  await session.insertCompactBoundary(summary, messagesBefore);
  return { messagesBefore, summary };
}
