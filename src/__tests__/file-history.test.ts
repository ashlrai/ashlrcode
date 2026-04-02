import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { fileHistory } from "../state/file-history.ts";
import { writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("FileHistoryStore", () => {
  const testDir = join(tmpdir(), `ashlrcode-test-${Date.now()}`);
  const testFile = join(testDir, "test.txt");

  beforeEach(() => {
    fileHistory.clear();
    const { mkdirSync } = require("fs");
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("snapshot captures file content", async () => {
    writeFileSync(testFile, "original content");
    await fileHistory.snapshot(testFile);
    expect(fileHistory.hasSnapshot(testFile)).toBe(true);
  });

  test("snapshot does nothing for non-existent file", async () => {
    await fileHistory.snapshot("/nonexistent/path/to/file.txt");
    expect(fileHistory.hasSnapshot("/nonexistent/path/to/file.txt")).toBe(false);
  });

  test("restore writes back the snapshot content", async () => {
    writeFileSync(testFile, "version 1");
    await fileHistory.snapshot(testFile);

    writeFileSync(testFile, "version 2");
    expect(readFileSync(testFile, "utf-8")).toBe("version 2");

    const restored = await fileHistory.restore(testFile);
    expect(restored).toBe(true);
    expect(readFileSync(testFile, "utf-8")).toBe("version 1");
  });

  test("restore returns false when no snapshots exist", async () => {
    const result = await fileHistory.restore("/no/such/file");
    expect(result).toBe(false);
  });

  test("multiple snapshots create a stack (LIFO)", async () => {
    writeFileSync(testFile, "v1");
    await fileHistory.snapshot(testFile);

    writeFileSync(testFile, "v2");
    await fileHistory.snapshot(testFile);

    writeFileSync(testFile, "v3");

    // First restore should bring back v2
    await fileHistory.restore(testFile);
    expect(readFileSync(testFile, "utf-8")).toBe("v2");

    // Second restore should bring back v1
    await fileHistory.restore(testFile);
    expect(readFileSync(testFile, "utf-8")).toBe("v1");

    // No more snapshots
    expect(fileHistory.hasSnapshot(testFile)).toBe(false);
  });

  test("getSnapshotFiles returns files with snapshots", async () => {
    const file2 = join(testDir, "other.txt");
    writeFileSync(testFile, "content1");
    writeFileSync(file2, "content2");

    await fileHistory.snapshot(testFile);
    await fileHistory.snapshot(file2);

    const files = fileHistory.getSnapshotFiles();
    expect(files.length).toBe(2);

    const paths = files.map((f) => f.path);
    expect(paths).toContain(testFile);
    expect(paths).toContain(file2);

    for (const f of files) {
      expect(f.count).toBe(1);
      expect(f.lastModified).toBeTruthy();
    }
  });

  test("clear removes all snapshots", async () => {
    writeFileSync(testFile, "content");
    await fileHistory.snapshot(testFile);
    expect(fileHistory.hasSnapshot(testFile)).toBe(true);

    fileHistory.clear();
    expect(fileHistory.hasSnapshot(testFile)).toBe(false);
    expect(fileHistory.getSnapshotFiles()).toEqual([]);
  });

  test("restore removes snapshot entry when stack is emptied", async () => {
    writeFileSync(testFile, "v1");
    await fileHistory.snapshot(testFile);

    await fileHistory.restore(testFile);
    expect(fileHistory.hasSnapshot(testFile)).toBe(false);
    // getSnapshotFiles should not include it
    expect(fileHistory.getSnapshotFiles().find((f) => f.path === testFile)).toBeUndefined();
  });
});
