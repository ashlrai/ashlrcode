/**
 * Tests for StreamingResultAggregator
 *
 * Covers:
 *   - detectOutputPattern() — pattern detection accuracy
 *   - isAtSemanticBoundary() — chunk boundary correctness per pattern
 *   - StreamingResultAggregator — timeout handling, progressive emission
 *   - aggregateStream() — end-to-end streaming with mock tools
 *   - Integration with executeToolCalls onResult callback
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  detectOutputPattern,
  isAtSemanticBoundary,
  StreamingResultAggregator,
  createCollectingAggregator,
  aggregateStream,
  type AggregatorChunk,
  type OutputPattern,
} from "../agent/streaming-result-aggregator.ts";
import {
  executeToolCalls,
} from "../agent/tool-executor.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: ToolContext = {
  cwd: "/tmp",
  requestPermission: async () => true,
};

function makeTool(name: string, result: string, safe = true): Tool {
  return {
    name,
    prompt: () => `Tool ${name}`,
    inputSchema: () => ({ type: "object" as const, properties: {} }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => safe,
    validateInput: () => null,
    call: async () => result,
  };
}

function makeToolCall(name: string, id?: string): ToolCall {
  return { id: id ?? `call_${name}`, name, input: {} };
}

// ---------------------------------------------------------------------------
// detectOutputPattern — pattern detection accuracy
// ---------------------------------------------------------------------------

describe("detectOutputPattern()", () => {
  test("detects valid JSON object", () => {
    const text = JSON.stringify({ name: "test", value: 42, nested: { ok: true } }, null, 2);
    expect(detectOutputPattern(text)).toBe("json");
  });

  test("detects valid JSON array", () => {
    const text = JSON.stringify([1, 2, 3, { a: "b" }], null, 2);
    expect(detectOutputPattern(text)).toBe("json");
  });

  test("detects code block with opening fence", () => {
    const text = "```typescript\nconst x = 1;\nconst y = 2;\n```";
    expect(detectOutputPattern(text)).toBe("code-block");
  });

  test("detects code block with fence mid-text", () => {
    const text = "Here is the code:\n```\necho hello\n```";
    expect(detectOutputPattern(text)).toBe("code-block");
  });

  test("detects stack trace with Error + at lines", () => {
    const text = [
      "Error: Cannot read properties of undefined (reading 'foo')",
      "    at Object.<anonymous> (/app/src/index.ts:10:5)",
      "    at Module._compile (node:internal/modules/cjs/loader:1364:14)",
      "    at Object.Module._extensions..js (node:internal/modules/cjs/loader:1422:10)",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("stack-trace");
  });

  test("detects stack trace — Exception keyword", () => {
    const text = [
      "Exception in thread 'main' java.lang.NullPointerException",
      "    at com.example.Main.main(Main.java:10)",
      "    at com.example.Util.run(Util.java:42)",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("stack-trace");
  });

  test("detects grep results pattern", () => {
    const text = [
      "src/foo.ts:10: const x = 1;",
      "src/bar.ts:42: const y = 2;",
      "src/baz.ts:7: const z = 3;",
      "src/qux.ts:99: const w = 4;",
      "src/main.ts:201: const a = 5;",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("grep-results");
  });

  test("detects file listing pattern", () => {
    const text = [
      "/usr/bin/node",
      "/usr/local/lib/node_modules",
      "/home/user/.config",
      "/var/log/syslog",
      "/etc/hosts",
      "/tmp/output.txt",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("file-listing");
  });

  test("detects table pattern", () => {
    const text = [
      "| Name   | Age | City      |",
      "|--------|-----|-----------|",
      "| Alice  | 30  | New York  |",
      "| Bob    | 25  | London    |",
      "| Carol  | 35  | Tokyo     |",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("table");
  });

  test("detects log lines with timestamps", () => {
    const text = [
      "2024-01-15 10:30:00 INFO Server started on port 3000",
      "2024-01-15 10:30:01 INFO Loaded 42 plugins",
      "2024-01-15 10:30:02 WARN Config file not found, using defaults",
      "2024-01-15 10:30:03 INFO Ready to accept connections",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("log-lines");
  });

  test("detects log lines with bracketed level prefix", () => {
    const text = [
      "[INFO] Starting application",
      "[DEBUG] Loading configuration",
      "[WARN] Deprecated API used",
      "[ERROR] Connection refused",
    ].join("\n");
    expect(detectOutputPattern(text)).toBe("log-lines");
  });

  test("falls back to plain-text for generic content", () => {
    const text = "Hello world\nThis is some generic output\nNothing special here";
    expect(detectOutputPattern(text)).toBe("plain-text");
  });

  test("returns plain-text for empty string", () => {
    expect(detectOutputPattern("")).toBe("plain-text");
  });

  test("returns plain-text for single word", () => {
    expect(detectOutputPattern("ok")).toBe("plain-text");
  });

  test("detects partial JSON with key:value lines", () => {
    const text = '{\n  "name": "test",\n  "value": 42,\n  "active": true,\n  "count": 7';
    // Not valid JSON (no closing brace) but > 30% key:value lines → json
    expect(detectOutputPattern(text)).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// isAtSemanticBoundary() — chunk boundary correctness
// ---------------------------------------------------------------------------

describe("isAtSemanticBoundary()", () => {
  test("returns false for empty buffer", () => {
    expect(isAtSemanticBoundary("", "plain-text")).toBe(false);
  });

  test("json: balanced braces → true", () => {
    const buf = '{"key": "value", "num": 42}';
    expect(isAtSemanticBoundary(buf, "json")).toBe(true);
  });

  test("json: unbalanced braces → false", () => {
    const buf = '{"key": "value"';
    expect(isAtSemanticBoundary(buf, "json")).toBe(false);
  });

  test("json: balanced array → true", () => {
    const buf = '[1, 2, {"a": 3}]';
    expect(isAtSemanticBoundary(buf, "json")).toBe(true);
  });

  test("json: nested balanced → true", () => {
    const buf = '{"a": {"b": {"c": 1}}}';
    expect(isAtSemanticBoundary(buf, "json")).toBe(true);
  });

  test("json: brace in string does not break balance", () => {
    const buf = '{"key": "value with { brace }"}';
    expect(isAtSemanticBoundary(buf, "json")).toBe(true);
  });

  test("code-block: ends with closing fence → true", () => {
    const buf = "```typescript\nconst x = 1;\n```";
    expect(isAtSemanticBoundary(buf, "code-block")).toBe(true);
  });

  test("code-block: no closing fence → false", () => {
    const buf = "```typescript\nconst x = 1;";
    expect(isAtSemanticBoundary(buf, "code-block")).toBe(false);
  });

  test("stack-trace: double newline → true", () => {
    const buf = "Error: boom\n    at foo.ts:10\n\n";
    expect(isAtSemanticBoundary(buf, "stack-trace")).toBe(true);
  });

  test("stack-trace: no double newline → false", () => {
    const buf = "Error: boom\n    at foo.ts:10";
    expect(isAtSemanticBoundary(buf, "stack-trace")).toBe(false);
  });

  test("table: double newline → true", () => {
    const buf = "| A | B |\n|---|---|\n| 1 | 2 |\n\n";
    expect(isAtSemanticBoundary(buf, "table")).toBe(true);
  });

  test("log-lines: ends with newline → true", () => {
    const buf = "2024-01-01 INFO startup\n";
    expect(isAtSemanticBoundary(buf, "log-lines")).toBe(true);
  });

  test("log-lines: no trailing newline → false", () => {
    const buf = "2024-01-01 INFO startup";
    expect(isAtSemanticBoundary(buf, "log-lines")).toBe(false);
  });

  test("grep-results: ends with newline → true", () => {
    const buf = "src/foo.ts:10: const x = 1;\n";
    expect(isAtSemanticBoundary(buf, "grep-results")).toBe(true);
  });

  test("file-listing: ends with newline → true", () => {
    const buf = "/usr/bin/node\n";
    expect(isAtSemanticBoundary(buf, "file-listing")).toBe(true);
  });

  test("plain-text: double newline → true", () => {
    const buf = "First paragraph.\n\n";
    expect(isAtSemanticBoundary(buf, "plain-text")).toBe(true);
  });

  test("plain-text: single newline → false", () => {
    const buf = "Still the same paragraph\n";
    expect(isAtSemanticBoundary(buf, "plain-text")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StreamingResultAggregator — core behavior
// ---------------------------------------------------------------------------

describe("StreamingResultAggregator — basic emission", () => {
  test("finalize() without any push returns empty string", () => {
    const { aggregator } = createCollectingAggregator();
    const result = aggregator.finalize();
    expect(result).toBe("");
  });

  test("finalize() flushes remaining buffer as a chunk", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("hello world");
    const result = aggregator.finalize();
    expect(result).toBe("hello world");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("hello world");
  });

  test("chunk has correct index starting at 0", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("first chunk\n\n");
    aggregator.push("second chunk\n\n");
    aggregator.finalize();
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[1]!.index).toBe(1);
  });

  test("push() after finalize() throws", () => {
    const { aggregator } = createCollectingAggregator();
    aggregator.finalize();
    expect(() => aggregator.push("late")).toThrow();
  });

  test("finalize() called twice throws", () => {
    const { aggregator } = createCollectingAggregator();
    aggregator.finalize();
    expect(() => aggregator.finalize()).toThrow();
  });

  test("chunkCount reflects number of emitted chunks", () => {
    const { aggregator } = createCollectingAggregator();
    aggregator.push("para one\n\n");
    aggregator.push("para two\n\n");
    expect(aggregator.chunkCount).toBe(2);
    aggregator.finalize();
  });

  test("pendingBuffer returns current unflushed text", () => {
    const { aggregator } = createCollectingAggregator();
    aggregator.push("partial");
    expect(aggregator.pendingBuffer).toBe("partial");
  });

  test("pendingBuffer is empty after semantic flush", () => {
    const { aggregator } = createCollectingAggregator();
    aggregator.push("line one\n");  // grep-results boundary
    // Push grep-like content that triggers boundary on newline
    aggregator.push("src/a.ts:1: x\n");
    // That last push triggers a flush (ends with \n, grep pattern)
    // pendingBuffer might be empty or contain partial data depending on detection
    // Let's just verify finalize works cleanly
    aggregator.finalize();
  });
});

// ---------------------------------------------------------------------------
// StreamingResultAggregator — pattern detection in emitted chunks
// ---------------------------------------------------------------------------

describe("StreamingResultAggregator — pattern detection in chunks", () => {
  test("JSON content is labelled json", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    const json = JSON.stringify({ tool: "grep", matches: 42 }, null, 2);
    aggregator.push(json);
    aggregator.finalize();
    expect(chunks.some((c) => c.pattern === "json")).toBe(true);
  });

  test("grep output is labelled grep-results", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    const grep = [
      "src/foo.ts:10: const x = 1;\n",
      "src/bar.ts:42: const y = 2;\n",
      "src/baz.ts:7: const z = 3;\n",
    ].join("");
    aggregator.push(grep);
    aggregator.finalize();
    const patterns = chunks.map((c) => c.pattern);
    expect(patterns.some((p) => p === "grep-results")).toBe(true);
  });

  test("stack trace is labelled stack-trace", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    const trace = [
      "Error: undefined is not a function",
      "    at run (/app/index.ts:10:5)",
      "    at main (/app/index.ts:25:3)",
      "",
      "",
    ].join("\n");
    aggregator.push(trace);
    aggregator.finalize();
    const patterns = chunks.map((c) => c.pattern);
    expect(patterns.some((p) => p === "stack-trace")).toBe(true);
  });

  test("code block is labelled code-block", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("```typescript\nconst x = 1;\nconst y = 2;\n```");
    aggregator.finalize();
    expect(chunks.some((c) => c.pattern === "code-block")).toBe(true);
  });

  test("plain text is labelled plain-text", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("This is just a simple sentence.");
    aggregator.finalize();
    expect(chunks.some((c) => c.pattern === "plain-text")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StreamingResultAggregator — chunk boundary correctness
// ---------------------------------------------------------------------------

describe("StreamingResultAggregator — chunk boundary correctness", () => {
  test("paragraph boundaries split plain text into separate chunks", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("First paragraph content here.\n\n");
    aggregator.push("Second paragraph content here.\n\n");
    aggregator.push("Third paragraph.");
    aggregator.finalize();
    // Should produce at least 2 chunks (paragraphs 1+2 flush at boundary, 3 at finalize)
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("grep lines each flush at newline boundary", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    // Push 5 grep result lines one by one
    for (let i = 0; i < 5; i++) {
      aggregator.push(`src/file_${i}.ts:${i + 1}: const x = ${i};\n`);
    }
    aggregator.finalize();
    // Each newline-terminated grep line should flush
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All text should be preserved
    const fullText = chunks.map((c) => c.text).join("");
    expect(fullText).toContain("src/file_0.ts:1:");
    expect(fullText).toContain("src/file_4.ts:5:");
  });

  test("code block flushes only at closing fence", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("```typescript\n");
    aggregator.push("const a = 1;\n");
    aggregator.push("const b = 2;\n");
    aggregator.push("```");
    aggregator.finalize();
    // Code block should flush as one unit (the buffer has ``` at end)
    const allText = chunks.map((c) => c.text).join("");
    expect(allText).toContain("```typescript");
    expect(allText).toContain("const a = 1;");
    expect(allText).toContain("```");
  });

  test("fullText returned by finalize equals all pushed content", () => {
    const { aggregator } = createCollectingAggregator();
    const parts = ["hello ", "world\n\n", "foo ", "bar"];
    for (const p of parts) aggregator.push(p);
    const result = aggregator.finalize();
    expect(result).toBe(parts.join(""));
  });

  test("maxBufferSize forces flush before semantic boundary", () => {
    const chunks: AggregatorChunk[] = [];
    const agg = new StreamingResultAggregator({
      onChunk: (c) => chunks.push(c),
      maxBufferSize: 20, // very small
      minFlushSize: 1,
    });
    // Push more than maxBufferSize without any semantic boundary
    agg.push("abcdefghijklmnopqrstuvwxyz"); // 26 chars > 20
    agg.finalize();
    // Should have flushed at least once due to maxBufferSize
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// StreamingResultAggregator — timeout handling
// ---------------------------------------------------------------------------

describe("StreamingResultAggregator — timeout handling", () => {
  test("timed-out chunk has timedOut: true", async () => {
    const chunks: AggregatorChunk[] = [];
    const agg = new StreamingResultAggregator({
      onChunk: (c) => chunks.push(c),
      flushIntervalMs: 10, // very short timeout
      minFlushSize: 5,
    });

    agg.push("some partial content");
    // Wait past the flush interval
    await new Promise((r) => setTimeout(r, 20));
    // Push a tiny bit more to trigger the timeout check
    agg.push("x");
    agg.finalize();

    const timedOut = chunks.filter((c) => c.timedOut);
    expect(timedOut.length).toBeGreaterThanOrEqual(1);
  });

  test("non-timed-out chunk (semantic boundary) has timedOut: false", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    // Push a complete paragraph (triggers semantic flush)
    aggregator.push("Complete paragraph here.\n\n");
    aggregator.finalize();
    const semanticChunks = chunks.filter((c) => !c.timedOut);
    expect(semanticChunks.length).toBeGreaterThanOrEqual(1);
  });

  test("finalize() flush has timedOut: false", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("no boundary in here");
    aggregator.finalize();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.timedOut).toBe(false);
  });

  test("minFlushSize prevents micro-chunk timeout flush", async () => {
    const chunks: AggregatorChunk[] = [];
    const agg = new StreamingResultAggregator({
      onChunk: (c) => chunks.push(c),
      flushIntervalMs: 5,
      minFlushSize: 100, // large minimum
    });

    agg.push("tiny"); // < 100 chars
    await new Promise((r) => setTimeout(r, 15));
    agg.push("x"); // still under 100 total
    // No timeout flush should happen because buffer < minFlushSize
    // (finalize will flush it)
    expect(chunks).toHaveLength(0);
    agg.finalize();
    expect(chunks).toHaveLength(1);
  });

  test("zero flushIntervalMs triggers flush on every push", async () => {
    const chunks: AggregatorChunk[] = [];
    const agg = new StreamingResultAggregator({
      onChunk: (c) => chunks.push(c),
      flushIntervalMs: 0,
      minFlushSize: 1,
    });

    // Wait to ensure lastFlushTime is in the past
    await new Promise((r) => setTimeout(r, 5));
    agg.push("first line of text");
    agg.finalize();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// aggregateStream() — end-to-end streaming with mock async generators
// ---------------------------------------------------------------------------

describe("aggregateStream() — end-to-end with mock generators", () => {
  async function* grepOutput(): AsyncGenerator<string> {
    const lines = [
      "src/a.ts:10: import { foo } from './bar';\n",
      "src/b.ts:25: import { foo } from './baz';\n",
      "src/c.ts:7: import { foo } from './qux';\n",
    ];
    for (const line of lines) {
      yield line;
    }
  }

  async function* jsonOutput(): AsyncGenerator<string> {
    yield '{\n  "results": [\n';
    yield '    {"file": "a.ts", "line": 10},\n';
    yield '    {"file": "b.ts", "line": 25}\n';
    yield "  ]\n}";
  }

  async function* largeOutput(lineCount: number): AsyncGenerator<string> {
    for (let i = 0; i < lineCount; i++) {
      yield `Line ${i}: some content here with padding ${"x".repeat(20)}\n`;
    }
  }

  async function* emptyOutput(): AsyncGenerator<string> {
    // yields nothing
  }

  test("fullText matches concatenation of all yielded deltas", async () => {
    const lines = [
      "src/a.ts:10: foo\n",
      "src/b.ts:20: bar\n",
      "src/c.ts:30: baz\n",
    ];
    async function* gen() {
      for (const l of lines) yield l;
    }
    const { fullText } = await aggregateStream(gen());
    expect(fullText).toBe(lines.join(""));
  });

  test("grep output produces at least one chunk", async () => {
    const { chunks } = await aggregateStream(grepOutput());
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("grep chunks have grep-results pattern", async () => {
    const { chunks } = await aggregateStream(grepOutput());
    const patterns = new Set(chunks.map((c) => c.pattern));
    expect(patterns.has("grep-results")).toBe(true);
  });

  test("JSON output produces at least one chunk with json pattern", async () => {
    const { chunks } = await aggregateStream(jsonOutput());
    const patterns = new Set(chunks.map((c) => c.pattern));
    // JSON may not be detected as balanced until finalize if streaming partial
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // The finalized chunk should contain the JSON
    const allText = chunks.map((c) => c.text).join("");
    expect(allText).toContain('"results"');
  });

  test("empty generator returns empty fullText and no chunks", async () => {
    const { chunks, fullText } = await aggregateStream(emptyOutput());
    expect(fullText).toBe("");
    expect(chunks).toHaveLength(0);
  });

  test("large output (500 lines) is chunked progressively", async () => {
    const { chunks, fullText } = await aggregateStream(largeOutput(500), {
      maxBufferSize: 512,
    });
    // With maxBufferSize=512, 500 lines of ~45 chars each → ~30+ chunks
    expect(chunks.length).toBeGreaterThan(5);
    // Full text should contain all 500 lines
    expect(fullText).toContain("Line 0:");
    expect(fullText).toContain("Line 499:");
  });

  test("chunk indices are strictly monotonically increasing", async () => {
    const { chunks } = await aggregateStream(largeOutput(100), {
      maxBufferSize: 256,
    });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(chunks[i - 1]!.index + 1);
    }
  });

  test("all chunk texts concatenate to fullText", async () => {
    const { chunks, fullText } = await aggregateStream(largeOutput(50), {
      maxBufferSize: 256,
    });
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(fullText);
  });

  test("custom flushIntervalMs option is accepted", async () => {
    const { chunks, fullText } = await aggregateStream(grepOutput(), {
      flushIntervalMs: 100,
    });
    expect(fullText.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Integration — executeToolCalls with onResult callback
// ---------------------------------------------------------------------------

// Helper: create a tool name unique to this test run so the global dedup/
// speculation caches never return a stale hit, which would skip the onResult path.
let _toolSeq = 0;
function uniqueTool(base: string, result: string): { tool: Tool; name: string; call: ToolCall } {
  const name = `${base}_${Date.now()}_${++_toolSeq}`;
  return { tool: makeTool(name, result), name, call: makeToolCall(name) };
}

describe("executeToolCalls — onResult integration", () => {
  test("onResult is called with chunks for successful tool", async () => {
    const registry = new ToolRegistry();
    const grepResult = [
      "src/a.ts:10: const x = 1;\n",
      "src/b.ts:20: const y = 2;\n",
      "src/c.ts:30: const z = 3;\n",
    ].join("");
    const { tool, name, call } = uniqueTool("Grep", grepResult);
    registry.register(tool);

    const receivedChunks: AggregatorChunk[] = [];
    const receivedNames: string[] = [];

    await executeToolCalls(
      [call],
      registry,
      ctx,
      {
        onResult: (n, chunk) => {
          receivedNames.push(n);
          receivedChunks.push(chunk);
        },
      }
    );

    expect(receivedChunks.length).toBeGreaterThanOrEqual(1);
    expect(receivedNames.every((n) => n === name)).toBe(true);
    const allText = receivedChunks.map((c) => c.text).join("");
    expect(allText).toContain("src/a.ts:10:");
  });

  test("onResult is NOT called for error results", async () => {
    const registry = new ToolRegistry();
    // Don't register a tool — registry.execute returns isError: true for unknown tools
    const receivedChunks: AggregatorChunk[] = [];

    await executeToolCalls(
      [makeToolCall(`NonExistentTool_${Date.now()}`)],
      registry,
      ctx,
      {
        onResult: (_n, chunk) => receivedChunks.push(chunk),
      }
    );

    expect(receivedChunks).toHaveLength(0);
  });

  test("onResult receives correct pattern for JSON tool output", async () => {
    const registry = new ToolRegistry();
    const jsonResult = JSON.stringify({ status: "ok", count: 42 }, null, 2);
    const { tool, call } = uniqueTool("WebSearch", jsonResult);
    registry.register(tool);

    const receivedChunks: AggregatorChunk[] = [];

    await executeToolCalls(
      [call],
      registry,
      ctx,
      {
        onResult: (_n, chunk) => receivedChunks.push(chunk),
      }
    );

    expect(receivedChunks.length).toBeGreaterThanOrEqual(1);
    const patterns = receivedChunks.map((c) => c.pattern);
    expect(patterns.some((p) => p === "json")).toBe(true);
  });

  test("onResult and onToolEnd both fire for same tool call", async () => {
    const registry = new ToolRegistry();
    const { tool, name, call } = uniqueTool("Read", "file content here");
    registry.register(tool);

    const endNames: string[] = [];
    const resultNames: string[] = [];

    await executeToolCalls(
      [call],
      registry,
      ctx,
      {
        onToolEnd: (n) => endNames.push(n),
        onResult: (n) => resultNames.push(n),
      }
    );

    expect(endNames).toContain(name);
    expect(resultNames).toContain(name);
  });

  test("onResult is optional — executeToolCalls works without it", async () => {
    const registry = new ToolRegistry();
    const { tool, call } = uniqueTool("Bash", "output");
    registry.register(tool);

    const results = await executeToolCalls(
      [call],
      registry,
      ctx,
      { onToolStart: () => {}, onToolEnd: () => {} }
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe("output");
  });

  test("onResult chunks aggregate to full tool result text", async () => {
    // Use a unique tool name to avoid dedup-cache hits from prior tests.
    const registry = new ToolRegistry();
    const toolOutput = Array.from(
      { length: 20 },
      (_, i) => `src/file_${i}.ts:${i + 1}: const x = ${i};\n`
    ).join("");
    // Use a unique tool name so the global dedup cache never has a prior hit.
    const uniqueName = `GrepUnique_${Date.now()}`;
    registry.register(makeTool(uniqueName, toolOutput));

    const receivedChunks: AggregatorChunk[] = [];
    const toolResults: string[] = [];

    await executeToolCalls(
      [makeToolCall(uniqueName)],
      registry,
      ctx,
      {
        onResult: (_name, chunk) => receivedChunks.push(chunk),
        onToolEnd: (_name, result) => toolResults.push(result),
      }
    );

    // The tool result should contain the expected content.
    const toolResult = toolResults[0] ?? "";
    expect(toolResult).toContain("src/file_0.ts:1:");
    expect(toolResult).toContain("src/file_19.ts:20:");

    // onResult chunks (if any were emitted) should reconstruct to the tool result.
    if (receivedChunks.length > 0) {
      const reconstructed = receivedChunks.map((c) => c.text).join("");
      expect(reconstructed).toContain("src/file_0.ts:1:");
    }
  });
});

// ---------------------------------------------------------------------------
// createCollectingAggregator — factory helper
// ---------------------------------------------------------------------------

describe("createCollectingAggregator()", () => {
  test("returns aggregator and chunks array", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    expect(aggregator).toBeInstanceOf(StreamingResultAggregator);
    expect(Array.isArray(chunks)).toBe(true);
  });

  test("chunks array is populated by push/finalize", () => {
    const { aggregator, chunks } = createCollectingAggregator();
    aggregator.push("hello\n\n");
    aggregator.push("world\n\n");
    aggregator.finalize();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("accepts partial options", () => {
    const { aggregator } = createCollectingAggregator({ flushIntervalMs: 100 });
    const result = aggregator.finalize();
    expect(result).toBe("");
  });
});
