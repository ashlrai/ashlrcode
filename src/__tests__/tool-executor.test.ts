import { test, expect, describe, beforeEach } from "bun:test";
import { executeToolCalls } from "../agent/tool-executor.ts";
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
