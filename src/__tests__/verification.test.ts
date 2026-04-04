import { describe, test, expect, beforeEach } from "bun:test";
import {
  trackFileModification,
  getModifiedFiles,
  clearModifiedFiles,
  shouldAutoVerify,
} from "../agent/verification.ts";

describe("Verification Agent", () => {
  beforeEach(() => {
    clearModifiedFiles();
  });

  describe("file modification tracking", () => {
    test("tracks modified files", () => {
      trackFileModification("/src/foo.ts");
      trackFileModification("/src/bar.ts");
      expect(getModifiedFiles()).toEqual(["/src/foo.ts", "/src/bar.ts"]);
    });

    test("deduplicates same file", () => {
      trackFileModification("/src/foo.ts");
      trackFileModification("/src/foo.ts");
      expect(getModifiedFiles()).toHaveLength(1);
    });

    test("clears tracked files", () => {
      trackFileModification("/src/foo.ts");
      clearModifiedFiles();
      expect(getModifiedFiles()).toHaveLength(0);
    });
  });

  describe("shouldAutoVerify", () => {
    test("returns false with 0 files", () => {
      expect(shouldAutoVerify()).toBe(false);
    });

    test("returns false with 1 file", () => {
      trackFileModification("/src/foo.ts");
      expect(shouldAutoVerify()).toBe(false);
    });

    test("returns true with 2+ files (default threshold)", () => {
      trackFileModification("/src/foo.ts");
      trackFileModification("/src/bar.ts");
      expect(shouldAutoVerify()).toBe(true);
    });

    test("respects custom threshold", () => {
      trackFileModification("/src/foo.ts");
      trackFileModification("/src/bar.ts");
      expect(shouldAutoVerify(3)).toBe(false);
      trackFileModification("/src/baz.ts");
      expect(shouldAutoVerify(3)).toBe(true);
    });
  });
});
