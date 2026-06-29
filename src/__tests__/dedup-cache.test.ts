/**
 * Tests for src/agent/dedup-cache.ts
 *
 * Coverage:
 * 1. Read-only tools are deduplicated
 * 2. Bash (and other skip-listed tools) are NOT deduplicated
 * 3. Cache survives sub-agent creation (dedupCache propagated via AgentContext)
 * 4. Manual flush() clears entries
 * 5. Turn-boundary flush clears entries
 * 6. Cache key is stable for semantically identical inputs (different key order)
 * 7. Cache key differs when inputs differ
 * 8. TTL expiry evicts entries
 * 9. LRU eviction when maxSize reached
 * 10. Invalidation after file write clears Read/Grep/Glob entries
 * 11. Stats track hits/misses/msSaved
 * 12. formatDedupStats returns a non-empty string
 * 13. DedupCache.shouldDedup correctly classifies tools
 * 14. Integration: executeToolCalls deduplicates identical Read calls
 * 15. Integration: executeToolCalls does NOT deduplicate Bash calls
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  DedupCache,
  dedupKey,
  DEDUP_SKIP_TOOLS,
  DEDUP_ALWAYS_TOOLS,
  DEDUP_TTL_MS,
  getGlobalDedupCache,
  setGlobalDedupCache,
  flushGlobalDedupCache,
  resetGlobalDedupCache,
  formatDedupStats,
} from "../agent/dedup-cache.ts";
import {
  runWithAgentContext,
  createChildContext,
  getAgentContext,
  type AgentContext,
} from "../agent/async-context.ts";
import { executeToolCalls, resetToolMetrics } from "../agent/tool-executor.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadOnlyTool(name: string, result = "tool-result", callCount?: { n: number }): Tool {
  return {
    name,
    prompt: () => `${name} tool`,
    inputSchema: () => ({ type: "object", properties: {} }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    validateInput: () => null,
    call: async () => {
      if (callCount) callCount.n++;
      return result;
    },
  };
}

function makeWriteTool(name: string, result = "write-result", callCount?: { n: number }): Tool {
  return {
    name,
    prompt: () => `${name} tool`,
    inputSchema: () => ({ type: "object", properties: {} }),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    validateInput: () => null,
    call: async () => {
      if (callCount) callCount.n++;
      return result;
    },
  };
}

function makeToolCall(name: string, input: Record<string, unknown> = {}, id?: string): ToolCall {
  return { id: id ?? `call_${name}_${Math.random()}`, name, input };
}

const ctx: ToolContext = {
  cwd: "/test/cwd",
  requestPermission: async () => true,
  sessionId: "test-session",
};

// ---------------------------------------------------------------------------
// Unit tests — DedupCache class
// ---------------------------------------------------------------------------

describe("DedupCache — basic get/set", () => {
  let cache: DedupCache;

  beforeEach(() => {
    cache = new DedupCache();
  });

  test("returns null on miss", () => {
    const result = cache.get("Read", { file_path: "/foo.ts" }, "/cwd");
    expect(result).toBeNull();
  });

  test("returns cached value on hit after set", () => {
    cache.set("Read", { file_path: "/foo.ts" }, "/cwd", "file contents", 50);
    const result = cache.get("Read", { file_path: "/foo.ts" }, "/cwd");
    expect(result).toBe("file contents");
  });

  test("miss for different file path", () => {
    cache.set("Read", { file_path: "/foo.ts" }, "/cwd", "foo", 10);
    const result = cache.get("Read", { file_path: "/bar.ts" }, "/cwd");
    expect(result).toBeNull();
  });

  test("miss for different cwd", () => {
    cache.set("Read", { file_path: "/foo.ts" }, "/cwd-a", "foo", 10);
    const result = cache.get("Read", { file_path: "/foo.ts" }, "/cwd-b");
    expect(result).toBeNull();
  });
});

describe("DedupCache — semantic key stability", () => {
  let cache: DedupCache;

  beforeEach(() => {
    cache = new DedupCache();
  });

  test("Read: key ignores default offset/limit when omitted", () => {
    cache.set("Read", { file_path: "/a.ts" }, "/cwd", "content", 5);
    // With explicit defaults — should still hit
    const r = cache.get("Read", { file_path: "/a.ts", offset: 0, limit: null }, "/cwd");
    expect(r).toBe("content");
  });

  test("Grep: semantically identical inputs hit regardless of key order", () => {
    const inputA = { pattern: "export", path: "/src", case_sensitive: true, glob: "" };
    const inputB = { glob: "", case_sensitive: true, path: "/src", pattern: "export" };
    const keyA = dedupKey("Grep", inputA, "/cwd");
    const keyB = dedupKey("Grep", inputB, "/cwd");
    expect(keyA).toBe(keyB);
  });

  test("Glob: keys differ for different patterns", () => {
    const k1 = dedupKey("Glob", { pattern: "**/*.ts" }, "/cwd");
    const k2 = dedupKey("Glob", { pattern: "**/*.js" }, "/cwd");
    expect(k1).not.toBe(k2);
  });

  test("default tool: key is order-independent (sorted keys)", () => {
    const k1 = dedupKey("LS", { path: "/src", extra: "x" }, "/cwd");
    const k2 = dedupKey("LS", { extra: "x", path: "/src" }, "/cwd");
    expect(k1).toBe(k2);
  });
});

describe("DedupCache — TTL expiry", () => {
  test("expired entry returns null", async () => {
    const cache = new DedupCache(10 /* 10ms TTL */);
    cache.set("Read", { file_path: "/f.ts" }, "/cwd", "val", 5);
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 20));
    const result = cache.get("Read", { file_path: "/f.ts" }, "/cwd");
    expect(result).toBeNull();
  });

  test("non-expired entry still returns value", async () => {
    const cache = new DedupCache(500 /* 500ms TTL */);
    cache.set("Read", { file_path: "/f.ts" }, "/cwd", "val", 5);
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get("Read", { file_path: "/f.ts" }, "/cwd")).toBe("val");
  });
});

describe("DedupCache — LRU eviction", () => {
  test("evicts LRU entry when maxSize exceeded", () => {
    const cache = new DedupCache(DEDUP_TTL_MS, 3);
    cache.set("Read", { file_path: "/a.ts" }, "/", "a", 1);
    cache.set("Read", { file_path: "/b.ts" }, "/", "b", 1);
    cache.set("Read", { file_path: "/c.ts" }, "/", "c", 1);
    // Access /a to make it recently used
    cache.get("Read", { file_path: "/a.ts" }, "/");
    // Insert /d — should evict /b (LRU)
    cache.set("Read", { file_path: "/d.ts" }, "/", "d", 1);
    expect(cache.get("Read", { file_path: "/b.ts" }, "/")).toBeNull();
    expect(cache.get("Read", { file_path: "/a.ts" }, "/")).toBe("a");
    expect(cache.get("Read", { file_path: "/d.ts" }, "/")).toBe("d");
  });
});

describe("DedupCache — flush", () => {
  test("flush() clears all entries", () => {
    const cache = new DedupCache();
    cache.set("Read", { file_path: "/a.ts" }, "/", "a", 1);
    cache.set("Grep", { pattern: "foo", path: "/", glob: "", case_sensitive: true }, "/", "g", 1);
    cache.flush();
    expect(cache.get("Read", { file_path: "/a.ts" }, "/")).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });

  test("flush() preserves accumulated stats", () => {
    const cache = new DedupCache();
    cache.set("Read", { file_path: "/a.ts" }, "/", "a", 100);
    cache.get("Read", { file_path: "/a.ts" }, "/"); // hit
    cache.flush();
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.totalMsSaved).toBe(100);
  });
});

describe("DedupCache — invalidation", () => {
  test("invalidateForFile removes matching Read entry", () => {
    const cache = new DedupCache();
    cache.set("Read", { file_path: "/src/foo.ts" }, "/cwd", "content", 10);
    cache.invalidateForFile("/src/foo.ts");
    expect(cache.get("Read", { file_path: "/src/foo.ts" }, "/cwd")).toBeNull();
  });

  test("invalidateForFile removes all Grep entries (conservative)", () => {
    const cache = new DedupCache();
    cache.set("Grep", { pattern: "foo", path: "/", glob: "", case_sensitive: true }, "/", "r", 5);
    cache.invalidateForFile("/any/file.ts");
    expect(cache.get("Grep", { pattern: "foo", path: "/", glob: "", case_sensitive: true }, "/")).toBeNull();
  });

  test("invalidateForFile removes all Glob entries", () => {
    const cache = new DedupCache();
    cache.set("Glob", { pattern: "**/*.ts", cwd: "" }, "/", "files", 3);
    cache.invalidateForFile("/any/file.ts");
    expect(cache.get("Glob", { pattern: "**/*.ts", cwd: "" }, "/")).toBeNull();
  });

  test("invalidateForFile does not remove unrelated Read entries", () => {
    const cache = new DedupCache();
    cache.set("Read", { file_path: "/other.ts" }, "/cwd", "other-content", 10);
    cache.invalidateForFile("/src/foo.ts");
    // /other.ts should still be present
    expect(cache.get("Read", { file_path: "/other.ts" }, "/cwd")).toBe("other-content");
  });
});

describe("DedupCache — shouldDedup", () => {
  test("Bash is never deduplicated", () => {
    expect(DedupCache.shouldDedup("Bash", false)).toBe(false);
    expect(DedupCache.shouldDedup("Bash", true)).toBe(false);
  });

  test("AskUser is never deduplicated", () => {
    expect(DedupCache.shouldDedup("AskUser", true)).toBe(false);
  });

  test("WebSearch is never deduplicated", () => {
    expect(DedupCache.shouldDedup("WebSearch", true)).toBe(false);
  });

  test("Read is always deduplicated", () => {
    expect(DedupCache.shouldDedup("Read", true)).toBe(true);
    expect(DedupCache.shouldDedup("Read", false)).toBe(true);
  });

  test("Grep is always deduplicated", () => {
    expect(DedupCache.shouldDedup("Grep", true)).toBe(true);
  });

  test("Glob is always deduplicated", () => {
    expect(DedupCache.shouldDedup("Glob", true)).toBe(true);
  });

  test("unknown read-only tool is deduplicated", () => {
    expect(DedupCache.shouldDedup("CustomReadTool", true)).toBe(true);
  });

  test("unknown write tool is NOT deduplicated", () => {
    expect(DedupCache.shouldDedup("CustomWriteTool", false)).toBe(false);
  });
});

describe("DedupCache — stats", () => {
  test("tracks hits and misses", () => {
    const cache = new DedupCache();
    cache.get("Read", { file_path: "/x.ts" }, "/"); // miss
    cache.set("Read", { file_path: "/x.ts" }, "/", "val", 80);
    cache.get("Read", { file_path: "/x.ts" }, "/"); // hit
    cache.get("Read", { file_path: "/x.ts" }, "/"); // hit
    const s = cache.getStats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.totalMsSaved).toBe(160); // 2 hits × 80ms each
  });

  test("summary string mentions hits and ms saved", () => {
    const cache = new DedupCache();
    cache.set("Read", { file_path: "/x.ts" }, "/", "val", 50);
    cache.get("Read", { file_path: "/x.ts" }, "/"); // hit
    const s = cache.getStats();
    expect(s.summary).toMatch(/1 hit/);
    expect(s.summary).toMatch(/50 ms saved/);
  });

  test("summary shows 0 hits when empty", () => {
    const cache = new DedupCache();
    expect(cache.getStats().summary).toBe("dedup cache: 0 hits");
  });
});

// ---------------------------------------------------------------------------
// Global cache helpers
// ---------------------------------------------------------------------------

describe("global dedup cache", () => {
  afterEach(() => {
    resetGlobalDedupCache();
  });

  test("getGlobalDedupCache lazily creates a cache", () => {
    const c = getGlobalDedupCache();
    expect(c).toBeInstanceOf(DedupCache);
  });

  test("setGlobalDedupCache replaces the instance", () => {
    const custom = new DedupCache(100);
    setGlobalDedupCache(custom);
    expect(getGlobalDedupCache()).toBe(custom);
  });

  test("flushGlobalDedupCache flushes the current instance", () => {
    const c = getGlobalDedupCache();
    c.set("Read", { file_path: "/f.ts" }, "/", "v", 10);
    flushGlobalDedupCache();
    expect(c.get("Read", { file_path: "/f.ts" }, "/")).toBeNull();
  });

  test("formatDedupStats returns non-empty string", () => {
    getGlobalDedupCache(); // ensure initialized
    const s = formatDedupStats();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
  });

  test("formatDedupStats returns 'not initialized' when reset", () => {
    resetGlobalDedupCache();
    expect(formatDedupStats()).toMatch(/not initialized/);
  });
});

// ---------------------------------------------------------------------------
// AgentContext propagation — cache survives sub-agent creation
// ---------------------------------------------------------------------------

describe("AgentContext propagation", () => {
  test("dedupCache is inherited by child context", () => {
    const cache = new DedupCache();
    const parentCtx: AgentContext = {
      agentId: "parent-1",
      agentName: "parent",
      cwd: "/cwd",
      readOnly: false,
      depth: 0,
      startedAt: new Date().toISOString(),
      dedupCache: cache,
    };

    const childCtx = createChildContext(parentCtx, "child", "/cwd", true);
    expect(childCtx.dedupCache).toBe(cache);
  });

  test("child agent sees parent's cached values via AgentContext", () => {
    const cache = new DedupCache();
    cache.set("Read", { file_path: "/shared.ts" }, "/cwd", "shared-content", 20);

    const parentCtx: AgentContext = {
      agentId: "parent-2",
      agentName: "parent",
      cwd: "/cwd",
      readOnly: false,
      depth: 0,
      startedAt: new Date().toISOString(),
      dedupCache: cache,
    };

    let childSawCache: DedupCache | undefined;
    runWithAgentContext(parentCtx, () => {
      const childCtx = createChildContext(getAgentContext(), "child", "/cwd", true);
      runWithAgentContext(childCtx, () => {
        childSawCache = getAgentContext()?.dedupCache;
      });
    });

    expect(childSawCache).toBe(cache);
    expect(childSawCache?.get("Read", { file_path: "/shared.ts" }, "/cwd")).toBe("shared-content");
  });

  test("child context without parent has no dedupCache", () => {
    const childCtx = createChildContext(null, "orphan", "/cwd", true);
    expect(childCtx.dedupCache).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration — executeToolCalls deduplication
// ---------------------------------------------------------------------------

describe("executeToolCalls deduplication integration", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    resetToolMetrics();
    resetGlobalDedupCache();
  });

  afterEach(() => {
    resetGlobalDedupCache();
  });

  test("identical Read calls are deduplicated — tool.call() called only once", async () => {
    const callCount = { n: 0 };
    registry.register(makeReadOnlyTool("Read", "file-content", callCount));

    // Set up a dedup cache in the global slot
    const cache = new DedupCache();
    setGlobalDedupCache(cache);

    const input = { file_path: "/src/utils.ts" };
    const call1: ToolCall = { id: "c1", name: "Read", input };
    const call2: ToolCall = { id: "c2", name: "Read", input };

    // First call — executes the tool
    const [r1] = await executeToolCalls([call1], registry, ctx);
    expect(r1!.result).toBe("file-content");
    expect(callCount.n).toBe(1);

    // Second call with identical input — should come from dedup cache
    const [r2] = await executeToolCalls([call2], registry, ctx);
    expect(r2!.result).toBe("file-content");
    // tool.call() must NOT have been invoked a second time
    expect(callCount.n).toBe(1);

    const stats = cache.getStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  test("Bash calls are NOT deduplicated — tool.call() invoked every time", async () => {
    const callCount = { n: 0 };
    // Register Bash as a write tool (not read-only) — matches real Bash
    registry.register(makeWriteTool("Bash", "cmd-output", callCount));

    const cache = new DedupCache();
    setGlobalDedupCache(cache);

    const input = { command: "bun test" };
    const call1: ToolCall = { id: "b1", name: "Bash", input };
    const call2: ToolCall = { id: "b2", name: "Bash", input };

    await executeToolCalls([call1], registry, ctx);
    await executeToolCalls([call2], registry, ctx);

    // Bash must never be deduplicated
    expect(callCount.n).toBe(2);
    expect(cache.getStats().hits).toBe(0);
  });

  test("different Read inputs produce separate cache entries", async () => {
    const callCountA = { n: 0 };
    const callCountB = { n: 0 };

    const readTool: Tool = {
      name: "Read",
      prompt: () => "read",
      inputSchema: () => ({ type: "object", properties: {} }),
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      validateInput: () => null,
      call: async (input) => {
        if (input.file_path === "/a.ts") { callCountA.n++; return "content-a"; }
        callCountB.n++;
        return "content-b";
      },
    };
    registry.register(readTool);

    const cache = new DedupCache();
    setGlobalDedupCache(cache);

    const callA: ToolCall = { id: "ca", name: "Read", input: { file_path: "/a.ts" } };
    const callB: ToolCall = { id: "cb", name: "Read", input: { file_path: "/b.ts" } };

    const [rA] = await executeToolCalls([callA], registry, ctx);
    const [rB] = await executeToolCalls([callB], registry, ctx);

    expect(rA!.result).toBe("content-a");
    expect(rB!.result).toBe("content-b");
    expect(callCountA.n).toBe(1);
    expect(callCountB.n).toBe(1);
  });

  test("cache is flushed between turns via flushGlobalDedupCache", async () => {
    const callCount = { n: 0 };
    registry.register(makeReadOnlyTool("Read", "fresh-content", callCount));

    const cache = new DedupCache();
    setGlobalDedupCache(cache);

    const input = { file_path: "/turn-boundary.ts" };
    const call1: ToolCall = { id: "t1", name: "Read", input };

    await executeToolCalls([call1], registry, ctx);
    expect(callCount.n).toBe(1);

    // Simulate turn boundary flush
    flushGlobalDedupCache();

    const call2: ToolCall = { id: "t2", name: "Read", input };
    await executeToolCalls([call2], registry, ctx);
    // After flush, cache is empty — tool must be re-executed
    expect(callCount.n).toBe(2);
  });
});
