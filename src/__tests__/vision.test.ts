import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createVision,
  loadVision,
  saveVision,
  updateProgress,
  formatVisionStatus,
  type Vision,
} from "../agent/vision.ts";

describe("Vision", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ashlrcode-vision-test-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("createVision creates file on disk", async () => {
    const vision = await createVision(tmpDir, "Build a CLI tool");

    const filePath = join(tmpDir, ".ashlrcode", "vision.md");
    expect(existsSync(filePath)).toBe(true);
    expect(vision.goal).toBe("Build a CLI tool");
    expect(vision.successCriteria).toEqual([]);
    expect(vision.focusAreas).toEqual([]);
    expect(vision.avoidAreas).toEqual([]);
    expect(vision.progress).toEqual([]);
    expect(vision.createdAt).toBeTruthy();
    expect(vision.updatedAt).toBeTruthy();
  });

  test("loadVision reads it back correctly", async () => {
    const original = await createVision(tmpDir, "Ship v2.0");
    original.successCriteria = ["All tests pass", "Docs updated"];
    original.focusAreas = ["Performance", "UX"];
    original.avoidAreas = ["Breaking changes"];
    original.notes = "Some notes about the vision.";
    await saveVision(tmpDir, original);

    const loaded = await loadVision(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe("Ship v2.0");
    expect(loaded!.successCriteria).toEqual(["All tests pass", "Docs updated"]);
    expect(loaded!.focusAreas).toEqual(["Performance", "UX"]);
    expect(loaded!.avoidAreas).toEqual(["Breaking changes"]);
    expect(loaded!.notes).toBe("Some notes about the vision.");
    expect(loaded!.createdAt).toBe(original.createdAt);
    expect(loaded!.updatedAt).toBe(original.updatedAt);
  });

  test("loadVision returns null for missing file", async () => {
    const result = await loadVision(tmpDir);
    expect(result).toBeNull();
  });

  test("updateProgress appends entries", async () => {
    await createVision(tmpDir, "Refactor everything");

    await updateProgress(tmpDir, "Fixed auth module", 3, 1);
    await updateProgress(tmpDir, "Updated tests", 5, 0);

    const vision = await loadVision(tmpDir);
    expect(vision).not.toBeNull();
    expect(vision!.progress).toHaveLength(2);

    expect(vision!.progress[0]!.summary).toBe("Fixed auth module");
    expect(vision!.progress[0]!.itemsCompleted).toBe(3);
    expect(vision!.progress[0]!.itemsFailed).toBe(1);

    expect(vision!.progress[1]!.summary).toBe("Updated tests");
    expect(vision!.progress[1]!.itemsCompleted).toBe(5);
    expect(vision!.progress[1]!.itemsFailed).toBe(0);

    // updatedAt should be later than createdAt
    expect(vision!.updatedAt >= vision!.createdAt).toBe(true);
  });

  test("formatVisionStatus produces readable output", async () => {
    const vision: Vision = {
      goal: "Build the best CLI",
      successCriteria: ["Fast startup", "Zero crashes"],
      focusAreas: ["Speed", "Reliability"],
      avoidAreas: ["Scope creep"],
      progress: [
        {
          timestamp: "2026-04-01T10:00:00.000Z",
          summary: "Initial scaffolding",
          itemsCompleted: 5,
          itemsFailed: 0,
        },
        {
          timestamp: "2026-04-02T12:00:00.000Z",
          summary: "Added core features",
          itemsCompleted: 10,
          itemsFailed: 2,
        },
      ],
      notes: "",
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
    };

    const output = formatVisionStatus(vision);

    expect(output).toContain("Vision: Build the best CLI");
    expect(output).toContain("Fast startup");
    expect(output).toContain("Zero crashes");
    expect(output).toContain("Speed");
    expect(output).toContain("Reliability");
    expect(output).toContain("Scope creep");
    expect(output).toContain("Initial scaffolding");
    expect(output).toContain("+5");
    expect(output).toContain("-2");
    expect(output).toContain("2026-04-01");
  });

  test("YAML parsing handles arrays and nested objects", async () => {
    const vision: Vision = {
      goal: "Complex vision with special chars: \"quotes\" and backslash\\",
      successCriteria: ["Criterion A", "Criterion B", "Criterion C"],
      focusAreas: ["Area 1", "Area 2"],
      avoidAreas: ["Bad thing 1", "Bad thing 2", "Bad thing 3"],
      progress: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          summary: "First sprint",
          itemsCompleted: 7,
          itemsFailed: 1,
        },
        {
          timestamp: "2026-02-01T00:00:00.000Z",
          summary: "Second sprint with \"quotes\"",
          itemsCompleted: 12,
          itemsFailed: 3,
        },
      ],
      notes: "# Detailed Notes\n\nSome markdown content here.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };

    await saveVision(tmpDir, vision);
    const loaded = await loadVision(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe("Complex vision with special chars: \"quotes\" and backslash\\");
    expect(loaded!.successCriteria).toHaveLength(3);
    expect(loaded!.focusAreas).toHaveLength(2);
    expect(loaded!.avoidAreas).toHaveLength(3);
    expect(loaded!.progress).toHaveLength(2);
    expect(loaded!.progress[0]!.itemsCompleted).toBe(7);
    expect(loaded!.progress[1]!.summary).toBe("Second sprint with \"quotes\"");
    expect(loaded!.notes).toBe("# Detailed Notes\n\nSome markdown content here.");
  });

  test("round-trip preserves empty arrays", async () => {
    await createVision(tmpDir, "Minimal vision");

    const loaded = await loadVision(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.successCriteria).toEqual([]);
    expect(loaded!.focusAreas).toEqual([]);
    expect(loaded!.avoidAreas).toEqual([]);
    expect(loaded!.progress).toEqual([]);
  });
});
