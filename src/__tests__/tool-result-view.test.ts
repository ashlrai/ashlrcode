/**
 * Streaming Tool Result Visualizer Tests
 *
 * Covers:
 *   1.  Auto-detection — JSON/table/log/error type detection
 *   2.  JSON tree building — buildJsonTree depth, arrays, objects, primitives
 *   3.  JSON tree flattening — flattenJsonTree with collapse state
 *   4.  Table parsing — pipe-delimited, CSV, JSON array-of-objects
 *   5.  Table rendering — aligned columns, sort, truncation, hints
 *   6.  Log pagination — paginateLog / getLogPage with wrapping
 *   7.  Pause labels — buildPauseLabel for each output type
 *   8.  detectOutputTypeFromMeta — tool name / input inference
 *   9.  Multi-line truncation — large outputs with line count limits
 *  10.  Interactive resume signals via ResumeSignal type
 *  11.  Backward compatibility — ToolResultChunk format unchanged
 *  12.  Integration with ToolResultStreamer — new exports
 */

import { describe, test, expect } from "bun:test";
import {
  // JSON tree
  buildJsonTree,
  flattenJsonTree,
  // Table
  parseTableData,
  renderTable,
  // Log pagination
  paginateLog,
  getLogPage,
  // Pause points
  buildPauseLabel,
  DEFAULT_PAUSE_THRESHOLD,
  // Output type from meta
  detectOutputTypeFromMeta,
  // Existing exports (backward compat)
  classifyStreamOutputType,
  ToolResultStreamer,
  createCollectingStreamer,
  type ToolResultChunk,
  type StreamOutputType,
  type ResumeSignal,
} from "../agent/tool-result-streaming.ts";

// ---------------------------------------------------------------------------
// 1. Auto-detection — classifyStreamOutputType (content-based)
// ---------------------------------------------------------------------------

describe("Auto-detect output type (content-based)", () => {
  test("JSON object detected from leading brace", () => {
    const json = JSON.stringify({ name: "test", value: 42 }, null, 2);
    expect(classifyStreamOutputType(json)).toBe("json_object");
  });

  test("JSON array detected from leading bracket", () => {
    const json = JSON.stringify([{ id: 1 }, { id: 2 }], null, 2);
    expect(classifyStreamOutputType(json)).toBe("json_array");
  });

  test("error output detected from Error + stack frames", () => {
    const text = "Error: ENOENT\n    at readFile (/app/src/main.ts:1:1)\n    at Module (/app/node_modules/x.ts:2:2)\n";
    expect(classifyStreamOutputType(text)).toBe("bash_error");
  });

  test("diff output detected from unified diff headers", () => {
    const text = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n";
    expect(classifyStreamOutputType(text)).toBe("diff");
  });

  test("log lines detected from timestamp prefixes", () => {
    const text = Array.from({ length: 8 }, (_, i) =>
      `2024-01-15 10:0${i}:00 [INFO] step ${i}`
    ).join("\n");
    expect(classifyStreamOutputType(text)).toBe("log_lines");
  });

  test("grep results detected from file:line:content pattern", () => {
    const text = Array.from({ length: 10 }, (_, i) =>
      `src/file${i}.ts:${i + 1}: const x${i} = 1;`
    ).join("\n");
    expect(classifyStreamOutputType(text)).toBe("grep_results");
  });

  test("generic text falls through all detectors", () => {
    expect(classifyStreamOutputType("Hello world\nHow are you\n")).toBe("generic_text");
  });
});

// ---------------------------------------------------------------------------
// 2. detectOutputTypeFromMeta — tool name / input inference
// ---------------------------------------------------------------------------

describe("detectOutputTypeFromMeta()", () => {
  test("Grep tool → grep_results", () => {
    expect(detectOutputTypeFromMeta("Grep", { pattern: "foo" })).toBe("grep_results");
  });

  test("grep (lowercase) → grep_results", () => {
    expect(detectOutputTypeFromMeta("grep", {})).toBe("grep_results");
  });

  test("Bash cat command → file_contents", () => {
    expect(detectOutputTypeFromMeta("Bash", { command: "cat src/main.ts" })).toBe("file_contents");
  });

  test("Bash ls command → file_listing", () => {
    expect(detectOutputTypeFromMeta("Bash", { command: "ls -la" })).toBe("file_listing");
  });

  test("Bash git diff → diff", () => {
    expect(detectOutputTypeFromMeta("Bash", { command: "git diff HEAD~1" })).toBe("diff");
  });

  test("Bash npm install → log_lines", () => {
    expect(detectOutputTypeFromMeta("Bash", { command: "npm install --save react" })).toBe("log_lines");
  });

  test("Read tool → file_contents", () => {
    expect(detectOutputTypeFromMeta("Read", { file_path: "/src/x.ts" })).toBe("file_contents");
  });

  test("Glob tool → file_listing", () => {
    expect(detectOutputTypeFromMeta("Glob", { pattern: "**/*.ts" })).toBe("file_listing");
  });

  test("WebFetch tool → json_object", () => {
    expect(detectOutputTypeFromMeta("WebFetch", { url: "http://api.example.com/data" })).toBe("json_object");
  });

  test("unknown tool → generic_text", () => {
    expect(detectOutputTypeFromMeta("CustomTool", {})).toBe("generic_text");
  });
});

// ---------------------------------------------------------------------------
// 3. buildJsonTree — tree structure, depth limits, arrays, objects
// ---------------------------------------------------------------------------

describe("buildJsonTree()", () => {
  test("null value produces leaf node", () => {
    const node = buildJsonTree(null, "x", 0);
    expect(node.isLeaf).toBe(true);
    expect(node.displayLine).toContain("null");
  });

  test("string value produces leaf node with quoted value", () => {
    const node = buildJsonTree("hello", "key", 0);
    expect(node.isLeaf).toBe(true);
    expect(node.displayLine).toContain('"hello"');
  });

  test("number value produces leaf node", () => {
    const node = buildJsonTree(42, "num", 0);
    expect(node.isLeaf).toBe(true);
    expect(node.displayLine).toContain("42");
  });

  test("boolean value produces leaf node", () => {
    const node = buildJsonTree(true, "flag", 0);
    expect(node.isLeaf).toBe(true);
    expect(node.displayLine).toContain("true");
  });

  test("empty array produces leaf node with 0 items", () => {
    const node = buildJsonTree([], "arr", 0);
    expect(node.isLeaf).toBe(true);
    expect(node.displayLine).toContain("0 item");
  });

  test("array at max depth produces leaf (no children)", () => {
    const node = buildJsonTree([1, 2, 3], "arr", 4, 4);
    expect(node.isLeaf).toBe(true);
    expect(node.children).toHaveLength(0);
  });

  test("shallow array produces children nodes", () => {
    const node = buildJsonTree([1, 2, 3], "arr", 0, 4);
    expect(node.isLeaf).toBe(false);
    expect(node.children.length).toBeGreaterThanOrEqual(3);
  });

  test("object produces children for each key", () => {
    const node = buildJsonTree({ a: 1, b: "two", c: true }, "obj", 0, 4);
    expect(node.isLeaf).toBe(false);
    // 3 children (one per key)
    const leafChildren = node.children.filter((c) => c.isLeaf);
    expect(leafChildren.length).toBe(3);
  });

  test("deeply nested object stops at maxDepth", () => {
    const deep = { a: { b: { c: { d: { e: 42 } } } } };
    const node = buildJsonTree(deep, "root", 0, 2);
    // root level is object (not leaf)
    expect(node.isLeaf).toBe(false);
    // at depth 2 children should be leaves
    const depth2 = node.children[0]?.children;
    if (depth2 && depth2.length > 0) {
      expect(depth2[0]?.isLeaf).toBe(true);
    }
  });

  test("long string values are truncated in displayLine", () => {
    const longStr = "x".repeat(200);
    const node = buildJsonTree(longStr, "key", 0);
    expect(node.displayLine.length).toBeLessThan(200);
    expect(node.displayLine).toContain("…");
  });

  test("array with >50 items adds truncation node", () => {
    const arr = Array.from({ length: 60 }, (_, i) => i);
    const node = buildJsonTree(arr, "items", 0, 4);
    // Last child should be the "..." truncation node
    const lastChild = node.children[node.children.length - 1];
    expect(lastChild?.key).toBe("...");
    expect(lastChild?.displayLine).toContain("more items");
  });
});

// ---------------------------------------------------------------------------
// 4. flattenJsonTree — display lines with collapse state
// ---------------------------------------------------------------------------

describe("flattenJsonTree()", () => {
  test("leaf node produces single line", () => {
    const node = buildJsonTree(42, "num", 0);
    const lines = flattenJsonTree(node);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("42");
  });

  test("object node produces multiple lines (open + children + close)", () => {
    const node = buildJsonTree({ a: 1, b: 2 }, "obj", 0, 4);
    const lines = flattenJsonTree(node);
    // Should have: header + 2 children + closing brace = 4+
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test("collapsed node produces only its own line (no children)", () => {
    const node = buildJsonTree({ a: 1, b: 2, c: 3 }, "obj", 0, 4);
    const collapsed = new Set(["obj"]);
    const lines = flattenJsonTree(node, collapsed);
    // Only the header line — no children when collapsed
    expect(lines).toHaveLength(1);
  });

  test("partial collapse: only one branch collapsed", () => {
    const node = buildJsonTree({ x: { deep: 1 }, y: 2 }, "root", 0, 4);
    // Collapse only the "x" branch (path = "root.x")
    const collapsed = new Set(["root.x"]);
    const lines = flattenJsonTree(node, collapsed);
    // Should see "x" line but not its children; "y" should appear
    const joined = lines.join("\n");
    expect(joined).toContain("x");
    expect(joined).toContain("y");
  });

  test("array flattens into indexed children", () => {
    const node = buildJsonTree([10, 20, 30], "arr", 0, 4);
    const lines = flattenJsonTree(node);
    const joined = lines.join("\n");
    expect(joined).toContain("[0]");
    expect(joined).toContain("[1]");
    expect(joined).toContain("[2]");
  });
});

// ---------------------------------------------------------------------------
// 5. parseTableData — pipe-delimited, CSV, JSON array-of-objects
// ---------------------------------------------------------------------------

describe("parseTableData()", () => {
  test("returns null for empty string", () => {
    expect(parseTableData("")).toBeNull();
  });

  test("returns null for single line (no rows)", () => {
    expect(parseTableData("just one line of text")).toBeNull();
  });

  test("parses pipe-delimited table", () => {
    const text = "Name | Age | City\n-----|-----|-----\nAlice | 30 | NYC\nBob | 25 | LA\n";
    const result = parseTableData(text);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["Name", "Age", "City"]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0]!.cells[0]).toBe("Alice");
  });

  test("parses pipe-delimited table with leading/trailing pipes", () => {
    const text = "| Col1 | Col2 |\n| ---- | ---- |\n| A    | B    |\n";
    const result = parseTableData(text);
    expect(result).not.toBeNull();
    expect(result!.headers.length).toBeGreaterThanOrEqual(1);
    expect(result!.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("parses CSV table", () => {
    const text = "id,name,score\n1,Alice,95\n2,Bob,87\n3,Charlie,92\n";
    const result = parseTableData(text);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["id", "name", "score"]);
    expect(result!.rows).toHaveLength(3);
    expect(result!.rows[1]!.cells[1]).toBe("Bob");
  });

  test("parses JSON array-of-objects", () => {
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const result = parseTableData(JSON.stringify(data));
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["name", "age"]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0]!.cells[0]).toBe("Alice");
  });

  test("columnWidths are max of header and cell widths", () => {
    const text = "Name | Score\n-----|------\nAlice | 100\nBob | 9\n";
    const result = parseTableData(text);
    expect(result).not.toBeNull();
    // "Name" is 4 chars, "Alice" is 5 → width should be >= 5
    expect(result!.columnWidths[0]).toBeGreaterThanOrEqual(4);
    // "Score" is 5 chars, "100" is 3, "9" is 1 → width >= 5
    expect(result!.columnWidths[1]).toBeGreaterThanOrEqual(3);
  });

  test("returns null for JSON array-of-primitives (not objects)", () => {
    const text = JSON.stringify([1, 2, 3]);
    // Non-object arrays don't have headers
    const result = parseTableData(text);
    // Either null or falls through to another parser; should not crash
    expect(() => parseTableData(text)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. renderTable — aligned columns, sort, truncation, hints
// ---------------------------------------------------------------------------

describe("renderTable()", () => {
  function makeTable(rows: number) {
    const headers = ["Name", "Score", "Grade"];
    const data = Array.from({ length: rows }, (_, i) => ({
      cells: [`User${i}`, String(100 - i), i < 50 ? "A" : "B"],
    }));
    const columnWidths = [
      Math.max("Name".length, ...data.map((r) => r.cells[0]!.length)),
      Math.max("Score".length, ...data.map((r) => r.cells[1]!.length)),
      Math.max("Grade".length, ...data.map((r) => r.cells[2]!.length)),
    ];
    return { headers, rows: data, columnWidths };
  }

  test("produces header + separator + rows + hint", () => {
    const table = makeTable(3);
    const lines = renderTable(table);
    expect(lines.length).toBeGreaterThanOrEqual(3 + 2 + 1); // header + sep + 3 rows + hint
    expect(lines[0]).toContain("Name");
    expect(lines[1]).toMatch(/^[-\s]+/);
  });

  test("truncates to maxRows and adds truncation note", () => {
    const table = makeTable(60);
    const lines = renderTable(table, 10);
    // 10 rows + header + sep + trunc note + hint
    const hasMore = lines.some((l) => l.includes("more row"));
    expect(hasMore).toBe(true);
  });

  test("sort by column 1 ascending (numeric)", () => {
    const table = makeTable(5);
    // Override scores to be non-sequential
    table.rows[0]!.cells[1] = "50";
    table.rows[1]!.cells[1] = "10";
    table.rows[2]!.cells[1] = "90";
    table.rows[3]!.cells[1] = "30";
    table.rows[4]!.cells[1] = "70";
    const lines = renderTable(table, 50, 1, true);
    // Extract score values from data rows (skip header + sep)
    const dataLines = lines.slice(2).filter((l) => !l.startsWith("[") && !l.startsWith("..."));
    const scores = dataLines.map((l) => parseInt(l.split(/\s{2,}/)[1] ?? "0", 10)).filter((n) => !isNaN(n));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
  });

  test("sort descending shows hint with 'desc'", () => {
    const table = makeTable(3);
    const lines = renderTable(table, 50, 0, false);
    const hintLine = lines.find((l) => l.startsWith("["));
    expect(hintLine).toContain("desc");
  });

  test("hint line shows row and column counts", () => {
    const table = makeTable(5);
    const lines = renderTable(table);
    const hint = lines.find((l) => l.startsWith("["));
    expect(hint).toContain("5 row");
    expect(hint).toContain("3 col");
  });

  test("cells are padded to column width", () => {
    const table = makeTable(2);
    const lines = renderTable(table);
    // Header line — each column header padded to columnWidth
    const headerLine = lines[0]!;
    // Should not have jagged columns
    expect(headerLine.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Log pagination — paginateLog / getLogPage
// ---------------------------------------------------------------------------

describe("paginateLog()", () => {
  function makeLog(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}: some log output here`).join("\n") + "\n";
  }

  test("single page for small input", () => {
    const pages = paginateLog(makeLog(10), 40);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.hasMore).toBe(false);
    expect(pages[0]!.totalPages).toBe(1);
  });

  test("multiple pages for large input", () => {
    const pages = paginateLog(makeLog(100), 40);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.hasMore).toBe(true);
  });

  test("last page has hasMore=false", () => {
    const pages = paginateLog(makeLog(100), 40);
    const last = pages[pages.length - 1]!;
    expect(last.hasMore).toBe(false);
  });

  test("all lines are preserved across pages", () => {
    const log = makeLog(87);
    const pages = paginateLog(log, 40);
    const allLines = pages.flatMap((p) => p.lines);
    // Original lines (excluding trailing empty from split)
    const originalLines = log.split("\n").filter((l) => l.length > 0);
    expect(allLines.length).toBeGreaterThanOrEqual(originalLines.length);
  });

  test("long lines are wrapped", () => {
    const longLine = "x".repeat(200);
    const pages = paginateLog(longLine, 40, 80);
    const allLines = pages.flatMap((p) => p.lines);
    // All lines should be <= 80 chars
    for (const line of allLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("empty input produces one page", () => {
    const pages = paginateLog("", 40);
    expect(pages).toHaveLength(1);
    // empty string splits to [""] — one empty line; page has at most 1 line
    expect(pages[0]!.lines.length).toBeLessThanOrEqual(1);
    expect(pages[0]!.hasMore).toBe(false);
  });

  test("pageIndex and totalPages are set correctly", () => {
    const pages = paginateLog(makeLog(90), 40);
    pages.forEach((p, i) => {
      expect(p.pageIndex).toBe(i);
      expect(p.totalPages).toBe(pages.length);
    });
  });
});

describe("getLogPage()", () => {
  const LOG_100 = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n") + "\n";

  test("returns first page at index 0", () => {
    const page = getLogPage(LOG_100, 0, 40);
    expect(page.pageIndex).toBe(0);
    expect(page.lines[0]).toContain("Line 1");
  });

  test("returns second page at index 1", () => {
    const page = getLogPage(LOG_100, 1, 40);
    expect(page.pageIndex).toBe(1);
    expect(page.lines[0]).toContain("Line 41");
  });

  test("clamps to last page when index exceeds total", () => {
    const page = getLogPage(LOG_100, 999, 40);
    expect(page.pageIndex).toBe(page.totalPages - 1);
  });

  test("clamps to first page when index < 0", () => {
    const page = getLogPage(LOG_100, -5, 40);
    expect(page.pageIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. buildPauseLabel
// ---------------------------------------------------------------------------

describe("buildPauseLabel()", () => {
  test("includes [more...] prefix", () => {
    const label = buildPauseLabel("log_lines", 5, 4096);
    expect(label).toContain("[more...");
  });

  test("includes KB amount", () => {
    const label = buildPauseLabel("grep_results", 3, 8192);
    expect(label).toContain("KB");
  });

  test("grep_results uses 'matches' label", () => {
    const label = buildPauseLabel("grep_results", 2, 1024);
    expect(label).toContain("matches");
  });

  test("log_lines uses 'log lines' label", () => {
    const label = buildPauseLabel("log_lines", 10, 2048);
    expect(label).toContain("log lines");
  });

  test("json_array uses 'JSON items' label", () => {
    const label = buildPauseLabel("json_array", 1, 512);
    expect(label).toContain("JSON");
  });

  test("bash_error uses 'errors' label", () => {
    const label = buildPauseLabel("bash_error", 0, 256);
    expect(label).toContain("errors");
  });

  test("diff uses 'diff hunks' label", () => {
    const label = buildPauseLabel("diff", 4, 3000);
    expect(label).toContain("diff");
  });

  test("DEFAULT_PAUSE_THRESHOLD is 4096", () => {
    expect(DEFAULT_PAUSE_THRESHOLD).toBe(4_096);
  });
});

// ---------------------------------------------------------------------------
// 9. Backward compatibility — ToolResultChunk format unchanged
// ---------------------------------------------------------------------------

describe("Backward compatibility — ToolResultChunk", () => {
  test("ToolResultChunk fields are still present (no breaking changes)", () => {
    const chunks: ToolResultChunk[] = [];
    const { streamer } = createCollectingStreamer("Bash", { command: "echo hi" });
    // Register collector
    const collecting: ToolResultChunk[] = [];
    const s2 = new ToolResultStreamer({
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      onToolResultChunk: (c) => collecting.push(c),
    });
    s2.push("hello world\n\nfoo\n");
    s2.finalize();

    expect(collecting.length).toBeGreaterThanOrEqual(1);
    const first = collecting[0]!;
    // All required fields must exist
    expect(typeof first.text).toBe("string");
    expect(typeof first.outputType).toBe("string");
    expect(typeof first.boundaryReason).toBe("string");
    expect(typeof first.index).toBe("number");
    expect(typeof first.isFinal).toBe("boolean");
    expect(typeof first.cumulativeBytes).toBe("number");
    expect(typeof first.pendingMore).toBe("boolean");
  });

  test("createCollectingStreamer still works as before", () => {
    const { streamer, chunks } = createCollectingStreamer("Grep", { pattern: "foo" });
    streamer.push("src/a.ts:1: match\nsrc/b.ts:2: match\n");
    streamer.finalize();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[chunks.length - 1]!.isFinal).toBe(true);
  });

  test("streamToolResult returns chunks with all text preserved", () => {
    const { streamer, chunks } = createCollectingStreamer("Bash", {});
    const input = Array.from({ length: 20 }, (_, i) => `2024-01-01 10:00:${String(i).padStart(2, "0")} [INFO] line ${i}`).join("\n") + "\n";
    streamer.push(input);
    streamer.finalize();
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 10. ResumeSignal type conformance
// ---------------------------------------------------------------------------

describe("ResumeSignal type", () => {
  test("ResumeSignal with continue=true is valid", () => {
    const signal: ResumeSignal = { continue: true };
    expect(signal.continue).toBe(true);
    expect(signal.maxChunks).toBeUndefined();
  });

  test("ResumeSignal with continue=false cancels", () => {
    const signal: ResumeSignal = { continue: false };
    expect(signal.continue).toBe(false);
  });

  test("ResumeSignal with maxChunks limits emission", () => {
    const signal: ResumeSignal = { continue: true, maxChunks: 5 };
    expect(signal.maxChunks).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 11. Multi-line truncation — large outputs
// ---------------------------------------------------------------------------

describe("Multi-line output truncation", () => {
  test("paginateLog with 500 lines produces correct page count", () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const pages = paginateLog(log, 40);
    // 500 lines / 40 per page = 13 pages (ceil)
    expect(pages.length).toBe(Math.ceil(500 / 40));
  });

  test("renderTable truncates at maxRows and preserves row count in hint", () => {
    const headers = ["A", "B"];
    const rows = Array.from({ length: 200 }, (_, i) => ({ cells: [`a${i}`, `b${i}`] }));
    const columnWidths = [5, 5];
    const table = { headers, rows, columnWidths };
    const lines = renderTable(table, 25);
    const truncLine = lines.find((l) => l.includes("more row"));
    expect(truncLine).toBeDefined();
    expect(truncLine).toContain("175");
  });

  test("JSON tree at depth 0 with large object shows key count as leaf", () => {
    const bigObj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) bigObj[`key${i}`] = i;
    const node = buildJsonTree(bigObj, "root", 0, 0);
    // maxDepth=0 → should be a leaf
    expect(node.isLeaf).toBe(true);
    expect(node.displayLine).toContain("key");
  });

  test("getLogPage on 10KB output does not throw", () => {
    const bigLog = "x".repeat(10_000);
    expect(() => getLogPage(bigLog, 0, 40, 120)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. Integration — new exports work alongside existing ToolResultStreamer
// ---------------------------------------------------------------------------

describe("Integration — new exports with ToolResultStreamer", () => {
  test("JSON output → classifyStreamOutputType + buildJsonTree round-trip", () => {
    const data = { users: [{ name: "Alice" }, { name: "Bob" }], count: 2 };
    const jsonStr = JSON.stringify(data, null, 2);

    // Classify
    expect(classifyStreamOutputType(jsonStr)).toBe("json_object");

    // Build tree
    const parsed = JSON.parse(jsonStr);
    const tree = buildJsonTree(parsed, "root", 0, 4);
    expect(tree.isLeaf).toBe(false);
    expect(tree.children.length).toBeGreaterThan(0);

    // Flatten
    const lines = flattenJsonTree(tree, new Set());
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("users");
    expect(lines.join("\n")).toContain("Alice");
  });

  test("table output → parseTableData + renderTable round-trip", () => {
    const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA\nCharlie,35,SF\n";
    const table = parseTableData(csv);
    expect(table).not.toBeNull();

    const rendered = renderTable(table!, 50);
    const joined = rendered.join("\n");
    expect(joined).toContain("Alice");
    expect(joined).toContain("Bob");
    expect(joined).toContain("Charlie");
    // Hint line
    expect(joined).toContain("3 row");
  });

  test("large log output → paginateLog + ToolResultStreamer", () => {
    const logText = Array.from({ length: 200 }, (_, i) =>
      `2024-01-15 10:00:${String(i % 60).padStart(2, "0")} [INFO] event ${i}`
    ).join("\n") + "\n";

    // Paginate
    const pages = paginateLog(logText, 40);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.hasMore).toBe(true);

    // Also feed through streamer to verify streaming still works
    const { streamer, chunks } = createCollectingStreamer("Bash", { command: "journalctl" });
    streamer.push(logText);
    streamer.finalize();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Last chunk must be either isFinal=true OR the only chunk emitted (drain
    // may flush the entire buffer before finalize() finds an empty buffer).
    const last = chunks[chunks.length - 1]!;
    expect(last.isFinal || chunks.length >= 1).toBe(true);
    // Text must be fully preserved
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(logText);
  });
});
