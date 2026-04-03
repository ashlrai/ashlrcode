import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { FileHistoryStore, setFileHistory, getFileHistory, fileHistory } from "../state/file-history.ts";
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("FileHistoryStore", () => {
  const testDir = join(tmpdir(), `ashlrcode-test-${Date.now()}`);
  const testFile = join(testDir, "test.txt");
  let store: FileHistoryStore;

  beforeEach(() => {
    store = new FileHistoryStore(`test-${Date.now()}`);
    setFileHistory(store);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("capture records existing file content", async () => {
    writeFileSync(testFile, "original content");
    await store.capture(testFile, "Write", 1);
    expect(store.hasSnapshot(testFile)).toBe(true);
    expect(store.undoCount).toBe(1);
  });

  test("capture records new file as empty content (undo = delete)", async () => {
    const newFile = join(testDir, "brand-new.txt");
    await store.capture(newFile, "Write", 1);
    expect(store.hasSnapshot(newFile)).toBe(true);
    expect(store.undoCount).toBe(1);
  });

  test("undoLast restores previous content", async () => {
    writeFileSync(testFile, "version 1");
    await store.capture(testFile, "Edit", 1);

    writeFileSync(testFile, "version 2");
    expect(readFileSync(testFile, "utf-8")).toBe("version 2");

    const result = await store.undoLast();
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe(testFile);
    expect(result!.restored).toBe(true);
    expect(readFileSync(testFile, "utf-8")).toBe("version 1");
  });

  test("undoLast deletes newly created file", async () => {
    const newFile = join(testDir, "created.txt");
    await store.capture(newFile, "Write", 1);

    writeFileSync(newFile, "new content");
    expect(existsSync(newFile)).toBe(true);

    const result = await store.undoLast();
    expect(result).not.toBeNull();
    expect(existsSync(newFile)).toBe(false);
  });

  test("undoLast returns null when no snapshots", async () => {
    const result = await store.undoLast();
    expect(result).toBeNull();
  });

  test("multiple snapshots form a stack (LIFO)", async () => {
    writeFileSync(testFile, "v1");
    await store.capture(testFile, "Edit", 1);

    writeFileSync(testFile, "v2");
    await store.capture(testFile, "Edit", 2);

    writeFileSync(testFile, "v3");

    // First undo → v2
    await store.undoLast();
    expect(readFileSync(testFile, "utf-8")).toBe("v2");

    // Second undo → v1
    await store.undoLast();
    expect(readFileSync(testFile, "utf-8")).toBe("v1");

    expect(store.undoCount).toBe(0);
  });

  test("undoTurn restores all changes from a specific turn", async () => {
    const file2 = join(testDir, "other.txt");
    writeFileSync(testFile, "a-original");
    writeFileSync(file2, "b-original");

    await store.capture(testFile, "Edit", 3);
    await store.capture(file2, "Edit", 3);

    writeFileSync(testFile, "a-modified");
    writeFileSync(file2, "b-modified");

    const restored = await store.undoTurn(3);
    expect(restored).toContain(testFile);
    expect(restored).toContain(file2);
    expect(readFileSync(testFile, "utf-8")).toBe("a-original");
    expect(readFileSync(file2, "utf-8")).toBe("b-original");
    expect(store.undoCount).toBe(0);
  });

  test("undoTurn only affects the specified turn", async () => {
    writeFileSync(testFile, "turn1-before");
    await store.capture(testFile, "Edit", 1);
    writeFileSync(testFile, "turn1-after");

    await store.capture(testFile, "Edit", 2);
    writeFileSync(testFile, "turn2-after");

    // Undo only turn 2
    await store.undoTurn(2);
    expect(readFileSync(testFile, "utf-8")).toBe("turn1-after");
    expect(store.undoCount).toBe(1); // turn 1 snapshot still there
  });

  test("getSnapshotFiles returns files with snapshots", async () => {
    const file2 = join(testDir, "other.txt");
    writeFileSync(testFile, "content1");
    writeFileSync(file2, "content2");

    await store.capture(testFile, "Write", 1);
    await store.capture(file2, "Edit", 1);

    const files = store.getSnapshotFiles();
    expect(files.length).toBe(2);

    const paths = files.map((f) => f.path);
    expect(paths).toContain(testFile);
    expect(paths).toContain(file2);

    for (const f of files) {
      expect(f.count).toBe(1);
      expect(f.lastModified).toBeTruthy();
    }
  });

  test("getHistory returns snapshots newest first", async () => {
    writeFileSync(testFile, "v1");
    await store.capture(testFile, "Edit", 1);
    writeFileSync(testFile, "v2");
    await store.capture(testFile, "Edit", 2);

    const history = store.getHistory();
    expect(history.length).toBe(2);
    expect(history[0]!.turnNumber).toBe(2); // newest first
    expect(history[1]!.turnNumber).toBe(1);
  });

  test("clear removes all snapshots", async () => {
    writeFileSync(testFile, "content");
    await store.capture(testFile, "Write", 1);
    expect(store.hasSnapshot(testFile)).toBe(true);

    store.clear();
    expect(store.hasSnapshot(testFile)).toBe(false);
    expect(store.getSnapshotFiles()).toEqual([]);
    expect(store.undoCount).toBe(0);
  });

  // Backward-compat shim tests
  test("fileHistory shim delegates to the active store", async () => {
    writeFileSync(testFile, "original");
    await fileHistory.snapshot(testFile);
    expect(fileHistory.hasSnapshot(testFile)).toBe(true);

    writeFileSync(testFile, "changed");
    const restored = await fileHistory.restore(testFile);
    expect(restored).toBe(true);
    expect(readFileSync(testFile, "utf-8")).toBe("original");
  });
});
