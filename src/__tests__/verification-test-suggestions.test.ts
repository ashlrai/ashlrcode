/**
 * Tests for the inline test recommendation feature added to verification.ts.
 *
 * Covers:
 *   - parseTestSuggestions: parses the TEST_SUGGESTIONS block
 *   - parseVerificationOutput: extracts both issues AND test suggestions
 *   - testPathForSource: derives correct test file path from source path
 *   - generateTestStubs: writes stubs for high-coverage suggestions
 */

import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseTestSuggestions,
  parseVerificationOutput,
  testPathForSource,
  generateTestStubs,
  type TestSuggestion,
} from "../agent/verification.ts";

// ── parseTestSuggestions ──────────────────────────────────────────────────────

describe("parseTestSuggestions", () => {
  test("parses a well-formed TEST_SUGGESTIONS block", () => {
    const text = `
VERIFICATION_RESULT:
STATUS: PASS
SUMMARY: All good

TEST_SUGGESTIONS:
- FILE: src/agent/verification.ts | TEST: should handle null input | DESC: Covers the null-guard | COVERAGE: 85 | LINES: 8
- FILE: src/ui/theme.ts | TEST: throws on missing key | DESC: Error path coverage | COVERAGE: 72 | LINES: 5
`;
    const suggestions = parseTestSuggestions(text);
    expect(suggestions).toHaveLength(2);

    expect(suggestions[0]).toMatchObject({
      file: "src/agent/verification.ts",
      testName: "should handle null input",
      description: "Covers the null-guard",
      coverage: 85,
      estimatedLines: 8,
    });

    expect(suggestions[1]).toMatchObject({
      file: "src/ui/theme.ts",
      testName: "throws on missing key",
      coverage: 72,
      estimatedLines: 5,
    });
  });

  test("returns empty array when no TEST_SUGGESTIONS block", () => {
    const text = "VERIFICATION_RESULT:\nSTATUS: PASS\nSUMMARY: ok";
    expect(parseTestSuggestions(text)).toEqual([]);
  });

  test("skips malformed lines missing required fields", () => {
    const text = `
TEST_SUGGESTIONS:
- FILE: src/foo.ts | TEST: valid test | DESC: desc | COVERAGE: 80 | LINES: 6
- this line has no pipe-separated fields
- FILE: src/bar.ts | COVERAGE: 90
`;
    const suggestions = parseTestSuggestions(text);
    // Only the first line is valid (has FILE + TEST + COVERAGE)
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.file).toBe("src/foo.ts");
  });

  test("handles coverage and lines as integers", () => {
    const text = `
TEST_SUGGESTIONS:
- FILE: src/x.ts | TEST: name | DESC: d | COVERAGE: 77 | LINES: 10
`;
    const [s] = parseTestSuggestions(text);
    expect(typeof s!.coverage).toBe("number");
    expect(typeof s!.estimatedLines).toBe("number");
    expect(s!.coverage).toBe(77);
    expect(s!.estimatedLines).toBe(10);
  });

  test("defaults estimatedLines to 5 when LINES is absent", () => {
    const text = `
TEST_SUGGESTIONS:
- FILE: src/x.ts | TEST: name | DESC: desc | COVERAGE: 60
`;
    const [s] = parseTestSuggestions(text);
    expect(s!.estimatedLines).toBe(5);
  });
});

// ── parseVerificationOutput (extended) ───────────────────────────────────────

describe("parseVerificationOutput — test suggestions integration", () => {
  test("extracts both issues and test suggestions from combined output", () => {
    // STATUS: PASS with a WARNING issue — passed stays true since no ERROR severity
    const text = `
VERIFICATION_RESULT:
STATUS: PASS
ISSUES:
- [WARNING] src/foo.ts:10 — Unused variable
SUMMARY: 1 warning found

TEST_SUGGESTIONS:
- FILE: src/foo.ts | TEST: handles edge case | DESC: Branch not tested | COVERAGE: 75 | LINES: 7
`;
    const result = parseVerificationOutput(text, ["src/foo.ts"]);
    expect(result.passed).toBe(true); // STATUS: PASS and no ERROR-severity issues
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.severity).toBe("warning");
    expect(result.testSuggestions).toHaveLength(1);
    expect(result.testSuggestions![0]!.testName).toBe("handles edge case");
  });

  test("issues in TEST_SUGGESTIONS block do not pollute issues list", () => {
    // Regression: the issue parser must not match [WARNING] lines inside TEST_SUGGESTIONS
    const text = `
VERIFICATION_RESULT:
STATUS: PASS
ISSUES:
SUMMARY: clean

TEST_SUGGESTIONS:
- FILE: src/foo.ts | TEST: should handle [WARNING] case | DESC: test | COVERAGE: 80 | LINES: 4
`;
    const result = parseVerificationOutput(text, ["src/foo.ts"]);
    expect(result.issues).toHaveLength(0);
  });

  test("returns empty testSuggestions array when block absent", () => {
    const text = "VERIFICATION_RESULT:\nSTATUS: PASS\nSUMMARY: ok";
    const result = parseVerificationOutput(text, []);
    expect(result.testSuggestions).toEqual([]);
  });

  test("ERROR severity causes passed=false regardless of test suggestions", () => {
    const text = `
VERIFICATION_RESULT:
STATUS: FAIL
ISSUES:
- [ERROR] src/broken.ts:5 — Null dereference
SUMMARY: critical error

TEST_SUGGESTIONS:
- FILE: src/broken.ts | TEST: null guard | DESC: add null check | COVERAGE: 90 | LINES: 6
`;
    const result = parseVerificationOutput(text, ["src/broken.ts"]);
    expect(result.passed).toBe(false);
    expect(result.testSuggestions).toHaveLength(1);
  });
});

// ── testPathForSource ─────────────────────────────────────────────────────────

describe("testPathForSource", () => {
  test("maps src/agent/foo.ts to src/__tests__/foo.test.ts", () => {
    expect(testPathForSource("src/agent/foo.ts")).toBe("src/__tests__/foo.test.ts");
  });

  test("maps src/ui/theme.ts to src/__tests__/theme.test.ts", () => {
    expect(testPathForSource("src/ui/theme.ts")).toBe("src/__tests__/theme.test.ts");
  });

  test("strips leading ./", () => {
    expect(testPathForSource("./src/foo.ts")).toBe("src/__tests__/foo.test.ts");
  });

  test("strips .tsx extension", () => {
    expect(testPathForSource("src/ui/App.tsx")).toBe("src/__tests__/App.test.ts");
  });

  test("handles top-level src file", () => {
    expect(testPathForSource("src/repl.tsx")).toBe("src/__tests__/repl.test.ts");
  });
});

// ── generateTestStubs ─────────────────────────────────────────────────────────

describe("generateTestStubs", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes a stub file for a high-coverage suggestion", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ashlr-test-stubs-"));

    const suggestions: TestSuggestion[] = [
      {
        file: "src/agent/verification.ts",
        testName: "should handle empty files array",
        description: "Covers the early-return path when files is empty",
        coverage: 80,
        estimatedLines: 6,
      },
    ];

    const written = generateTestStubs(suggestions, tmpDir, 70);

    expect(written).toHaveLength(1);
    expect(written[0]).toBe("src/__tests__/verification.test.ts");

    const stubPath = join(tmpDir, "src/__tests__/verification.test.ts");
    expect(existsSync(stubPath)).toBe(true);

    const content = readFileSync(stubPath, "utf-8");
    expect(content).toContain("bun:test");
    expect(content).toContain("should handle empty files array");
    expect(content).toContain("80%");
  });

  test("skips suggestions below coverage threshold", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ashlr-test-stubs-"));

    const suggestions: TestSuggestion[] = [
      {
        file: "src/foo.ts",
        testName: "low coverage test",
        description: "Low coverage",
        coverage: 40, // below 70
        estimatedLines: 4,
      },
    ];

    const written = generateTestStubs(suggestions, tmpDir, 70);
    expect(written).toHaveLength(0);
  });

  test("groups multiple suggestions for the same source file into one test file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ashlr-test-stubs-"));

    const suggestions: TestSuggestion[] = [
      {
        file: "src/agent/loop.ts",
        testName: "handles abort signal",
        description: "Abort path",
        coverage: 75,
        estimatedLines: 5,
      },
      {
        file: "src/agent/loop.ts",
        testName: "handles max iterations",
        description: "Max iter path",
        coverage: 82,
        estimatedLines: 6,
      },
    ];

    const written = generateTestStubs(suggestions, tmpDir, 70);
    // Both map to src/__tests__/loop.test.ts — should write one file
    expect(written).toHaveLength(1);

    const content = readFileSync(join(tmpDir, written[0]!), "utf-8");
    expect(content).toContain("handles abort signal");
    expect(content).toContain("handles max iterations");
  });

  test("appends to existing test file without duplicating header imports", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ashlr-test-stubs-"));

    // Pre-create the test file with existing content
    const testFilePath = join(tmpDir, "src/__tests__/existing.test.ts");
    mkdirSync(join(tmpDir, "src/__tests__"), { recursive: true });
    writeFileSync(
      testFilePath,
      `import { describe, test, expect } from "bun:test";\n// existing content\n`,
      "utf-8",
    );

    const suggestions: TestSuggestion[] = [
      {
        file: "src/existing.ts",
        testName: "new auto-suggested test",
        description: "New coverage",
        coverage: 85,
        estimatedLines: 7,
      },
    ];

    const written = generateTestStubs(suggestions, tmpDir, 70);
    expect(written).toHaveLength(1);

    const content = readFileSync(testFilePath, "utf-8");
    // Should not duplicate the bun:test import header
    expect(content).toContain("existing content");
    expect(content).toContain("new auto-suggested test");
    // Header import should appear exactly once (from the pre-existing file)
    expect(content.split("bun:test").length - 1).toBe(1);
  });
});
