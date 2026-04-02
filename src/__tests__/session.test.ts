import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Session, resumeSession } from "../persistence/session.ts";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Sessions are stored under ~/.ashlrcode/sessions/
// We'll use real file I/O but clean up after each test
const SESSIONS_DIR = join(homedir(), ".ashlrcode", "sessions");

describe("Session", () => {
  const testIds: string[] = [];

  function trackId(id: string) {
    testIds.push(id);
    return id;
  }

  afterEach(() => {
    // Clean up test session files
    for (const id of testIds) {
      const path = join(SESSIONS_DIR, `${id}.jsonl`);
      if (existsSync(path)) {
        rmSync(path);
      }
    }
    testIds.length = 0;
  });

  test("creates a session with unique id", () => {
    const s1 = new Session();
    const s2 = new Session();
    expect(s1.id).not.toBe(s2.id);
    expect(s1.id.length).toBeGreaterThan(0);
  });

  test("creates a session with provided id", () => {
    const s = new Session("test-123");
    expect(s.id).toBe("test-123");
  });

  test("init creates file and writes metadata", async () => {
    const id = trackId(`test-init-${Date.now()}`);
    const session = new Session(id);
    await session.init("xai", "grok-4");

    const path = join(SESSIONS_DIR, `${id}.jsonl`);
    expect(existsSync(path)).toBe(true);

    const content = await Bun.file(path).text();
    const entry = JSON.parse(content.split("\n")[0]!);
    expect(entry.type).toBe("metadata");
    expect(entry.data.provider).toBe("xai");
    expect(entry.data.model).toBe("grok-4");
  });

  test("appendMessage adds messages to file", async () => {
    const id = trackId(`test-append-${Date.now()}`);
    const session = new Session(id);
    await session.init("anthropic", "claude");

    await session.appendMessage({ role: "user", content: "Hello" });
    await session.appendMessage({
      role: "assistant",
      content: "Hi there!",
    });

    const path = join(SESSIONS_DIR, `${id}.jsonl`);
    const lines = (await Bun.file(path).text()).trim().split("\n");
    // 1 metadata + 2 messages = 3 lines
    expect(lines.length).toBe(3);
  });

  test("loadMessages returns only message entries", async () => {
    const id = trackId(`test-load-${Date.now()}`);
    const session = new Session(id);
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "question" });
    await session.appendMessage({
      role: "assistant",
      content: "answer",
    });

    const messages = await session.loadMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("question");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("answer");
  });

  test("loadMessages returns empty for non-existent session", async () => {
    const session = new Session("nonexistent-xyz");
    const messages = await session.loadMessages();
    expect(messages).toEqual([]);
  });

  test("setTitle persists title in metadata entry", async () => {
    const id = trackId(`test-title-${Date.now()}`);
    const session = new Session(id);
    await session.init("xai", "grok");
    await session.setTitle("My cool session");

    const path = join(SESSIONS_DIR, `${id}.jsonl`);
    const lines = (await Bun.file(path).text()).trim().split("\n");
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.type).toBe("metadata");
    expect(lastEntry.data.title).toBe("My cool session");
  });
});

describe("resumeSession", () => {
  const testIds: string[] = [];

  afterEach(() => {
    for (const id of testIds) {
      const path = join(SESSIONS_DIR, `${id}.jsonl`);
      if (existsSync(path)) rmSync(path);
    }
    testIds.length = 0;
  });

  test("returns session and messages for existing session", async () => {
    const id = `test-resume-${Date.now()}`;
    testIds.push(id);
    const session = new Session(id);
    await session.init("xai", "grok");
    await session.appendMessage({ role: "user", content: "hello" });

    const result = await resumeSession(id);
    expect(result).not.toBeNull();
    expect(result!.session.id).toBe(id);
    expect(result!.messages).toHaveLength(1);
  });

  test("returns null for empty/nonexistent session", async () => {
    const result = await resumeSession("does-not-exist-999");
    expect(result).toBeNull();
  });
});
