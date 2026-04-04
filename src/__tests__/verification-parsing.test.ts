import { describe, test, expect, beforeEach } from "bun:test";
import {
  trackFileModification,
  getModifiedFiles,
  clearModifiedFiles,
  shouldAutoVerify,
  formatVerificationReport,
  type VerificationResult,
} from "../agent/verification.ts";

describe("Verification Agent", () => {
  beforeEach(() => {
    clearModifiedFiles();
  });

  describe("file modification tracking", () => {
    test("tracks multiple files", () => {
      trackFileModification("/src/a.ts");
      trackFileModification("/src/b.ts");
      trackFileModification("/src/c.ts");
      expect(getModifiedFiles()).toHaveLength(3);
    });

    test("deduplicates", () => {
      trackFileModification("/src/a.ts");
      trackFileModification("/src/a.ts");
      trackFileModification("/src/a.ts");
      expect(getModifiedFiles()).toHaveLength(1);
    });

    test("clear resets everything", () => {
      trackFileModification("/src/a.ts");
      trackFileModification("/src/b.ts");
      clearModifiedFiles();
      expect(getModifiedFiles()).toHaveLength(0);
      expect(shouldAutoVerify()).toBe(false);
    });
  });

  describe("shouldAutoVerify", () => {
    test("false with 0 files", () => expect(shouldAutoVerify()).toBe(false));
    test("false with 1 file", () => {
      trackFileModification("/a.ts");
      expect(shouldAutoVerify()).toBe(false);
    });
    test("true with 2 files", () => {
      trackFileModification("/a.ts");
      trackFileModification("/b.ts");
      expect(shouldAutoVerify()).toBe(true);
    });
    test("custom threshold of 5", () => {
      for (let i = 0; i < 4; i++) trackFileModification(`/f${i}.ts`);
      expect(shouldAutoVerify(5)).toBe(false);
      trackFileModification("/f4.ts");
      expect(shouldAutoVerify(5)).toBe(true);
    });
  });

  describe("formatVerificationReport", () => {
    test("formats passing result", () => {
      const result: VerificationResult = {
        passed: true,
        issues: [],
        summary: "All checks passed",
        filesChecked: ["/src/a.ts", "/src/b.ts"],
        agentResult: { name: "v", text: "", toolCalls: [], messages: [] },
      };
      const report = formatVerificationReport(result);
      expect(report).toContain("Passed");
      expect(report).toContain("2");
      expect(report).toContain("All checks passed");
    });

    test("formats failing result with issues", () => {
      const result: VerificationResult = {
        passed: false,
        issues: [
          { severity: "error", file: "src/foo.ts", line: 42, description: "Missing import" },
          { severity: "warning", file: "src/bar.ts", description: "Unused variable" },
          { severity: "info", file: "src/baz.ts", line: 10, description: "Consider refactoring" },
        ],
        summary: "Found 1 error and 1 warning",
        filesChecked: ["/src/foo.ts"],
        agentResult: { name: "v", text: "", toolCalls: [], messages: [] },
      };
      const report = formatVerificationReport(result);
      expect(report).toContain("Failed");
      expect(report).toContain("Missing import");
      expect(report).toContain("src/foo.ts:42");
      expect(report).toContain("src/bar.ts");
      expect(report).toContain("Issues");
    });

    test("handles zero issues on pass", () => {
      const result: VerificationResult = {
        passed: true,
        issues: [],
        summary: "Clean",
        filesChecked: [],
        agentResult: { name: "v", text: "", toolCalls: [], messages: [] },
      };
      const report = formatVerificationReport(result);
      expect(report).not.toContain("Issues");
    });
  });
});
