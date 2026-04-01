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
  data: Message | SessionMetadata | { summary: string };
}

const SESSIONS_DIR = join(getConfigDir(), "sessions");

export class Session {
  readonly id: string;
  private filePath: string;
  private metadata: SessionMetadata;

  constructor(id?: string) {
    this.id = id ?? randomUUID().slice(0, 8);
    this.filePath = join(SESSIONS_DIR, `${this.id}.jsonl`);
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
    await mkdir(SESSIONS_DIR, { recursive: true });
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

  async loadMessages(): Promise<Message[]> {
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

  async setTitle(title: string): Promise<void> {
    this.metadata.title = title;
  }

  private async appendEntry(entry: SessionEntry): Promise<void> {
    await mkdir(SESSIONS_DIR, { recursive: true });
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }
}

/**
 * List recent sessions.
 */
export async function listSessions(limit = 10): Promise<SessionMetadata[]> {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = await readdir(SESSIONS_DIR);
  const sessions: SessionMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;

    const content = await readFile(join(SESSIONS_DIR, file), "utf-8");
    const firstLine = content.split("\n")[0];
    if (!firstLine) continue;

    try {
      const entry = JSON.parse(firstLine) as SessionEntry;
      if (entry.type === "metadata") {
        sessions.push(entry.data as SessionMetadata);
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
