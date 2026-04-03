import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readFile } from "fs/promises";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  initTelemetry,
  logEvent,
  readRecentEvents,
  formatEvents,
} from "../telemetry/event-log.ts";

describe("Telemetry", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ashlrcode-telemetry-test-"));
    setConfigDirForTests(configDir);
  });

  afterEach(() => {
    setConfigDirForTests(null);
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  test("initTelemetry sets session ID that appears in logged events", async () => {
    initTelemetry("test-session-42");
    await logEvent("session_start");

    const events = await readRecentEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.sessionId).toBe("test-session-42");
  });

  test("logEvent writes to JSONL file", async () => {
    initTelemetry("sess-write");
    await logEvent("turn_start", { prompt: "hello" });
    await logEvent("turn_end", { tokens: 100 });

    const logPath = join(configDir, "telemetry", "events.jsonl");
    expect(existsSync(logPath)).toBe(true);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe("turn_start");
    expect(first.data.prompt).toBe("hello");

    const second = JSON.parse(lines[1]!);
    expect(second.type).toBe("turn_end");
    expect(second.data.tokens).toBe(100);
  });

  test("readRecentEvents reads back events", async () => {
    initTelemetry("sess-read");
    await logEvent("session_start");
    await logEvent("tool_start", { tool: "Bash" });
    await logEvent("tool_end", { tool: "Bash" });

    const events = await readRecentEvents();
    expect(events.length).toBe(3);
    expect(events[0]!.type).toBe("session_start");
    expect(events[1]!.type).toBe("tool_start");
    expect(events[2]!.type).toBe("tool_end");
  });

  test("readRecentEvents respects count parameter", async () => {
    initTelemetry("sess-count");
    await logEvent("session_start");
    await logEvent("turn_start");
    await logEvent("turn_end");
    await logEvent("session_end");

    const events = await readRecentEvents(2);
    expect(events.length).toBe(2);
    // Should return the last 2 events
    expect(events[0]!.type).toBe("turn_end");
    expect(events[1]!.type).toBe("session_end");
  });

  test("readRecentEvents returns empty for non-existent log", async () => {
    const events = await readRecentEvents();
    expect(events).toEqual([]);
  });

  test("formatEvents produces readable output", () => {
    const events = [
      {
        type: "session_start" as const,
        timestamp: "2025-01-15T10:30:00.000Z",
        sessionId: "s1",
      },
      {
        type: "tool_start" as const,
        timestamp: "2025-01-15T10:30:05.000Z",
        sessionId: "s1",
        data: { tool: "Bash" },
      },
    ];

    const output = formatEvents(events);
    expect(output).toContain("session_start");
    expect(output).toContain("tool_start");
    expect(output).toContain("Bash");
    // Each line should be indented with two spaces
    const lines = output.split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });

  test("log rotation occurs when file exceeds size limit", async () => {
    initTelemetry("sess-rotate");

    // Manually create the telemetry dir and seed file
    const telemetryDir = join(configDir, "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
    const logPath = join(telemetryDir, "events.jsonl");
    writeFileSync(logPath, "", "utf-8");

    // Now overwrite with a large file that exceeds 5MB
    const bigLine = JSON.stringify({
      type: "session_start",
      timestamp: new Date().toISOString(),
      sessionId: "bulk",
      data: { payload: "x".repeat(1000) },
    }) + "\n";

    const linesNeeded = Math.ceil((5 * 1024 * 1024) / bigLine.length) + 1;
    const bulk = bigLine.repeat(linesNeeded);
    writeFileSync(logPath, bulk, "utf-8");

    // Log one more event which should trigger rotation
    await logEvent("session_start", { after: "rotation" });

    // The old file should have been rotated to events.1.jsonl
    const rotatedPath = join(telemetryDir, "events.1.jsonl");
    expect(existsSync(rotatedPath)).toBe(true);

    // The rotated file should contain the bulk data + the new event
    // (logEvent appends first, then rotates, so the new event is in the rotated file)
    const rotatedContent = await readFile(rotatedPath, "utf-8");
    expect(rotatedContent).toContain("rotation");
  });
});
