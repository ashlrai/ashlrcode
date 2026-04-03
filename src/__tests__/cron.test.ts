import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  createTrigger,
  listTriggers,
  deleteTrigger,
  getDueTriggers,
  markRun,
  toggleTrigger,
  type CronTrigger,
} from "../agent/cron.ts";

describe("Cron Triggers", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ashlrcode-cron-test-"));
    setConfigDirForTests(configDir);
  });

  afterEach(() => {
    setConfigDirForTests(null);
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  describe("parseDuration (via createTrigger)", () => {
    test("handles '30s' — seconds", async () => {
      const trigger = await createTrigger("test-s", "30s", "echo hi", "/tmp");
      expect(trigger.schedule).toBe("30s");
      // nextRun should be ~30 seconds from now
      const nextMs = new Date(trigger.nextRun!).getTime();
      const expectedMs = Date.now() + 30_000;
      expect(Math.abs(nextMs - expectedMs)).toBeLessThan(2000);
    });

    test("handles '5m' — minutes", async () => {
      const trigger = await createTrigger("test-m", "5m", "echo hi", "/tmp");
      const nextMs = new Date(trigger.nextRun!).getTime();
      const expectedMs = Date.now() + 5 * 60_000;
      expect(Math.abs(nextMs - expectedMs)).toBeLessThan(2000);
    });

    test("handles '1h' — hours", async () => {
      const trigger = await createTrigger("test-h", "1h", "echo hi", "/tmp");
      const nextMs = new Date(trigger.nextRun!).getTime();
      const expectedMs = Date.now() + 3_600_000;
      expect(Math.abs(nextMs - expectedMs)).toBeLessThan(2000);
    });

    test("handles '2d' — days", async () => {
      const trigger = await createTrigger("test-d", "2d", "echo hi", "/tmp");
      const nextMs = new Date(trigger.nextRun!).getTime();
      const expectedMs = Date.now() + 2 * 86_400_000;
      expect(Math.abs(nextMs - expectedMs)).toBeLessThan(2000);
    });

    test("rejects invalid schedule format", async () => {
      expect(createTrigger("bad", "5x", "echo", "/tmp")).rejects.toThrow(
        /Invalid schedule/,
      );
    });
  });

  describe("createTrigger", () => {
    test("saves trigger to disk", async () => {
      const trigger = await createTrigger("my-task", "10m", "run tests", "/projects/foo");
      expect(trigger.id).toMatch(/^trigger-/);
      expect(trigger.name).toBe("my-task");
      expect(trigger.prompt).toBe("run tests");
      expect(trigger.cwd).toBe("/projects/foo");
      expect(trigger.enabled).toBe(true);
      expect(trigger.runCount).toBe(0);

      // Verify file exists on disk
      const filePath = join(configDir, "triggers", `${trigger.id}.json`);
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("listTriggers", () => {
    test("returns saved triggers", async () => {
      await createTrigger("a", "1m", "do a", "/tmp");
      // Small delay to ensure unique IDs (based on Date.now())
      await new Promise((r) => setTimeout(r, 5));
      await createTrigger("b", "2m", "do b", "/tmp");

      const triggers = await listTriggers();
      expect(triggers.length).toBe(2);
      const names = triggers.map((t) => t.name);
      expect(names).toContain("a");
      expect(names).toContain("b");
    });

    test("returns empty when no triggers exist", async () => {
      const triggers = await listTriggers();
      expect(triggers).toEqual([]);
    });
  });

  describe("deleteTrigger", () => {
    test("removes trigger file", async () => {
      const trigger = await createTrigger("delete-me", "1m", "x", "/tmp");
      expect(await deleteTrigger(trigger.id)).toBe(true);

      const filePath = join(configDir, "triggers", `${trigger.id}.json`);
      expect(existsSync(filePath)).toBe(false);

      const remaining = await listTriggers();
      expect(remaining.length).toBe(0);
    });

    test("returns false for non-existent trigger", async () => {
      expect(await deleteTrigger("trigger-doesnt-exist")).toBe(false);
    });
  });

  describe("getDueTriggers", () => {
    test("returns only due triggers", () => {
      const now = Date.now();
      const triggers: CronTrigger[] = [
        {
          id: "t1", name: "due", schedule: "1m", prompt: "x", cwd: "/",
          enabled: true, runCount: 0, createdAt: new Date().toISOString(),
          nextRun: new Date(now - 60_000).toISOString(), // 1 min ago — due
        },
        {
          id: "t2", name: "not-yet", schedule: "1m", prompt: "x", cwd: "/",
          enabled: true, runCount: 0, createdAt: new Date().toISOString(),
          nextRun: new Date(now + 60_000).toISOString(), // 1 min future — not due
        },
        {
          id: "t3", name: "disabled-due", schedule: "1m", prompt: "x", cwd: "/",
          enabled: false, runCount: 0, createdAt: new Date().toISOString(),
          nextRun: new Date(now - 60_000).toISOString(), // due but disabled
        },
      ];

      const due = getDueTriggers(triggers);
      expect(due.length).toBe(1);
      expect(due[0]!.id).toBe("t1");
    });

    test("returns empty when none are due", () => {
      const triggers: CronTrigger[] = [
        {
          id: "t1", name: "future", schedule: "1h", prompt: "x", cwd: "/",
          enabled: true, runCount: 0, createdAt: new Date().toISOString(),
          nextRun: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ];
      expect(getDueTriggers(triggers)).toEqual([]);
    });
  });

  describe("markRun", () => {
    test("updates lastRun, runCount, and nextRun", async () => {
      const trigger = await createTrigger("mark-test", "5m", "x", "/tmp");
      expect(trigger.runCount).toBe(0);
      expect(trigger.lastRun).toBeUndefined();

      await markRun(trigger.id);

      // Re-read from disk via listTriggers
      const triggers = await listTriggers();
      const updated = triggers.find((t) => t.id === trigger.id)!;
      expect(updated.runCount).toBe(1);
      expect(updated.lastRun).toBeDefined();
      expect(updated.nextRun).toBeDefined();

      // nextRun should be ~5 min from now
      const nextMs = new Date(updated.nextRun!).getTime();
      const expectedMs = Date.now() + 5 * 60_000;
      expect(Math.abs(nextMs - expectedMs)).toBeLessThan(2000);
    });
  });

  describe("toggleTrigger", () => {
    test("flips enabled flag", async () => {
      const trigger = await createTrigger("toggle-test", "1m", "x", "/tmp");
      expect(trigger.enabled).toBe(true);

      const toggled = await toggleTrigger(trigger.id);
      expect(toggled!.enabled).toBe(false);

      const toggledBack = await toggleTrigger(trigger.id);
      expect(toggledBack!.enabled).toBe(true);
    });

    test("returns null for non-existent trigger", async () => {
      const result = await toggleTrigger("trigger-nope");
      expect(result).toBeNull();
    });
  });
});
