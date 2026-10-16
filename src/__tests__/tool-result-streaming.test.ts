/**
 * Tests for Tool Result Streaming with Semantic Pause-Points
 *
 * Covers:
 *   1.  classifyStreamOutputType() — fine-grained content-based classification
 *   2.  outputPatternToStreamType() — predictor → stream type mapping
 *   3.  computeChunkBoundary() — natural boundary detection per type
 *   4.  AdaptiveChunkSizer — drain-speed adaptation
 *   5.  generateChunkSummary() — compact summaries per output type
 *   6.  ToolResultStreamer — full end-to-end chunking
 *   7.  createCollectingStreamer / streamToolResult helpers
 *   8.  tool-executor onToolResultChunk callback integration
 *   9.  message-renderer formatToolResultChunk / formatChunkSeparator
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  classifyStreamOutputType,
  outputPatternToStreamType,
  computeChunkBoundary,
  AdaptiveChunkSizer,
  generateChunkSummary,
  ToolResultStreamer,
  createCollectingStreamer,
  streamToolResult,
  type ToolResultChunk,
  type StreamOutputType,
} from "../agent/tool-result-streaming.ts";
import {
  executeToolCalls,
} from "../agent/tool-executor.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";
import {
  formatChunkSeparator,
  formatToolResultChunk,
} from "../ui/message-renderer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: ToolContext = { cwd: "/tmp", requestPermission: async () => true };

let _seq = 0;
function makeTool(result: string, name?: string): Tool {
  const n = name ?? `StreamTool_${Date.now()}_${++_seq}`;
  return {
    name: n,
    prompt: () => `Tool ${n}`,
    inputSchema: () => ({ type: "object" as const, properties: {} }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    validateInput: () => null,
    call: async () => result,
  };
}

function makeCall(tool: Tool): ToolCall {
  return { id: `call_${tool.name}`, name: tool.name, input: {} };
}

function makeGrepResult(matches: number): string {
  return Array.from({ length: matches }, (_, i) =>
    `src/file${i % 5}.ts:${i + 1}:  const value${i} = foo();`
  ).join("\n") + "\n";
}

function makeLogLines(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `2024-01-15 10:${String(i % 60).padStart(2, "0")}:00 [INFO] Processing item ${i}`
  ).join("\n") + "\n";
}

function makeJsonArray(count: number): string {
  const items = Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    value: `${"x".repeat(20)}`,
  }));
  return JSON.stringify(items, null, 2);
}

function makeJsonObject(keys: number): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < keys; i++) obj[`key${i}`] = `value${i}`;
  return JSON.stringify(obj, null, 2);
}

function makeGitDiff(files: number, linesPerHunk: number): string {
  const parts: string[] = [];
  for (let f = 0; f < files; f++) {
    parts.push(`diff --git a/src/file${f}.ts b/src/file${f}.ts`);
    parts.push(`--- a/src/file${f}.ts`);
    parts.push(`+++ b/src/file${f}.ts`);
    parts.push(`@@ -1,${linesPerHunk} +1,${linesPerHunk} @@`);
    for (let l = 0; l < linesPerHunk; l++) {
      parts.push(`-old line ${l}`);
      parts.push(`+new line ${l}`);
    }
  }
  return parts.join("\n") + "\n";
}

function makeStderr(msg: string, frames: number): string {
  return [
    `Error: ${msg}`,
    ...Array.from({ length: frames }, (_, i) => `    at fn${i} (/app/src/mod${i}.ts:${i + 1}:10)`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 1. classifyStreamOutputType()
// ---------------------------------------------------------------------------

describe("classifyStreamOutputType()", () => {
  test("bash_error — error keyword + stack frames", () => {
    const text = makeStderr("ENOENT: no such file", 3);
    expect(classifyStreamOutputType(text)).toBe("bash_error");
  });

  test("bash_error — just error keyword (no frames) if high density", () => {
    const text = "Error: timeout\nError: retry\nError: abort\nError: fail\n";
    expect(classifyStreamOutputType(text)).toBe("bash_error");
  });

  test("diff — unified diff headers", () => {
    expect(classifyStreamOutputType(makeGitDiff(2, 5))).toBe("diff");
  });

  test("diff — @@ hunk header only", () => {
    const text = "@@ -1,5 +1,5 @@ function foo() {\n-old\n+new\n";
    expect(classifyStreamOutputType(text)).toBe("diff");
  });

  test("json_array — starts with [", () => {
    expect(classifyStreamOutputType(makeJsonArray(5))).toBe("json_array");
  });

  test("json_object — starts with {", () => {
    expect(classifyStreamOutputType(makeJsonObject(3))).toBe("json_object");
  });

  test("log_lines — timestamp prefixed majority", () => {
    expect(classifyStreamOutputType(makeLogLines(10))).toBe("log_lines");
  });

  test("grep_results — file:line:content majority", () => {
    expect(classifyStreamOutputType(makeGrepResult(20))).toBe("grep_results");
  });

  test("file_listing — absolute path majority", () => {
    const text = Array.from({ length: 10 }, (_, i) => `/usr/src/file${i}.ts`).join("\n") + "\n";
    expect(classifyStreamOutputType(text)).toBe("file_listing");
  });

  test("file_contents — numbered lines (NNN\\t format)", () => {
    const text = Array.from({ length: 10 }, (_, i) => `${i + 1}\tconst x${i} = ${i};`).join("\n");
    expect(classifyStreamOutputType(text)).toBe("file_contents");
  });

  test("generic_text — fallback", () => {
    expect(classifyStreamOutputType("Hello world\nHow are you\n")).toBe("generic_text");
  });

  test("empty string → generic_text", () => {
    expect(classifyStreamOutputType("")).toBe("generic_text");
  });
});

// ---------------------------------------------------------------------------
// 2. outputPatternToStreamType()
// ---------------------------------------------------------------------------

describe("outputPatternToStreamType()", () => {
  test("grep_results → grep_results", () => {
    expect(outputPatternToStreamType("grep_results")).toBe("grep_results");
  });
  test("file_listing → file_listing", () => {
    expect(outputPatternToStreamType("file_listing")).toBe("file_listing");
  });
  test("code_dump → file_contents", () => {
    expect(outputPatternToStreamType("code_dump")).toBe("file_contents");
  });
  test("stack_trace → bash_error", () => {
    expect(outputPatternToStreamType("stack_trace")).toBe("bash_error");
  });
  test("config_file → json_object", () => {
    expect(outputPatternToStreamType("config_file")).toBe("json_object");
  });
  test("git_log → diff", () => {
    expect(outputPatternToStreamType("git_log")).toBe("diff");
  });
  test("test_output → log_lines", () => {
    expect(outputPatternToStreamType("test_output")).toBe("log_lines");
  });
  test("write_confirm → generic_text", () => {
    expect(outputPatternToStreamType("write_confirm")).toBe("generic_text");
  });
});

// ---------------------------------------------------------------------------
// 3. computeChunkBoundary()
// ---------------------------------------------------------------------------

describe("computeChunkBoundary()", () => {
  const BIG = 100_000; // large max so we don't hit it in most tests

  test("log_lines: boundary at first newline", () => {
    const buf = "line1\nline2\nline3\n";
    const b = computeChunkBoundary(buf, "log_lines", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("line_break");
    expect(buf.slice(0, b!.end)).toBe("line1\n");
  });

  test("grep_results: boundary at first newline", () => {
    const buf = "src/a.ts:1: match\nsrc/b.ts:2: match\n";
    const b = computeChunkBoundary(buf, "grep_results", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("line_break");
  });

  test("json_array: boundary at balanced brackets", () => {
    const json = '[{"a":1},{"b":2}]';
    const b = computeChunkBoundary(json, "json_array", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("block_break");
    expect(b!.end).toBe(json.length);
  });

  test("json_object: boundary at balanced braces", () => {
    const json = '{"key":"value","n":42}';
    const b = computeChunkBoundary(json, "json_object", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("block_break");
    expect(b!.end).toBe(json.length);
  });

  test("json_array: returns null for incomplete JSON", () => {
    const buf = '[{"a":1},{"b":';
    const b = computeChunkBoundary(buf, "json_array", BIG);
    expect(b).toBeNull();
  });

  test("generic_text: boundary at double newline (paragraph)", () => {
    const buf = "Para one.\n\nPara two.\n";
    const b = computeChunkBoundary(buf, "generic_text", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("paragraph");
    expect(buf.slice(0, b!.end)).toBe("Para one.\n\n");
  });

  test("generic_text: returns null when no double newline", () => {
    const buf = "Single line without double newline";
    const b = computeChunkBoundary(buf, "generic_text", BIG);
    expect(b).toBeNull();
  });

  test("max_size forces flush regardless of boundaries", () => {
    const buf = "no-boundary-here-at-all-just-text-content";
    const b = computeChunkBoundary(buf, "generic_text", 10);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("max_size");
    expect(b!.end).toBeLessThanOrEqual(buf.length);
  });

  test("diff: boundary fires at @@ hunk header", () => {
    const buf = "@@ -1,5 +1,5 @@ function foo() {\n-old\n+new\n";
    const b = computeChunkBoundary(buf, "diff", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("block_break");
  });

  test("code_block: boundary at closing fence", () => {
    const buf = "```ts\nconst x = 1;\nconst y = 2;\n```\n";
    const b = computeChunkBoundary(buf, "code_block", BIG);
    expect(b).not.toBeNull();
    expect(b!.reason).toBe("block_break");
  });
});

// ---------------------------------------------------------------------------
// 4. AdaptiveChunkSizer
// ---------------------------------------------------------------------------

describe("AdaptiveChunkSizer", () => {
  test("starts at DEFAULT_CHUNK_SIZE", () => {
    const s = new AdaptiveChunkSizer();
    expect(s.currentSize).toBe(AdaptiveChunkSizer.DEFAULT_CHUNK_SIZE);
  });

  test("accepts custom initial size", () => {
    const s = new AdaptiveChunkSizer(2048);
    expect(s.currentSize).toBe(2048);
  });

  test("clamps to MIN/MAX bounds", () => {
    const low = new AdaptiveChunkSizer(1);
    expect(low.currentSize).toBe(AdaptiveChunkSizer.MIN_CHUNK_SIZE);

    const high = new AdaptiveChunkSizer(999_999);
    expect(high.currentSize).toBe(AdaptiveChunkSizer.MAX_CHUNK_SIZE);
  });

  test("size adapts upward for fast drain", () => {
    const s = new AdaptiveChunkSizer(256);
    // Simulate very fast drain: 10 KB drained in 1ms each (10 MB/s)
    for (let i = 0; i < 10; i++) {
      s.recordDrain(10_000, 1);
    }
    // Should have grown toward max
    expect(s.currentSize).toBeGreaterThan(256);
  });

  test("size adapts downward for slow drain", () => {
    const s = new AdaptiveChunkSizer(8192);
    // Simulate slow drain: 10 bytes in 500ms
    for (let i = 0; i < 10; i++) {
      s.recordDrain(10, 500);
    }
    // Should have shrunk
    expect(s.currentSize).toBeLessThan(8192);
  });

  test("onChunkEmit increments chunksSent", () => {
    const s = new AdaptiveChunkSizer();
    s.onChunkEmit(512);
    s.onChunkEmit(512);
    expect(s.chunksSent).toBe(2);
  });

  test("reset() restores defaults", () => {
    const s = new AdaptiveChunkSizer(512);
    s.recordDrain(50_000, 1);
    s.reset();
    expect(s.currentSize).toBe(AdaptiveChunkSizer.DEFAULT_CHUNK_SIZE);
    expect(s.chunksSent).toBe(0);
  });

  test("recordDrain ignores zero values", () => {
    const s = new AdaptiveChunkSizer();
    const before = s.currentSize;
    s.recordDrain(0, 100);
    s.recordDrain(100, 0);
    expect(s.currentSize).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5. generateChunkSummary()
// ---------------------------------------------------------------------------

describe("generateChunkSummary()", () => {
  function makeChunk(text: string, outputType: StreamOutputType): ToolResultChunk {
    return {
      text,
      outputType,
      boundaryReason: "block_break",
      index: 0,
      isFinal: false,
      cumulativeBytes: new TextEncoder().encode(text).length,
      pendingMore: false,
    };
  }

  test("returns undefined for chunks below threshold", () => {
    const chunk = makeChunk("small", "generic_text");
    expect(generateChunkSummary(chunk, 512)).toBeUndefined();
  });

  test("grep_results summary reports match count and file count", () => {
    const text = makeGrepResult(30);
    if (text.length < 512) return; // skip if too small
    const chunk = makeChunk(text, "grep_results");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/grep:/);
    expect(summary).toMatch(/match/);
    expect(summary).toMatch(/file/);
  });

  test("file_listing summary reports path count", () => {
    const text = Array.from({ length: 30 }, (_, i) => `/usr/src/file${i}.ts`).join("\n") + "\n";
    const chunk = makeChunk(text, "file_listing");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/listing:/);
  });

  test("json_array summary reports item count", () => {
    const text = makeJsonArray(25);
    const chunk = makeChunk(text, "json_array");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/json array:/);
    expect(summary).toMatch(/25 item/);
  });

  test("json_object summary reports key count", () => {
    const text = makeJsonObject(6);
    const chunk = makeChunk(text, "json_object");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/json object:/);
    expect(summary).toMatch(/6 key/);
  });

  test("diff summary reports added/removed lines", () => {
    const text = makeGitDiff(2, 10);
    const chunk = makeChunk(text, "diff");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/diff/i);
    expect(summary).toMatch(/\+/);
    expect(summary).toMatch(/-/);
  });

  test("bash_error summary includes error message", () => {
    const text = makeStderr("Cannot find module 'foo'", 4);
    const chunk = makeChunk(text, "bash_error");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/error:/i);
    expect(summary).toMatch(/Cannot find module/);
  });

  test("log_lines summary reports line count", () => {
    const text = makeLogLines(20);
    const chunk = makeChunk(text, "log_lines");
    const summary = generateChunkSummary(chunk, 64);
    expect(summary).toMatch(/log:/);
    expect(summary).toMatch(/line/);
  });
});

// ---------------------------------------------------------------------------
// 6. ToolResultStreamer — end-to-end
// ---------------------------------------------------------------------------

describe("ToolResultStreamer", () => {
  test("emits at least one chunk for non-empty input", () => {
    const { streamer, chunks } = createCollectingStreamer("Bash", { command: "echo hi" });
    streamer.push("Hello world\n\nSecond paragraph\n");
    streamer.finalize();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("final chunk has isFinal=true", () => {
    const { streamer, chunks } = createCollectingStreamer("Bash", {});
    streamer.push("Some output\n");
    streamer.finalize();
    const last = chunks[chunks.length - 1]!;
    expect(last.isFinal).toBe(true);
  });

  test("chunk indices are monotonically increasing from 0", () => {
    const { streamer, chunks } = createCollectingStreamer("Grep", { pattern: "foo" });
    streamer.push(makeGrepResult(10));
    streamer.finalize();
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });

  test("cumulativeBytes grows monotonically", () => {
    const { streamer, chunks } = createCollectingStreamer("Grep", { pattern: "foo" });
    streamer.push(makeGrepResult(15));
    streamer.finalize();
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.cumulativeBytes).toBeGreaterThan(chunks[i - 1]!.cumulativeBytes);
    }
  });

  test("all text is preserved across all chunks", () => {
    const input = makeGrepResult(20);
    const { streamer, chunks } = createCollectingStreamer("Grep", { pattern: "test" });
    streamer.push(input);
    streamer.finalize();
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(input);
  });

  test("detects grep_results outputType", () => {
    const { streamer, chunks } = createCollectingStreamer("Grep", { pattern: "x" });
    streamer.push(makeGrepResult(20));
    streamer.finalize();
    // At least one chunk should be grep_results after content classification
    const hasGrep = chunks.some((c) => c.outputType === "grep_results");
    expect(hasGrep).toBe(true);
  });

  test("detects json_array outputType", () => {
    const { streamer, chunks } = createCollectingStreamer("WebFetch", { url: "http://x" });
    streamer.push(makeJsonArray(10));
    streamer.finalize();
    const hasJson = chunks.some((c) => c.outputType === "json_array");
    expect(hasJson).toBe(true);
  });

  test("detects bash_error outputType", () => {
    const { streamer, chunks } = createCollectingStreamer("Bash", { command: "ls /nope" });
    streamer.push(makeStderr("ENOENT: file not found", 3));
    streamer.finalize();
    const hasError = chunks.some((c) => c.outputType === "bash_error");
    expect(hasError).toBe(true);
  });

  test("pendingMore is false on the final chunk", () => {
    const { streamer, chunks } = createCollectingStreamer("Bash", {});
    streamer.push("Hello\n\nWorld\n");
    streamer.finalize();
    expect(chunks[chunks.length - 1]!.pendingMore).toBe(false);
  });

  test("push() after finalize() throws", () => {
    const { streamer } = createCollectingStreamer("Bash", {});
    streamer.finalize();
    expect(() => streamer.push("more")).toThrow();
  });

  test("finalize() twice throws", () => {
    const { streamer } = createCollectingStreamer("Bash", {});
    streamer.finalize();
    expect(() => streamer.finalize()).toThrow();
  });

  test("empty push produces no chunks", () => {
    const { streamer, chunks } = createCollectingStreamer("Bash", {});
    streamer.push("");
    streamer.finalize();
    expect(chunks).toHaveLength(0);
  });

  test("large JSON array — all text preserved and final chunk is isFinal", () => {
    const json = makeJsonArray(50);
    const { streamer, chunks } = createCollectingStreamer("API", {}, {
      initialChunkSize: 512,
    });
    streamer.push(json);
    streamer.finalize();
    // All text must be preserved
    expect(chunks.map((c) => c.text).join("")).toBe(json);
    // Final chunk must be marked isFinal
    expect(chunks[chunks.length - 1]!.isFinal).toBe(true);
    // When the array is large enough for content classification, json_array type detected
    const hasJsonType = chunks.some((c) => c.outputType === "json_array");
    expect(hasJsonType).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. createCollectingStreamer / streamToolResult
// ---------------------------------------------------------------------------

describe("createCollectingStreamer()", () => {
  test("returns streamer and empty chunks array", () => {
    const { streamer, chunks } = createCollectingStreamer("Read", { file_path: "a.ts" });
    expect(chunks).toHaveLength(0);
    expect(streamer).toBeInstanceOf(ToolResultStreamer);
  });
});

describe("streamToolResult()", () => {
  test("returns all chunks and calls onChunk for each", () => {
    const received: ToolResultChunk[] = [];
    const returned = streamToolResult(
      "Grep",
      { pattern: "foo" },
      makeGrepResult(5),
      (c) => received.push(c)
    );
    expect(returned.length).toBe(received.length);
    expect(received.every((c, i) => c === returned[i])).toBe(true);
  });

  test("last chunk has isFinal=true", () => {
    const chunks = streamToolResult("Bash", {}, "output\n\nmore\n", () => {});
    expect(chunks[chunks.length - 1]!.isFinal).toBe(true);
  });

  test("all text is preserved", () => {
    const input = makeLogLines(5);
    const chunks = streamToolResult("Bash", { command: "journalctl" }, input, () => {});
    expect(chunks.map((c) => c.text).join("")).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 8. tool-executor onToolResultChunk integration
// ---------------------------------------------------------------------------

describe("executeToolCalls: onToolResultChunk integration", () => {
  test("onToolResultChunk fires for non-error results", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool(makeGrepResult(10));
    registry.register(tool);

    const chunks: Array<{ name: string; chunk: ToolResultChunk }> = [];
    await executeToolCalls(
      [makeCall(tool)],
      registry,
      ctx,
      {
        onToolResultChunk: (name, chunk) => chunks.push({ name, chunk }),
      }
    );

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.name).toBe(tool.name);
  });

  test("onToolResultChunk receives the correct tool name", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("Hello world\n\nSecond para\n");
    registry.register(tool);

    const names = new Set<string>();
    await executeToolCalls(
      [makeCall(tool)],
      registry,
      ctx,
      { onToolResultChunk: (name) => names.add(name) }
    );

    expect(names.has(tool.name)).toBe(true);
  });

  test("onToolResultChunk not called for error results (tool not registered)", async () => {
    const registry = new ToolRegistry();
    const chunks: ToolResultChunk[] = [];
    await executeToolCalls(
      [{ id: "c1", name: `NoTool_${Date.now()}`, input: {} }],
      registry,
      ctx,
      { onToolResultChunk: (_name, chunk) => chunks.push(chunk) }
    );
    expect(chunks).toHaveLength(0);
  });

  test("last chunk emitted by onToolResultChunk has isFinal=true", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool(makeLogLines(5));
    registry.register(tool);

    const chunks: ToolResultChunk[] = [];
    await executeToolCalls(
      [makeCall(tool)],
      registry,
      ctx,
      { onToolResultChunk: (_name, chunk) => chunks.push(chunk) }
    );

    expect(chunks[chunks.length - 1]!.isFinal).toBe(true);
  });

  test("onToolResultChunk can coexist with onCheckpoint and onResult", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool(makeGrepResult(5));
    registry.register(tool);

    let resultCalled = false;
    const streamChunks: ToolResultChunk[] = [];

    await executeToolCalls(
      [makeCall(tool)],
      registry,
      ctx,
      {
        onResult: () => { resultCalled = true; },
        onCheckpoint: () => {},
        onToolResultChunk: (_name, chunk) => streamChunks.push(chunk),
      }
    );

    expect(resultCalled).toBe(true);
    expect(streamChunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 9. message-renderer formatToolResultChunk / formatChunkSeparator
// ---------------------------------------------------------------------------

describe("formatChunkSeparator()", () => {
  function makeChunk(overrides: Partial<ToolResultChunk> = {}): ToolResultChunk {
    return {
      text: "hello",
      outputType: "generic_text",
      boundaryReason: "line_break",
      index: 1,
      isFinal: false,
      cumulativeBytes: 100,
      pendingMore: false,
      ...overrides,
    };
  }

  test("shows summary when provided", () => {
    const chunk = makeChunk({ summary: "[grep: 5 matches]" });
    const sep = formatChunkSeparator(chunk);
    expect(sep).toContain("[grep: 5 matches]");
  });

  test("shows loading indicator when pendingMore=true", () => {
    const chunk = makeChunk({ pendingMore: true });
    const sep = formatChunkSeparator(chunk);
    expect(sep).toContain("loading");
  });

  test("returns empty string when no summary and not pending", () => {
    const chunk = makeChunk({ pendingMore: false, summary: undefined });
    const sep = formatChunkSeparator(chunk);
    expect(sep).toBe("");
  });
});

describe("formatToolResultChunk()", () => {
  function makeChunk(overrides: Partial<ToolResultChunk>): ToolResultChunk {
    return {
      text: "sample output\n",
      outputType: "generic_text",
      boundaryReason: "line_break",
      index: 0,
      isFinal: false,
      cumulativeBytes: 50,
      pendingMore: false,
      ...overrides,
    };
  }

  test("returns an array of strings", () => {
    const lines = formatToolResultChunk(makeChunk({}));
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l) => typeof l === "string")).toBe(true);
  });

  test("bash_error lines are non-empty strings", () => {
    const chunk = makeChunk({
      text: "Error: something\n    at fn (/app/src/x.ts:1:1)\n",
      outputType: "bash_error",
    });
    const lines = formatToolResultChunk(chunk);
    expect(lines.length).toBeGreaterThan(0);
    // Strip ANSI to check content
    const plain = lines.map((l) => l.replace(/\x1B\[[0-9;]*m/g, ""));
    expect(plain.some((l) => l.includes("Error"))).toBe(true);
  });

  test("grep_results preserves match content", () => {
    const chunk = makeChunk({
      text: "src/a.ts:10: const x = 1;\n",
      outputType: "grep_results",
      index: 0,
    });
    const lines = formatToolResultChunk(chunk);
    const plain = lines.map((l) => l.replace(/\x1B\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("src/a.ts");
    expect(plain).toContain("const x = 1;");
  });

  test("diff chunk shows + and - lines", () => {
    const chunk = makeChunk({
      text: "+new line\n-old line\n",
      outputType: "diff",
      index: 0,
    });
    const lines = formatToolResultChunk(chunk);
    const plain = lines.map((l) => l.replace(/\x1B\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("+new line");
    expect(plain).toContain("-old line");
  });

  test("non-first chunk (index > 0) prepends separator", () => {
    const chunk = makeChunk({
      index: 1,
      summary: "[test summary]",
    });
    const lines = formatToolResultChunk(chunk);
    const joined = lines.join("\n");
    expect(joined).toContain("[test summary]");
  });

  test("final chunk with index > 0 shows cumulative bytes footer", () => {
    const chunk = makeChunk({
      index: 2,
      isFinal: true,
      cumulativeBytes: 12_345,
    });
    const lines = formatToolResultChunk(chunk);
    const plain = lines.map((l) => l.replace(/\x1B\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("12,345");
  });
});
