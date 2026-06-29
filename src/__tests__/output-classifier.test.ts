/**
 * Tests for OutputClassifier + SemanticsAwareChunker
 *
 * Covers:
 *   1.  classifyFromMeta()  — pre-execution classifier from tool name + input
 *   2.  classifyFromContent() — content-based refinement
 *   3.  OutputClassifier.refine() — auto-upgrade from meta hint to content class
 *   4.  findPausePoint() — per-type boundary detection
 *   5.  SemanticsAwareChunker — end-to-end chunking for each semantic type
 *   6.  createSemanticChunkCollector — factory helper
 *
 * ≥ 12 test cases required; this file has 16.
 */

import { describe, test, expect } from "bun:test";
import {
  classifyFromMeta,
  classifyFromContent,
  OutputClassifier,
  findPausePoint,
  SemanticsAwareChunker,
  createSemanticChunkCollector,
  type SemanticType,
} from "../agent/output-classifier.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGrepOutput(files: string[], matchesPerFile = 3): string {
  return files
    .flatMap((f) =>
      Array.from({ length: matchesPerFile }, (_, i) => `${f}:${i + 1}:  const x${i} = foo();`)
    )
    .join("\n") + "\n";
}

function makeJsonArray(count: number): string {
  const items = Array.from({ length: count }, (_, i) => ({ id: i, name: `item-${i}` }));
  return JSON.stringify(items, null, 2);
}

function makeJsonObject(keys: string[]): string {
  const obj = Object.fromEntries(keys.map((k) => [k, `value-${k}`]));
  return JSON.stringify(obj, null, 2);
}

function makeDiff(files: number, hunksPerFile = 1): string {
  return Array.from({ length: files }, (_, fi) =>
    [
      `diff --git a/src/file${fi}.ts b/src/file${fi}.ts`,
      `--- a/src/file${fi}.ts`,
      `+++ b/src/file${fi}.ts`,
      ...Array.from({ length: hunksPerFile }, (_, hi) => [
        `@@ -${hi * 10 + 1},3 +${hi * 10 + 1},4 @@`,
        ` context line`,
        `-removed line ${hi}`,
        `+added line ${hi}`,
        ` another context`,
      ]).flat(),
    ].join("\n")
  ).join("\n") + "\n";
}

function makeTestOutput(passed: number, failed: number): string {
  const lines: string[] = [];
  for (let i = 0; i < passed; i++) lines.push(`ok ${i + 1} - should pass test ${i}`);
  for (let i = 0; i < failed; i++) lines.push(`not ok ${passed + i + 1} - should fail test ${i}`);
  lines.push(`1..${passed + failed}`);
  lines.push(`# tests ${passed + failed}`);
  lines.push(`# pass  ${passed}`);
  lines.push(`# fail  ${failed}`);
  return lines.join("\n") + "\n";
}

function makeLogLines(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `2024-01-15 10:${String(i % 60).padStart(2, "0")}:00 [INFO] Processing item ${i}`
  ).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 1. classifyFromMeta — pre-execution classification
// ---------------------------------------------------------------------------

describe("classifyFromMeta", () => {
  test("1. grep tool name → grep_matches", () => {
    expect(classifyFromMeta("grep", {})).toBe("grep_matches");
    expect(classifyFromMeta("Grep", {})).toBe("grep_matches");
    expect(classifyFromMeta("ripgrep", {})).toBe("grep_matches");
  });

  test("2. bash + grep command → grep_matches", () => {
    expect(classifyFromMeta("bash", { command: "grep -r 'foo' src/" })).toBe("grep_matches");
    expect(classifyFromMeta("bash", { command: "rg 'pattern' ." })).toBe("grep_matches");
  });

  test("3. bash + git diff → diff_output", () => {
    expect(classifyFromMeta("bash", { command: "git diff HEAD~1" })).toBe("diff_output");
    expect(classifyFromMeta("bash", { command: "git show abc123" })).toBe("diff_output");
  });

  test("4. bash + test runner → test_output", () => {
    expect(classifyFromMeta("bash", { command: "bun test src/" })).toBe("test_output");
    expect(classifyFromMeta("bash", { command: "jest --coverage" })).toBe("test_output");
    expect(classifyFromMeta("bash", { command: "pytest tests/" })).toBe("test_output");
  });

  test("5. webfetch tool → json_struct", () => {
    expect(classifyFromMeta("webfetch", { url: "https://api.example.com/data" })).toBe("json_struct");
    expect(classifyFromMeta("fetch", {})).toBe("json_struct");
  });

  test("6. read tool with .json extension → json_struct", () => {
    expect(classifyFromMeta("read", { file_path: "/project/package.json" })).toBe("json_struct");
  });

  test("7. read tool with .diff extension → diff_output", () => {
    expect(classifyFromMeta("read", { path: "/tmp/changes.patch" })).toBe("diff_output");
  });

  test("8. diff tool name → diff_output", () => {
    expect(classifyFromMeta("diff", {})).toBe("diff_output");
  });

  test("9. bash + curl → json_struct", () => {
    expect(classifyFromMeta("bash", { command: "curl -s https://api.github.com/repos/foo/bar" })).toBe(
      "json_struct"
    );
  });

  test("10. bash + tail log → log_stream", () => {
    expect(classifyFromMeta("bash", { command: "tail -f /var/log/app.log" })).toBe("log_stream");
  });

  test("11. unknown tool → generic", () => {
    expect(classifyFromMeta("unknownTool", {})).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// 2. classifyFromContent — content-based classification
// ---------------------------------------------------------------------------

describe("classifyFromContent", () => {
  test("12. JSON array → json_struct", () => {
    expect(classifyFromContent(makeJsonArray(5))).toBe("json_struct");
  });

  test("13. JSON object → json_struct", () => {
    expect(classifyFromContent(makeJsonObject(["a", "b", "c"]))).toBe("json_struct");
  });

  test("14. Unified diff → diff_output", () => {
    expect(classifyFromContent(makeDiff(2))).toBe("diff_output");
  });

  test("15. TAP test output → test_output", () => {
    expect(classifyFromContent(makeTestOutput(8, 2))).toBe("test_output");
  });

  test("16. grep-style lines → grep_matches", () => {
    expect(classifyFromContent(makeGrepOutput(["src/a.ts", "src/b.ts"]))).toBe("grep_matches");
  });

  test("17. timestamped log lines → log_stream", () => {
    expect(classifyFromContent(makeLogLines(20))).toBe("log_stream");
  });

  test("18. empty string → generic", () => {
    expect(classifyFromContent("")).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// 3. OutputClassifier.refine — upgrades from meta hint
// ---------------------------------------------------------------------------

describe("OutputClassifier", () => {
  test("19. pre-refine uses meta hint", () => {
    const c = new OutputClassifier("bash", { command: "git diff" });
    expect(c.semanticType).toBe("diff_output");
    expect(c.isRefined).toBe(false);
  });

  test("20. refine upgrades to content-based classification", () => {
    // Start with generic meta hint, refine with JSON content
    const c = new OutputClassifier("unknownTool", {});
    expect(c.semanticType).toBe("generic");
    c.refine(makeJsonArray(10)); // enough content
    expect(c.isRefined).toBe(true);
    expect(c.semanticType).toBe("json_struct");
  });

  test("21. refine is no-op before REFINE_THRESHOLD", () => {
    const c = new OutputClassifier("unknownTool", {});
    c.refine("short text"); // < 128 chars
    expect(c.isRefined).toBe(false);
  });

  test("22. override() forces type regardless of content", () => {
    const c = new OutputClassifier("bash", { command: "ls -la" });
    c.override("diff_output");
    expect(c.semanticType).toBe("diff_output");
    expect(c.isRefined).toBe(true);
    // Further refine calls are no-ops
    c.refine(makeJsonArray(20));
    expect(c.semanticType).toBe("diff_output");
  });
});

// ---------------------------------------------------------------------------
// 4. findPausePoint — per-type boundary detection
// ---------------------------------------------------------------------------

describe("findPausePoint", () => {
  test("23. json_struct: pauses at closing brace/bracket", () => {
    const json = '{"key": "value", "num": 42}';
    const pp = findPausePoint(json, "json_struct", 8192);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("json_close");
    expect(pp!.end).toBe(json.length);
  });

  test("24. json_struct: no pause on partial JSON", () => {
    const partial = '{"key": "value", "arr": [1, 2, 3';
    const pp = findPausePoint(partial, "json_struct", 8192);
    expect(pp).toBeNull();
  });

  test("25. diff_output: pauses before second hunk header", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-removed",
      "+added",
      "@@ -10,3 +11,4 @@",
      " other context",
    ].join("\n") + "\n";
    const pp = findPausePoint(diff, "diff_output", 8192);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("diff_hunk");
    // The pause should be before the second @@ line
    const before = diff.slice(0, pp!.end);
    expect(before).not.toContain("@@ -10,3");
  });

  test("26. grep_matches: pauses at file-section boundary", () => {
    const grepOut = [
      "src/a.ts:1:  foo()",
      "src/a.ts:5:  bar()",
      "src/b.ts:3:  baz()",
      "src/b.ts:7:  qux()",
    ].join("\n") + "\n";
    const pp = findPausePoint(grepOut, "grep_matches", 8192);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("grep_file_section");
    const before = grepOut.slice(0, pp!.end);
    // Should only include src/a.ts lines
    expect(before).toContain("src/a.ts");
    expect(before).not.toContain("src/b.ts");
  });

  test("27. test_output: pauses after each TAP test line", () => {
    const tap = "ok 1 - first test\nnot ok 2 - second test\nok 3 - third test\n";
    const pp = findPausePoint(tap, "test_output", 8192);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("test_case");
    const firstChunk = tap.slice(0, pp!.end);
    expect(firstChunk.trim()).toBe("ok 1 - first test");
  });

  test("28. log_stream: pauses after each newline", () => {
    const logs = makeLogLines(5);
    const pp = findPausePoint(logs, "log_stream", 8192);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("line_break");
    const firstLine = logs.slice(0, pp!.end);
    expect(firstLine.split("\n").length).toBe(2); // content + empty after \n
  });

  test("29. generic: pauses at double newline (paragraph)", () => {
    const text = "paragraph one\nmore text\n\nparagraph two\n";
    const pp = findPausePoint(text, "generic", 8192);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("paragraph");
    expect(text.slice(0, pp!.end)).toContain("paragraph one");
    expect(text.slice(0, pp!.end)).not.toContain("paragraph two");
  });

  test("30. max_size forces flush and snaps to last newline", () => {
    const text = "line one\nline two\nline three more text here";
    const pp = findPausePoint(text, "generic", 20);
    expect(pp).not.toBeNull();
    expect(pp!.reason).toBe("max_size");
    // Should snap to last newline before position 20
    const chunk = text.slice(0, pp!.end);
    expect(chunk.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. SemanticsAwareChunker — end-to-end
// ---------------------------------------------------------------------------

describe("SemanticsAwareChunker", () => {
  test("31. JSON array: each top-level object is a chunk", () => {
    // Build two separate JSON objects (not in an array)
    const text = '{"a": 1}\n{"b": 2}\n{"c": 3}\n';
    const { chunker, chunks } = createSemanticChunkCollector("webfetch", {}, { minSize: 1 });
    chunker.push(text);
    chunker.finalize();
    // Each {"x": N} should be its own chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const reasons = chunks.map((c) => c.reason);
    expect(reasons).toContain("json_close");
  });

  test("32. grep output: chunks split at file sections", () => {
    const grepOut = makeGrepOutput(["src/alpha.ts", "src/beta.ts", "src/gamma.ts"], 4);
    const { chunker, chunks, classifier } = createSemanticChunkCollector(
      "grep",
      { pattern: "foo" },
      { minSize: 1 }
    );
    chunker.push(grepOut);
    chunker.finalize();
    expect(classifier.semanticType).toBe("grep_matches");
    // Should have at least one file-section boundary chunk
    const fileSectionChunks = chunks.filter((c) => c.reason === "grep_file_section");
    expect(fileSectionChunks.length).toBeGreaterThanOrEqual(1);
  });

  test("33. diff output: chunks split at hunks", () => {
    const diff = makeDiff(2, 2);
    const { chunker, chunks } = createSemanticChunkCollector("diff", {}, { minSize: 1 });
    chunker.push(diff);
    chunker.finalize();
    const hunkChunks = chunks.filter((c) => c.reason === "diff_hunk");
    expect(hunkChunks.length).toBeGreaterThanOrEqual(1);
  });

  test("34. test output: chunks include test-case lines", () => {
    const tap = makeTestOutput(5, 2);
    const { chunker, chunks } = createSemanticChunkCollector(
      "bash",
      { command: "bun test" },
      { minSize: 1 }
    );
    chunker.push(tap);
    chunker.finalize();
    const testCaseChunks = chunks.filter((c) => c.reason === "test_case");
    expect(testCaseChunks.length).toBeGreaterThanOrEqual(1);
  });

  test("35. log stream: each line is a separate chunk", () => {
    const logs = makeLogLines(5);
    const { chunker, chunks } = createSemanticChunkCollector(
      "bash",
      { command: "tail -f /var/log/app.log" },
      { minSize: 1 }
    );
    chunker.push(logs);
    chunker.finalize();
    // Should have at least 5 chunks (one per log line + finalize)
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    const lineBreakChunks = chunks.filter((c) => c.reason === "line_break");
    expect(lineBreakChunks.length).toBeGreaterThanOrEqual(4);
  });

  test("36. finalize emits remaining buffer", () => {
    const { chunker, chunks } = createSemanticChunkCollector("unknownTool", {}, { minSize: 1 });
    chunker.push("hello world no boundary here");
    expect(chunks.length).toBe(0); // not flushed yet
    chunker.finalize();
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.reason).toBe("finalize");
    expect(chunks[0]!.text).toBe("hello world no boundary here");
  });

  test("37. push after finalize throws", () => {
    const { chunker } = createSemanticChunkCollector("bash", {});
    chunker.finalize();
    expect(() => chunker.push("more text")).toThrow();
  });

  test("38. double finalize throws", () => {
    const { chunker } = createSemanticChunkCollector("bash", {});
    chunker.finalize();
    expect(() => chunker.finalize()).toThrow();
  });

  test("39. max_size forces flush even without semantic boundary", () => {
    const longText = "x".repeat(200);
    const { chunker, chunks } = createSemanticChunkCollector("unknownTool", {}, {
      maxSize: 50,
      minSize: 1,
    });
    chunker.push(longText);
    chunker.finalize();
    // Must have emitted at least one forced chunk
    const forced = chunks.filter((c) => c.forced);
    expect(forced.length).toBeGreaterThanOrEqual(1);
  });

  test("40. all original text is preserved across chunks", () => {
    const grepOut = makeGrepOutput(["a.ts", "b.ts", "c.ts"], 5);
    const { chunker, chunks } = createSemanticChunkCollector("grep", {}, { minSize: 1 });
    chunker.push(grepOut);
    chunker.finalize();
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(grepOut);
  });
});
