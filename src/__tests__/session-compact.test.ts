import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Session, resumeSession, forkSession, compactSession } from "../persistence/session.ts";
import { rmSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";

describe("Session compact boundaries", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ashlrcode-compact-test-"));
    setConfigDirForTests(configDir);
  });

  afterEach(() => {
    setConfigDirForTests(null);
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  // ── insertCompactBoundary ─────────────────────────────────────────────

  test("insertCompactBoundary writes a compact entry to the JSONL file", async () => {
    const session = new Session("compact-write-test");
    await session.init("xai", "grok");
    await session.appendMessage({ role: "user", content: "hello" });
    await session.appendMessage({ role: "assistant", content: "hi" });

    await session.insertCompactBoundary("Summary of conversation", 2);

    const sessionsDir = join(configDir, "sessions");
    const content = await Bun.file(join(sessionsDir, "compact-write-test.jsonl")).text();
    const lines = content.trim().split("\n");
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.type).toBe("compact");
    expect(lastEntry.data.summary).toBe("Summary of conversation");
    expect(lastEntry.data.messageCountBefore).toBe(2);
  });

  // ── loadMessages with compact boundary ────────────────────────────────

  test("loadMessages skips messages before compact boundary", async () => {
    const session = new Session("compact-skip-test");
    await session.init("xai", "grok");

    // Messages before boundary
    await session.appendMessage({ role: "user", content: "old message 1" });
    await session.appendMessage({ role: "assistant", content: "old reply 1" });
    await session.flush(); // Wait for fire-and-forget assistant writes before boundary

    // Insert boundary
    await session.insertCompactBoundary("Old context summary", 2);

    // Messages after boundary
    await session.appendMessage({ role: "user", content: "new message" });
    await session.appendMessage({ role: "assistant", content: "new reply" });
    await session.flush(); // Wait for fire-and-forget assistant writes

    const messages = await session.loadMessages();
    // Should have: 1 synthetic summary + 2 new messages = 3
    expect(messages).toHaveLength(3);

    // Should NOT contain old messages
    const contents = messages.map((m) => m.content);
    expect(contents).not.toContain("old message 1");
    expect(contents).not.toContain("old reply 1");
  });

  test("loadMessages injects summary as user message", async () => {
    const session = new Session("compact-summary-test");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "hello" });
    await session.insertCompactBoundary("This is the summary", 1);
    await session.appendMessage({ role: "user", content: "next question" });

    const messages = await session.loadMessages();
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("[Previous session context]");
    expect(messages[0]!.content).toContain("This is the summary");
  });

  test("loadMessages returns all messages when no boundary exists", async () => {
    const session = new Session("compact-none-test");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "msg1" });
    await session.appendMessage({ role: "assistant", content: "msg2" });
    await session.appendMessage({ role: "user", content: "msg3" });

    const messages = await session.loadMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toBe("msg1");
  });

  // ── loadAllMessages ignores boundaries ────────────────────────────────

  test("loadAllMessages returns all messages ignoring compact boundaries", async () => {
    const session = new Session("compact-all-test");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "before" });
    await session.insertCompactBoundary("summary", 1);
    await session.appendMessage({ role: "user", content: "after" });

    const allMessages = await session.loadAllMessages();
    expect(allMessages).toHaveLength(2);
    expect(allMessages[0]!.content).toBe("before");
    expect(allMessages[1]!.content).toBe("after");
    // No synthetic summary injected
    const contents = allMessages.map((m) => m.content);
    expect(contents.some((c) => typeof c === "string" && c.includes("[Previous session context]"))).toBe(false);
  });

  // ── compactSession ────────────────────────────────────────────────────

  test("compactSession creates boundary with summary of recent messages", async () => {
    const session = new Session("compact-session-test");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "question 1" });
    await session.appendMessage({ role: "assistant", content: "answer 1" });
    await session.appendMessage({ role: "user", content: "question 2" });
    await session.appendMessage({ role: "assistant", content: "answer 2" });
    await session.flush(); // Wait for fire-and-forget writes

    const result = await compactSession("compact-session-test");
    expect(result.messagesBefore).toBe(4);
    expect(result.summary).toContain("question 1");
    expect(result.summary).toContain("answer 2");

    // After compaction, loadMessages should return summary + no old messages
    const messages = await session.loadMessages();
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("[Previous session context]");
    // Only the synthetic summary should be returned (no messages after the boundary)
    expect(messages).toHaveLength(1);
  });

  // ── forkSession uses loadAllMessages ──────────────────────────────────

  test("forkSession preserves full history including before compact boundary", async () => {
    const session = new Session("compact-fork-source");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "old msg" });
    await session.insertCompactBoundary("summary", 1);
    await session.appendMessage({ role: "user", content: "new msg" });

    const forked = await forkSession("compact-fork-source", "xai", "grok");
    expect(forked).not.toBeNull();

    // Fork should have ALL messages (loadAllMessages), not just post-boundary
    const forkedMessages = await forked!.session.loadAllMessages();
    expect(forkedMessages).toHaveLength(2);
    expect(forkedMessages[0]!.content).toBe("old msg");
    expect(forkedMessages[1]!.content).toBe("new msg");
  });

  // ── Multiple boundaries ───────────────────────────────────────────────

  test("multiple boundaries: loadMessages uses the last one", async () => {
    const session = new Session("compact-multi-test");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "era 1" });
    await session.insertCompactBoundary("Summary of era 1", 1);

    await session.appendMessage({ role: "user", content: "era 2" });
    await session.insertCompactBoundary("Summary of eras 1+2", 2);

    await session.appendMessage({ role: "user", content: "era 3" });

    const messages = await session.loadMessages();
    // Should use the LAST boundary: summary of eras 1+2 + era 3 message
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain("Summary of eras 1+2");
    expect(messages[1]!.content).toBe("era 3");
  });

  test("multiple boundaries: loadAllMessages returns everything", async () => {
    const session = new Session("compact-multi-all-test");
    await session.init("xai", "grok");

    await session.appendMessage({ role: "user", content: "era 1" });
    await session.insertCompactBoundary("Summary 1", 1);
    await session.appendMessage({ role: "user", content: "era 2" });
    await session.insertCompactBoundary("Summary 2", 2);
    await session.appendMessage({ role: "user", content: "era 3" });

    const allMessages = await session.loadAllMessages();
    expect(allMessages).toHaveLength(3);
  });
});
