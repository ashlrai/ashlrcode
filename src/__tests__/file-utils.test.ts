/**
 * Tests for shared file-tool utilities (src/tools/file-utils.ts).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FileHistoryStore, setFileHistory } from "../state/file-history.ts";
import {
  validateFilePath,
  resolveFilePath,
  checkFileExists,
  checkSensitivePath,
  SENSITIVE_PATHS,
  captureSnapshot,
} from "../tools/file-utils.ts";

describe("validateFilePath", () => {
  test("returns null for a valid string path", () => {
    expect(validateFilePath({ file_path: "/tmp/foo.txt" })).toBeNull();
  });

  test("returns error when file_path is missing", () => {
    expect(validateFilePath({})).toMatch(/required/);
  });

  test("returns error when file_path is not a string", () => {
    expect(validateFilePath({ file_path: 42 })).toMatch(/required/);
  });

  test("returns error when file_path is empty string", () => {
    expect(validateFilePath({ file_path: "" })).toMatch(/required/);
  });
});

describe("resolveFilePath", () => {
  test("returns absolute path unchanged", () => {
    expect(resolveFilePath("/some/cwd", "/abs/path.ts")).toBe("/abs/path.ts");
  });

  test("resolves relative path against cwd", () => {
    expect(resolveFilePath("/some/cwd", "rel/file.ts")).toBe("/some/cwd/rel/file.ts");
  });
});

describe("checkFileExists", () => {
  const testDir = join(tmpdir(), `file-utils-test-${Date.now()}`);
  const testFile = join(testDir, "exists.txt");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testFile, "content");
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("returns null for an existing file", () => {
    expect(checkFileExists(testFile)).toBeNull();
  });

  test("returns error string for a missing file", () => {
    const missing = join(testDir, "ghost.txt");
    const result = checkFileExists(missing);
    expect(result).not.toBeNull();
    expect(result).toMatch(/File not found/);
    expect(result).toMatch(missing);
  });
});

describe("checkSensitivePath", () => {
  test("returns null for a normal project path", () => {
    expect(checkSensitivePath("/home/user/project/src/foo.ts")).toBeNull();
  });

  test("blocks every sensitive prefix", () => {
    for (const prefix of SENSITIVE_PATHS) {
      const path = `${prefix}target`;
      const result = checkSensitivePath(path);
      expect(result).not.toBeNull();
      expect(result).toMatch(/Cannot write/);
    }
  });

  test("returns null for a path that merely contains 'etc' as non-prefix", () => {
    // "/home/user/etc-config" does not match "/etc/"
    expect(checkSensitivePath("/home/user/etc-config/foo")).toBeNull();
  });
});

describe("captureSnapshot", () => {
  const testDir = join(tmpdir(), `file-utils-snap-${Date.now()}`);
  const testFile = join(testDir, "snap.txt");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testFile, "original");
    const store = new FileHistoryStore(`test-snap-${Date.now()}`);
    setFileHistory(store);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    setFileHistory(new FileHistoryStore("noop"));
  });

  test("records a snapshot for an existing file", async () => {
    await captureSnapshot(testFile, "Write", 1);
    const { getFileHistory } = await import("../state/file-history.ts");
    const store = getFileHistory();
    expect(store?.hasSnapshot(testFile)).toBe(true);
    expect(store?.undoCount).toBe(1);
  });

  test("no-ops gracefully when no store is set", async () => {
    const { setFileHistory } = await import("../state/file-history.ts");
    setFileHistory(null as any);
    // Should not throw
    await expect(captureSnapshot(testFile, "Write", 1)).resolves.toBeUndefined();
  });
});
