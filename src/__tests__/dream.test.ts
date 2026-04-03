import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFile, mkdir } from "fs/promises";
import {
  generateDream,
  loadRecentDreams,
  formatDreamsForPrompt,
  pruneOldDreams,
  IdleDetector,
} from "../agent/dream.ts";
import { setConfigDirForTests } from "../config/settings.ts";
import type { Message } from "../providers/types.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-dream-test-"));
  setConfigDirForTests(configDir);
});

afterEach(() => {
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

describe("generateDream", () => {
  test("creates a dream file on disk", async () => {
    const messages: Message[] = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there!" },
    ];

    const dream = await generateDream(messages, "test-session-1");

    expect(dream.id).toMatch(/^dream-/);
    expect(dream.sessionId).toBe("test-session-1");
    expect(dream.turnCount).toBe(1); // 1 user message
    expect(dream.summary).toContain("user: Hello world");

    // File should exist on disk
    const dreamPath = join(configDir, "dreams", `${dream.id}.json`);
    expect(existsSync(dreamPath)).toBe(true);
  });

  test("extracts tool names from content blocks", async () => {
    const messages: Message[] = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running a command" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
        ],
      },
    ];

    const dream = await generateDream(messages, "test-session-2");
    expect(dream.toolsUsed).toContain("Bash");
  });
});

describe("loadRecentDreams", () => {
  test("loads saved dreams", async () => {
    // Generate a couple of dreams
    const msgs: Message[] = [{ role: "user", content: "Test" }];
    await generateDream(msgs, "s1");
    // Small delay so filenames differ
    await new Promise((r) => setTimeout(r, 5));
    await generateDream(msgs, "s2");

    const dreams = await loadRecentDreams(10);
    expect(dreams.length).toBe(2);
  });

  test("respects limit parameter", async () => {
    const msgs: Message[] = [{ role: "user", content: "Test" }];
    for (let i = 0; i < 5; i++) {
      await generateDream(msgs, `s${i}`);
      await new Promise((r) => setTimeout(r, 5));
    }

    const dreams = await loadRecentDreams(2);
    expect(dreams.length).toBe(2);
  });

  test("returns empty array when no dreams dir exists", async () => {
    const dreams = await loadRecentDreams();
    expect(dreams).toEqual([]);
  });
});

describe("formatDreamsForPrompt", () => {
  test("returns empty string for no dreams", () => {
    expect(formatDreamsForPrompt([])).toBe("");
  });

  test("formats dreams with header and content", () => {
    const dreams = [
      {
        id: "dream-1",
        timestamp: "2026-01-15T10:00:00.000Z",
        summary: "user: Did some work\nassistant: Completed task",
        sessionId: "s1",
        turnCount: 3,
        toolsUsed: ["Bash", "Read"],
      },
    ];

    const result = formatDreamsForPrompt(dreams);
    expect(result).toContain("## Recent Session Dreams");
    expect(result).toContain("3 turns");
    expect(result).toContain("tools: Bash, Read");
    expect(result).toContain("user: Did some work");
  });

  test("omits tools section when no tools used", () => {
    const dreams = [
      {
        id: "dream-2",
        timestamp: "2026-01-15T10:00:00.000Z",
        summary: "conversation summary",
        sessionId: "s2",
        turnCount: 1,
        toolsUsed: [],
      },
    ];

    const result = formatDreamsForPrompt(dreams);
    expect(result).not.toContain("tools:");
  });
});

describe("pruneOldDreams", () => {
  test("keeps only recent N dreams", async () => {
    const msgs: Message[] = [{ role: "user", content: "Test" }];
    for (let i = 0; i < 5; i++) {
      await generateDream(msgs, `s${i}`);
      await new Promise((r) => setTimeout(r, 5));
    }

    const deleted = await pruneOldDreams(2);
    expect(deleted).toBe(3);

    const remaining = await loadRecentDreams(10);
    expect(remaining.length).toBe(2);
  });

  test("returns 0 when no dreams dir exists", async () => {
    const deleted = await pruneOldDreams(5);
    expect(deleted).toBe(0);
  });
});

describe("IdleDetector", () => {
  test("fires callback after threshold", async () => {
    let fired = false;
    const detector = new IdleDetector(() => { fired = true; }, 50);
    detector.ping();

    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(true);
    detector.stop();
  });

  test("resets on ping", async () => {
    let fireCount = 0;
    const detector = new IdleDetector(() => { fireCount++; }, 80);

    detector.ping();
    await new Promise((r) => setTimeout(r, 40));
    // Reset before it fires
    detector.ping();
    await new Promise((r) => setTimeout(r, 40));
    // Reset again
    detector.ping();
    await new Promise((r) => setTimeout(r, 40));

    // Should not have fired yet (each ping resets the 80ms timer)
    expect(fireCount).toBe(0);

    // Now wait for it to fire
    await new Promise((r) => setTimeout(r, 100));
    expect(fireCount).toBe(1);
    detector.stop();
  });

  test("stop prevents callback from firing", async () => {
    let fired = false;
    const detector = new IdleDetector(() => { fired = true; }, 50);
    detector.ping();
    detector.stop();

    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(false);
  });
});
