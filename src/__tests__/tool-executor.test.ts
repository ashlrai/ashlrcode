import { test, expect, describe, beforeEach } from "bun:test";
import {
  executeToolCalls,
  streamResultCompressor,
  compressToolResult,
  summariseChunk,
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD,
} from "../agent/tool-executor.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";

function makeTool(name: string, concurrencySafe: boolean, result = "ok"): Tool {
  return {
    name,
    prompt: () => `Tool ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => concurrencySafe,
    validateInput: () => null,
    call: async () => result,
  };
}

function makeToolCall(name: string, id?: string): ToolCall {
  return { id: id ?? `call_${name}`, name, input: {} };
}

const ctx: ToolContext = {
  cwd: "/tmp",
  requestPermission: async () => true,
};

describe("executeToolCalls", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test("returns empty array for no tool calls", async () => {
    const results = await executeToolCalls([], registry, ctx);
    expect(results).toEqual([]);
  });

  test("executes a single tool call", async () => {
    registry.register(makeTool("Read", true, "file content"));
    const results = await executeToolCalls(
      [makeToolCall("Read")],
      registry,
      ctx
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe("file content");
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.name).toBe("Read");
  });

  test("runs concurrency-safe tools in parallel", async () => {
    const startTimes: number[] = [];
    const makeTimedTool = (name: string): Tool => ({
      ...makeTool(name, true),
      call: async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return `${name} done`;
      },
    });

    registry.register(makeTimedTool("A"));
    registry.register(makeTimedTool("B"));

    const results = await executeToolCalls(
      [makeToolCall("A"), makeToolCall("B")],
      registry,
      ctx
    );

    expect(results).toHaveLength(2);
    // Both should have started nearly simultaneously (within 30ms)
    expect(Math.abs(startTimes[0]! - startTimes[1]!)).toBeLessThan(30);
  });

  test("runs non-concurrency-safe tools sequentially", async () => {
    const executionOrder: string[] = [];
    const makeSeqTool = (name: string): Tool => ({
      ...makeTool(name, false),
      call: async () => {
        executionOrder.push(`${name}_start`);
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(`${name}_end`);
        return `${name} done`;
      },
    });

    registry.register(makeSeqTool("X"));
    registry.register(makeSeqTool("Y"));

    await executeToolCalls(
      [makeToolCall("X"), makeToolCall("Y")],
      registry,
      ctx
    );

    // Sequential: X should finish before Y starts
    expect(executionOrder).toEqual(["X_start", "X_end", "Y_start", "Y_end"]);
  });

  test("fires onToolStart and onToolEnd callbacks", async () => {
    registry.register(makeTool("T", true, "result"));

    const starts: string[] = [];
    const ends: string[] = [];

    await executeToolCalls([makeToolCall("T")], registry, ctx, {
      onToolStart: (name) => starts.push(name),
      onToolEnd: (name) => ends.push(name),
    });

    expect(starts).toEqual(["T"]);
    expect(ends).toEqual(["T"]);
  });

  test("handles errors from tool execution", async () => {
    registry.register(makeTool("Fail", true));
    // The tool is registered but executeToolCalls routes through registry.execute,
    // which catches errors. An unknown tool would return isError.
    const results = await executeToolCalls(
      [makeToolCall("Unknown")],
      registry,
      ctx
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
  });

  test("preserves toolCallId in results", async () => {
    registry.register(makeTool("R", true));
    const results = await executeToolCalls(
      [{ id: "my-custom-id", name: "R", input: {} }],
      registry,
      ctx
    );
    expect(results[0]!.toolCallId).toBe("my-custom-id");
  });
});

// ---------------------------------------------------------------------------
// summariseChunk — pattern detection heuristics
// ---------------------------------------------------------------------------

describe("summariseChunk", () => {
  test("detects stack trace pattern", () => {
    const chunk = [
      "Error: something went wrong",
      "    at Object.<anonymous> (/app/index.ts:10:5)",
      "    at Module._compile (node:internal/modules/cjs/loader:1364:14)",
      "    at Object.Module._extensions..js (node:internal/modules/cjs/loader:1422:10)",
    ].join("\n");
    const summary = summariseChunk(chunk);
    expect(summary).toMatch(/\[SUMMARY:/);
    expect(summary).toMatch(/stack trace/);
  });

  test("detects grep matches pattern", () => {
    const chunk = [
      "src/foo.ts:10: const x = 1;",
      "src/bar.ts:42: const x = 2;",
      "src/baz.ts:7: const x = 3;",
      "src/qux.ts:99: const x = 4;",
    ].join("\n");
    const summary = summariseChunk(chunk);
    expect(summary).toMatch(/grep matches/);
  });

  test("detects file listing pattern", () => {
    const chunk = [
      "/usr/bin/node",
      "/usr/local/lib/node_modules",
      "/home/user/.config",
      "/var/log/syslog",
      "/etc/hosts",
    ].join("\n");
    const summary = summariseChunk(chunk);
    expect(summary).toMatch(/file listing/);
  });

  test("returns line count in summary", () => {
    const chunk = "line1\nline2\nline3\nline4\nline5";
    const summary = summariseChunk(chunk);
    expect(summary).toMatch(/5 lines/);
  });

  test("falls back to 'text' pattern for generic content", () => {
    const chunk = "hello world\nfoo bar\nbaz qux";
    const summary = summariseChunk(chunk);
    expect(summary).toMatch(/\[SUMMARY:/);
    expect(summary).toMatch(/text/);
  });
});

// ---------------------------------------------------------------------------
// streamResultCompressor — core streaming compression logic
// ---------------------------------------------------------------------------

describe("streamResultCompressor", () => {
  const smallOpts = {
    maxBytes: 100,
    chunkSummaryThreshold: 50,
  };

  function makeOutputTool(output: string): Tool {
    return {
      ...makeTool("Bash", true, output),
      call: async () => output,
    };
  }

  test("yields result verbatim when under threshold", async () => {
    const tool = makeOutputTool("short output");
    const events: string[] = [];
    const gen = streamResultCompressor(tool, {}, ctx, smallOpts);
    for await (const event of gen) {
      events.push(event.text);
    }
    expect(events.join("")).toBe("short output");
  });

  test("yields all delta events with type 'delta'", async () => {
    const tool = makeOutputTool("x".repeat(200));
    const gen = streamResultCompressor(tool, {}, ctx, smallOpts);
    for await (const event of gen) {
      expect(event.type).toBe("delta");
    }
  });

  test("large output (100KB) stays under 20KB in compressed result", async () => {
    // Generate 100 KB of realistic bash-like output
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`line ${i}: ${"a".repeat(17)}`); // ~25 bytes per line → ~125 KB total
    }
    const bigOutput = lines.join("\n");

    const encoder = new TextEncoder();
    expect(encoder.encode(bigOutput).length).toBeGreaterThan(100_000);

    const tool = makeOutputTool(bigOutput);
    const result = await compressToolResult(tool, {}, ctx);

    const resultBytes = encoder.encode(result).length;
    expect(resultBytes).toBeLessThan(20_000);
  });

  test("compressed result contains [SUMMARY: ...] annotations", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(`output line ${i}`);
    }
    const bigOutput = lines.join("\n");

    const tool = makeOutputTool(bigOutput);
    const result = await compressToolResult(tool, {}, ctx);

    expect(result).toMatch(/\[SUMMARY:/);
  });

  test("verbatim head is preserved exactly at the start of the result", async () => {
    const head = "IMPORTANT: first 100 bytes of output are verbatim\n";
    const tail = "x".repeat(500);
    const fullOutput = head + tail;

    const tool = makeOutputTool(fullOutput);
    // Use maxBytes = head.length so head fits exactly in verbatim window
    const opts = { maxBytes: head.length, chunkSummaryThreshold: 50 };
    const result = await compressToolResult(tool, {}, ctx, opts);

    expect(result.startsWith(head)).toBe(true);
    expect(result).toMatch(/\[SUMMARY:/);
  });

  test("LLM sees summarised chunks — result contains structured summary blocks", async () => {
    // Simulate a 50 KB bash output (many repeated lines)
    const output = Array.from({ length: 2000 }, (_, i) => `bash_line_${i}: output data here`).join("\n");
    const tool = makeOutputTool(output);

    const result = await compressToolResult(tool, {}, ctx);

    // The result should contain multiple SUMMARY annotations (one per chunk)
    const summaryCount = (result.match(/\[SUMMARY:/g) ?? []).length;
    expect(summaryCount).toBeGreaterThan(0);

    // Each summary block should name a detected pattern
    expect(result).toMatch(/pattern ".*?" detected/);
  });

  test("default constants are at expected sizes", () => {
    expect(DEFAULT_TOOL_RESULT_MAX_BYTES).toBe(15_360);
    expect(DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD).toBe(2_048);
  });

  test("compressToolResult returns same content as manual generator drain for small input", async () => {
    const tool = makeOutputTool("hello world");
    const result = await compressToolResult(tool, {}, ctx, smallOpts);
    expect(result).toBe("hello world");
  });

  test("generator return value is the final compressed string", async () => {
    const output = "x".repeat(200);
    const tool = makeOutputTool(output);
    const gen = streamResultCompressor(tool, {}, ctx, smallOpts);

    let returnValue: string | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        returnValue = step.value;
        break;
      }
    }
    expect(typeof returnValue).toBe("string");
    expect(returnValue!.length).toBeLessThan(output.length);
  });
});
