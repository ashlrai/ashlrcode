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
import type { SessionId } from "../types/branded.ts";

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
  /**
   * Fire-and-forget write queue. Assistant messages are appended via this
   * queue for low latency — writes are ordered but non-blocking. User messages
   * bypass this queue and await directly (crash recovery requires durability).
   */
  private writeQueue: Promise<void> = Promise.resolve();

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

  /**
   * Append a message to the session log.
   * User messages are written with blocking I/O (crash recovery).
   * Assistant messages use fire-and-forget with ordering guarantees.
   */
  async appendMessage(message: Message): Promise<void> {
    this.metadata.messageCount++;
    this.metadata.updatedAt = new Date().toISOString();
    const entry: SessionEntry = {
      type: "message",
      timestamp: new Date().toISOString(),
      data: message,
    };

    if (message.role === "user") {
      // Blocking write — if we crash, user input is preserved
      await this.appendEntry(entry);
    } else {
      // Fire-and-forget with ordering — chain onto write queue
      this.writeQueue = this.writeQueue.then(() =>
        this.appendEntry(entry)
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[session] Fire-and-forget write failed:", msg);
      });
    }
  }

  async appendMessages(messages: Message[]): Promise<void> {
    for (const msg of messages) {
      await this.appendMessage(msg);
    }
  }

  /** Wait for all queued writes to complete (call before exit). */
  async flush(): Promise<void> {
    await this.writeQueue;
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
    try {
      await mkdir(getSessionsDir(), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[session] Failed to persist entry:", msg);
    }
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

/**
 * Import a Claude Code JSONL session file into AshlrCode format.
 *
 * Claude Code sessions use JSONL with entries like:
 *   {"type":"human","message":{"role":"user","content":"..."}}
 *   {"type":"assistant","message":{"role":"assistant","content":[...]}}
 *
 * This is a best-effort parser — unparseable lines are skipped.
 */
export async function importClaudeCodeSession(
  claudeSessionPath: string,
  provider = "imported",
  model = "claude-code"
): Promise<Session> {
  if (!existsSync(claudeSessionPath)) {
    throw new Error(`Session file not found: ${claudeSessionPath}`);
  }

  const content = await readFile(claudeSessionPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const messages: Message[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Claude Code format: {type: "human"|"assistant", message: {role, content}}
      if (entry.message && entry.message.role && entry.message.content !== undefined) {
        const role = entry.message.role;
        if (role === "user" || role === "assistant") {
          // Normalize content — Claude Code may use content blocks or strings
          let normalizedContent: string;
          if (typeof entry.message.content === "string") {
            normalizedContent = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            // Extract text from content blocks
            const textParts: string[] = [];
            for (const block of entry.message.content) {
              if (block.type === "text" && block.text) {
                textParts.push(block.text);
              } else if (typeof block === "string") {
                textParts.push(block);
              }
            }
            normalizedContent = textParts.join("\n");
          } else {
            continue; // Skip entries with unrecognized content format
          }

          if (normalizedContent.trim()) {
            messages.push({ role, content: normalizedContent });
          }
        }
      }

      // Alternative format: direct {role, content} entries (some Claude Code variants)
      else if (entry.role && entry.content !== undefined && !entry.type) {
        const role = entry.role;
        if (role === "user" || role === "assistant") {
          const normalizedContent = typeof entry.content === "string"
            ? entry.content
            : Array.isArray(entry.content)
              ? entry.content
                  .filter((b: Record<string, unknown>) => b.type === "text" && b.text)
                  .map((b: Record<string, unknown>) => b.text as string)
                  .join("\n")
              : "";

          if (normalizedContent.trim()) {
            messages.push({ role, content: normalizedContent });
          }
        }
      }

      // AshlrCode's own format: {type: "message", data: {role, content}}
      else if (entry.type === "message" && entry.data?.role) {
        const role = entry.data.role;
        if (role === "user" || role === "assistant") {
          const normalizedContent = typeof entry.data.content === "string"
            ? entry.data.content
            : "";
          if (normalizedContent.trim()) {
            messages.push({ role, content: normalizedContent });
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (messages.length === 0) {
    throw new Error("No parseable messages found in session file.");
  }

  const session = new Session();
  await session.init(provider, model);
  await session.appendMessages(messages);
  await session.setTitle(`Imported from ${claudeSessionPath.split("/").pop() ?? "claude-code"}`);

  return session;
}
