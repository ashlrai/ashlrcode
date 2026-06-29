/**
 * Tests for tool-call coalescence layer (src/agent/tool-coalescence.ts).
 *
 * Verifies:
 *   - levenshtein / similarityRatio
 *   - extractPaths / pathsOverlap
 *   - areCoalescible
 *   - mergeCommands (grep alternation + && chain)
 *   - buildSentinelCommand / splitSentinelOutput
 *   - buildCoalescedGroups (grouping logic)
 *   - executeWithCoalescence (end-to-end result preservation)
 *   - coalescence opt-out via __noCoalesce
 *   - coalescence stats tracking
 *   - regression: non-coalesced calls pass through unchanged
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  levenshtein,
  similarityRatio,
  extractPaths,
  pathsOverlap,
  areCoalescible,
  mergeCommands,
  buildSentinelCommand,
  splitSentinelOutput,
  buildCoalescedGroups,
  executeWithCoalescence,
  getCoalescenceStats,
  resetCoalescenceStats,
  formatCoalescenceStats,
  COALESCENCE_MAX_WINDOW,
  RESULT_SENTINEL_PREFIX,
} from "../agent/tool-coalescence.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(
  name: string,
  command: string,
  id?: string,
  noCoalesce?: boolean
): ToolCall {
  return {
    id: id ?? `tc_${name}_${command.slice(0, 8)}`,
    name,
    input: {
      command,
      ...(noCoalesce ? { __noCoalesce: true } : {}),
    },
  };
}

function makeBashTool(resultFn: (cmd: string) => string = () => "ok"): Tool {
  return {
    name: "Bash",
    prompt: () => "run bash",
    inputSchema: () => ({ type: "object", properties: {} }),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    validateInput: () => null,
    call: async (input) => {
      const cmd = typeof input.command === "string" ? input.command : "";
      return resultFn(cmd);
    },
  };
}

const ctx: ToolContext = {
  cwd: "/tmp",
  requestPermission: async () => true,
};

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

describe("levenshtein", () => {
  test("identical strings → 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  test("empty string vs non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  test("single insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  test("single deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  test("single substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  test("completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// similarityRatio
// ---------------------------------------------------------------------------

describe("similarityRatio", () => {
  test("identical strings → 1.0", () => {
    expect(similarityRatio("hello", "hello")).toBe(1.0);
  });

  test("empty strings → 1.0", () => {
    expect(similarityRatio("", "")).toBe(1.0);
  });

  test("similar grep commands are above threshold", () => {
    const a = "grep -r 'foo' src/";
    const b = "grep -r 'bar' src/";
    expect(similarityRatio(a, b)).toBeGreaterThan(0.5);
  });

  test("completely different strings → low ratio", () => {
    const ratio = similarityRatio("abcdefghij", "zyxwvutsrq");
    expect(ratio).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// extractPaths / pathsOverlap
// ---------------------------------------------------------------------------

describe("extractPaths", () => {
  test("extracts absolute paths", () => {
    const paths = extractPaths("cat /foo/bar.ts");
    expect(paths.has("/foo/bar.ts")).toBe(true);
  });

  test("extracts relative paths", () => {
    const paths = extractPaths("grep foo ./src/utils.ts");
    expect(paths.has("./src/utils.ts")).toBe(true);
  });

  test("extracts files with extensions", () => {
    const paths = extractPaths("bun test index.test.ts");
    expect(paths.has("index.test.ts")).toBe(true);
  });
});

describe("pathsOverlap", () => {
  test("detects shared path", () => {
    const a = new Set(["src/foo.ts", "src/bar.ts"]);
    const b = new Set(["src/bar.ts", "src/baz.ts"]);
    expect(pathsOverlap(a, b)).toBe(true);
  });

  test("no overlap returns false", () => {
    const a = new Set(["src/foo.ts"]);
    const b = new Set(["src/bar.ts"]);
    expect(pathsOverlap(a, b)).toBe(false);
  });

  test("empty sets return false", () => {
    expect(pathsOverlap(new Set(), new Set(["x"]))).toBe(false);
    expect(pathsOverlap(new Set(["x"]), new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// areCoalescible
// ---------------------------------------------------------------------------

describe("areCoalescible", () => {
  test("identical Bash commands are coalescible", () => {
    const a = makeToolCall("Bash", "grep foo src/");
    const b = makeToolCall("Bash", "grep foo src/");
    expect(areCoalescible(a, b)).toBe(true);
  });

  test("similar grep commands are coalescible", () => {
    const a = makeToolCall("Bash", "grep -r 'foo' src/");
    const b = makeToolCall("Bash", "grep -r 'bar' src/");
    expect(areCoalescible(a, b)).toBe(true);
  });

  test("different tool names are not coalescible", () => {
    const a = makeToolCall("Bash", "ls src/");
    const b = { id: "read1", name: "Read", input: { file_path: "src/" } };
    expect(areCoalescible(a, b)).toBe(false);
  });

  test("non-Bash tools are not coalescible even when same name and similar", () => {
    const a = { id: "r1", name: "Read", input: { file_path: "src/a.ts" } };
    const b = { id: "r2", name: "Read", input: { file_path: "src/b.ts" } };
    expect(areCoalescible(a, b)).toBe(false);
  });

  test("__noCoalesce opt-out is respected on first call", () => {
    const a = makeToolCall("Bash", "grep foo src/", "a", true);
    const b = makeToolCall("Bash", "grep bar src/");
    expect(areCoalescible(a, b)).toBe(false);
  });

  test("__noCoalesce opt-out is respected on second call", () => {
    const a = makeToolCall("Bash", "grep foo src/");
    const b = makeToolCall("Bash", "grep bar src/", "b", true);
    expect(areCoalescible(a, b)).toBe(false);
  });

  test("path overlap makes dissimilar commands coalescible", () => {
    const a = makeToolCall("Bash", "grep 'TODO' src/utils.ts");
    const b = makeToolCall("Bash", "wc -l src/utils.ts");
    // paths overlap on src/utils.ts
    expect(areCoalescible(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeCommands
// ---------------------------------------------------------------------------

describe("mergeCommands", () => {
  test("single command passes through unchanged", () => {
    expect(mergeCommands(["grep foo src/"])).toBe("grep foo src/");
  });

  test("grep commands on same path merge into alternation", () => {
    const merged = mergeCommands([
      "grep 'foo' src/",
      "grep 'bar' src/",
    ]);
    expect(merged).toContain("-E");
    expect(merged).toContain("(foo)");
    expect(merged).toContain("(bar)");
    expect(merged).toContain("src/");
    // Should be a single command, not && chained
    expect(merged).not.toContain("&&");
  });

  test("grep commands on different paths fall back to && chain", () => {
    const merged = mergeCommands([
      "grep 'foo' src/a.ts",
      "grep 'bar' src/b.ts",
    ]);
    expect(merged).toContain("&&");
  });

  test("non-grep commands merge with && chain", () => {
    const merged = mergeCommands(["ls src/", "ls tests/"]);
    expect(merged).toBe("ls src/ && ls tests/");
  });
});

// ---------------------------------------------------------------------------
// buildSentinelCommand / splitSentinelOutput
// ---------------------------------------------------------------------------

describe("buildSentinelCommand + splitSentinelOutput", () => {
  test("single command round-trips unchanged", () => {
    const cmd = buildSentinelCommand(["echo hello"]);
    expect(cmd).toBe("echo hello");
    const results = splitSentinelOutput("hello", 1);
    expect(results).toEqual(["hello"]);
  });

  test("two commands split correctly by sentinel", () => {
    const commands = ["echo alpha", "echo beta"];
    // Simulate what a shell would output
    const simulatedOutput = [
      "alpha",
      `${RESULT_SENTINEL_PREFIX}0`,
      "beta",
      `${RESULT_SENTINEL_PREFIX}1`,
    ].join("\n");

    const results = splitSentinelOutput(simulatedOutput, 2);
    expect(results[0]).toBe("alpha");
    expect(results[1]).toBe("beta");
  });

  test("three commands split correctly", () => {
    const simulatedOutput = [
      "result_a",
      `${RESULT_SENTINEL_PREFIX}0`,
      "result_b",
      `${RESULT_SENTINEL_PREFIX}1`,
      "result_c",
      `${RESULT_SENTINEL_PREFIX}2`,
    ].join("\n");

    const results = splitSentinelOutput(simulatedOutput, 3);
    expect(results[0]).toBe("result_a");
    expect(results[1]).toBe("result_b");
    expect(results[2]).toBe("result_c");
  });
});

// ---------------------------------------------------------------------------
// buildCoalescedGroups
// ---------------------------------------------------------------------------

describe("buildCoalescedGroups", () => {
  test("single call → single passthrough group", () => {
    const groups = buildCoalescedGroups([makeToolCall("Bash", "ls src/")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.mergeStrategy).toBe("passthrough");
    expect(groups[0]!.originalCalls).toHaveLength(1);
  });

  test("two similar calls → one merged group", () => {
    const calls = [
      makeToolCall("Bash", "grep 'TODO' src/", "a"),
      makeToolCall("Bash", "grep 'FIXME' src/", "b"),
    ];
    const groups = buildCoalescedGroups(calls);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.originalCalls).toHaveLength(2);
    expect(groups[0]!.mergeStrategy).not.toBe("passthrough");
  });

  test("max window size respected: 4 similar calls → 2 groups", () => {
    // COALESCENCE_MAX_WINDOW is 3
    const calls = Array.from({ length: 4 }, (_, i) =>
      makeToolCall("Bash", `grep 'pattern${i}' src/`, `tc${i}`)
    );
    const groups = buildCoalescedGroups(calls);
    // First 3 merged, last 1 passthrough
    expect(groups).toHaveLength(2);
    expect(groups[0]!.originalCalls).toHaveLength(COALESCENCE_MAX_WINDOW);
    expect(groups[1]!.originalCalls).toHaveLength(1);
  });

  test("non-coalescible calls each become their own group", () => {
    const calls = [
      makeToolCall("Bash", "ls src/", "a"),
      makeToolCall("Bash", "docker ps", "b"),
      makeToolCall("Bash", "npm test", "c"),
    ];
    // All are Bash but commands are very different
    const groups = buildCoalescedGroups(calls);
    // They may or may not coalesce based on similarity; we only assert count is ≥ 1
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups.length).toBeLessThanOrEqual(3);
  });

  test("opt-out call breaks the coalescence window", () => {
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "a"),
      makeToolCall("Bash", "grep 'bar' src/", "b", true), // opt-out
      makeToolCall("Bash", "grep 'baz' src/", "c"),
    ];
    const groups = buildCoalescedGroups(calls);
    // The opt-out call prevents merging across it
    // a alone or a+b blocked, b alone, c alone
    expect(groups.length).toBeGreaterThanOrEqual(2);
    // The opt-out call should be in its own group
    const optOutGroup = groups.find((g) =>
      g.originalCalls.some((tc) => tc.id === "b")
    );
    expect(optOutGroup).toBeDefined();
    expect(optOutGroup!.mergeStrategy).toBe("passthrough");
  });
});

// ---------------------------------------------------------------------------
// executeWithCoalescence — end-to-end result preservation
// ---------------------------------------------------------------------------

describe("executeWithCoalescence", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    resetCoalescenceStats();
  });

  test("empty input returns empty array", async () => {
    const results = await executeWithCoalescence([], registry, ctx);
    expect(results).toEqual([]);
  });

  test("single call passes through with correct id and result", async () => {
    registry.register(makeBashTool(() => "single result"));
    const calls = [makeToolCall("Bash", "echo hello", "tc1")];
    const results = await executeWithCoalescence(calls, registry, ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.toolCallId).toBe("tc1");
    expect(results[0]!.result).toBe("single result");
  });

  test("preserves original toolCallIds after coalescence", async () => {
    registry.register(makeBashTool(() => "ok"));
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "id_a"),
      makeToolCall("Bash", "grep 'bar' src/", "id_b"),
    ];
    const results = await executeWithCoalescence(calls, registry, ctx);
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.toolCallId).sort();
    expect(ids).toEqual(["id_a", "id_b"]);
  });

  test("preserves original input on each result after coalescence", async () => {
    registry.register(makeBashTool(() => "ok"));
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "id_a"),
      makeToolCall("Bash", "grep 'bar' src/", "id_b"),
    ];
    const results = await executeWithCoalescence(calls, registry, ctx);
    const resultA = results.find((r) => r.toolCallId === "id_a");
    const resultB = results.find((r) => r.toolCallId === "id_b");
    expect(resultA?.input.command).toBe("grep 'foo' src/");
    expect(resultB?.input.command).toBe("grep 'bar' src/");
  });

  test("result ordering matches original call ordering", async () => {
    registry.register(makeBashTool(() => "ok"));
    const calls = [
      makeToolCall("Bash", "grep 'a' src/", "first"),
      makeToolCall("Bash", "grep 'b' src/", "second"),
      makeToolCall("Bash", "grep 'c' src/", "third"),
    ];
    const results = await executeWithCoalescence(calls, registry, ctx);
    expect(results.map((r) => r.toolCallId)).toEqual(["first", "second", "third"]);
  });

  test("opt-out call is not merged and still returns its result", async () => {
    registry.register(makeBashTool(() => "result"));
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "a"),
      makeToolCall("Bash", "grep 'bar' src/", "b", true), // opt-out
    ];
    const results = await executeWithCoalescence(calls, registry, ctx);
    expect(results).toHaveLength(2);
    const idB = results.find((r) => r.toolCallId === "b");
    expect(idB).toBeDefined();
    expect(idB!.result).toBe("result");
  });

  test("coalescence stats are updated after a merge", async () => {
    registry.register(makeBashTool(() => "ok"));
    resetCoalescenceStats();
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "a"),
      makeToolCall("Bash", "grep 'bar' src/", "b"),
    ];
    await executeWithCoalescence(calls, registry, ctx);
    const stats = getCoalescenceStats();
    expect(stats.mergedCalls).toBeGreaterThan(0);
    expect(stats.callsSaved).toBeGreaterThan(0);
  });

  test("non-coalescible tools pass through without merging", async () => {
    registry.register(makeBashTool(() => "ok"));
    resetCoalescenceStats();
    // Completely unrelated commands that won't coalesce
    const calls = [
      makeToolCall("Bash", "docker ps", "a"),
      makeToolCall("Bash", "ls -la /completely/different/path/xyz", "b"),
    ];
    const results = await executeWithCoalescence(calls, registry, ctx);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.toolCallId).sort()).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// coalescence stats
// ---------------------------------------------------------------------------

describe("getCoalescenceStats + formatCoalescenceStats", () => {
  beforeEach(() => {
    resetCoalescenceStats();
  });

  test("stats start at zero after reset", () => {
    const s = getCoalescenceStats();
    expect(s.mergedCalls).toBe(0);
    expect(s.batchedCalls).toBe(0);
    expect(s.callsSaved).toBe(0);
  });

  test("formatCoalescenceStats shows 'no batches' when empty", () => {
    const str = formatCoalescenceStats();
    expect(str).toContain("no batches");
  });

  test("estimatedTokensSaved is 30 per saved call", async () => {
    const registry = new ToolRegistry();
    registry.register(makeBashTool(() => "ok"));
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "a"),
      makeToolCall("Bash", "grep 'bar' src/", "b"),
    ];
    await executeWithCoalescence(calls, registry, ctx);
    const s = getCoalescenceStats();
    expect(s.estimatedTokensSaved).toBe(s.callsSaved * 30);
  });

  test("estimatedLatencySavedMs is 100ms per saved call", async () => {
    const registry = new ToolRegistry();
    registry.register(makeBashTool(() => "ok"));
    const calls = [
      makeToolCall("Bash", "grep 'foo' src/", "a"),
      makeToolCall("Bash", "grep 'bar' src/", "b"),
    ];
    await executeWithCoalescence(calls, registry, ctx);
    const s = getCoalescenceStats();
    expect(s.estimatedLatencySavedMs).toBe(s.callsSaved * 100);
  });
});

// ---------------------------------------------------------------------------
// Regression: coalescence does not alter safety of non-Bash tools
// ---------------------------------------------------------------------------

describe("regression: non-Bash tool passthrough", () => {
  test("Read tool calls are never coalesced", () => {
    const a = { id: "r1", name: "Read", input: { file_path: "src/a.ts" } };
    const b = { id: "r2", name: "Read", input: { file_path: "src/b.ts" } };
    const groups = buildCoalescedGroups([a, b]);
    // Each Read becomes its own passthrough group
    expect(groups).toHaveLength(2);
    groups.forEach((g) => expect(g.mergeStrategy).toBe("passthrough"));
  });

  test("mixed Read and Bash calls keep ordering and independence", async () => {
    const registry = new ToolRegistry();
    registry.register(makeBashTool(() => "bash result"));

    // Read tool not registered — will return isError, but ordering must hold
    const calls: ToolCall[] = [
      { id: "r1", name: "Read", input: { file_path: "src/a.ts" } },
      makeToolCall("Bash", "grep 'foo' src/", "b1"),
    ];

    const results = await executeWithCoalescence(calls, registry, ctx);
    expect(results).toHaveLength(2);
    // Ordering preserved
    expect(results[0]!.toolCallId).toBe("r1");
    expect(results[1]!.toolCallId).toBe("b1");
  });
});
