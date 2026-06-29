/**
 * Tests for MCPFallbackManager — timeout scenarios, automatic substitution,
 * logging, retry helpers, and ToolRegistry integration.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  MCPFallbackManager,
  getMCPFallbackManager,
  resetMCPFallbackManager,
  serverNameFromTool,
  withMCPRetry,
  MAX_RETRIES,
} from "../mcp/fallback-manager.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): MCPFallbackManager {
  return new MCPFallbackManager();
}

function mockTool(name: string, opts: Partial<Tool> = {}): Tool {
  return {
    name,
    prompt: () => `Tool ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    validateInput: () => null,
    call: opts.call ?? (async () => `${name} result`),
    ...opts,
  };
}

function mockContext(): ToolContext {
  return {
    cwd: "/tmp",
    requestPermission: async () => true,
  };
}

// ---------------------------------------------------------------------------
// serverNameFromTool
// ---------------------------------------------------------------------------

describe("serverNameFromTool", () => {
  test("extracts server name from fully-qualified MCP tool", () => {
    expect(serverNameFromTool("mcp__claude-in-chrome__read_page")).toBe("claude-in-chrome");
    expect(serverNameFromTool("mcp__cursor__search")).toBe("cursor");
    expect(serverNameFromTool("mcp__plugin_ashlr_ashlr__ashlr__grep")).toBe("plugin_ashlr_ashlr");
  });

  test("returns empty string for non-MCP tool names", () => {
    expect(serverNameFromTool("Bash")).toBe("");
    expect(serverNameFromTool("WebFetch")).toBe("");
    expect(serverNameFromTool("Read")).toBe("");
  });

  test("returns empty string for partially-formed names", () => {
    expect(serverNameFromTool("mcp__onlyonepart")).toBe("");
    expect(serverNameFromTool("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// MCPFallbackManager — register / resolveFallback
// ---------------------------------------------------------------------------

describe("MCPFallbackManager.register / resolveFallback", () => {
  test("returns null for unknown tool", () => {
    const mgr = makeManager();
    expect(mgr.resolveFallback("mcp__unknown__tool")).toBeNull();
  });

  test("returns registered fallback", () => {
    const mgr = makeManager();
    mgr.register("mcp__claude-in-chrome__read_page", "WebFetch");
    expect(mgr.resolveFallback("mcp__claude-in-chrome__read_page")).toBe("WebFetch");
  });

  test("overwrites existing registration", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__nav", "WebFetch");
    mgr.register("mcp__chrome__nav", "Bash");
    expect(mgr.resolveFallback("mcp__chrome__nav")).toBe("Bash");
  });

  test("multiple tools can share the same fallback", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.register("mcp__chrome__navigate", "WebFetch");
    expect(mgr.resolveFallback("mcp__chrome__read_page")).toBe("WebFetch");
    expect(mgr.resolveFallback("mcp__chrome__navigate")).toBe("WebFetch");
  });
});

// ---------------------------------------------------------------------------
// MCPFallbackManager — recordFailure / isServerDegraded
// ---------------------------------------------------------------------------

describe("MCPFallbackManager.recordFailure", () => {
  test("single failure does not mark server degraded", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("timeout"));
    expect(mgr.isServerDegraded("mcp__chrome__read_page")).toBe(false);
  });

  test("two failures mark server as degraded", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("timeout 1"));
    mgr.recordFailure("mcp__chrome__read_page", new Error("timeout 2"));
    expect(mgr.isServerDegraded("mcp__chrome__read_page")).toBe(true);
  });

  test("degradation applies to all tools on the same server", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.register("mcp__chrome__navigate", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("err 1"));
    mgr.recordFailure("mcp__chrome__read_page", new Error("err 2"));
    // Both tools share "chrome" server
    expect(mgr.isServerDegraded("mcp__chrome__navigate")).toBe(true);
  });

  test("non-MCP tools are never degraded", () => {
    const mgr = makeManager();
    mgr.recordFailure("Bash", new Error("err"));
    mgr.recordFailure("Bash", new Error("err"));
    expect(mgr.isServerDegraded("Bash")).toBe(false);
  });

  test("getFailureRecord returns correct count and last error", () => {
    const mgr = makeManager();
    const err1 = new Error("first");
    const err2 = new Error("second");
    mgr.recordFailure("mcp__cursor__search", err1);
    mgr.recordFailure("mcp__cursor__search", err2);
    const rec = mgr.getFailureRecord("mcp__cursor__search");
    expect(rec).not.toBeNull();
    expect(rec!.count).toBe(2);
    expect(rec!.lastError).toBe(err2);
  });
});

// ---------------------------------------------------------------------------
// MCPFallbackManager — markServerHealthy / clearFailures
// ---------------------------------------------------------------------------

describe("MCPFallbackManager — recovery", () => {
  test("markServerHealthy clears degraded state", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("e1"));
    mgr.recordFailure("mcp__chrome__read_page", new Error("e2"));
    expect(mgr.isServerDegraded("mcp__chrome__read_page")).toBe(true);
    mgr.markServerHealthy("chrome");
    expect(mgr.isServerDegraded("mcp__chrome__read_page")).toBe(false);
  });

  test("clearFailures removes failure record but not server health", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("e"));
    mgr.clearFailures("mcp__chrome__read_page");
    expect(mgr.getFailureRecord("mcp__chrome__read_page")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff — retryDelayMs
// ---------------------------------------------------------------------------

describe("MCPFallbackManager.retryDelayMs", () => {
  test("returns 0 when no failures have been recorded", () => {
    const mgr = makeManager();
    expect(mgr.retryDelayMs("mcp__chrome__tool")).toBe(0);
  });

  test("returns 3000ms after first failure (attempt=0)", () => {
    const mgr = makeManager();
    mgr.recordFailure("mcp__chrome__tool", new Error("e1"));
    // attempt=0 → BASE * 2^0 = 3000
    expect(mgr.retryDelayMs("mcp__chrome__tool")).toBe(3_000);
  });

  test("doubles on second failure (attempt=1)", () => {
    const mgr = makeManager();
    mgr.recordFailure("mcp__chrome__tool", new Error("e1"));
    mgr.recordFailure("mcp__chrome__tool", new Error("e2"));
    // attempt=1 → BASE * 2^1 = 6000
    expect(mgr.retryDelayMs("mcp__chrome__tool")).toBe(6_000);
  });
});

// ---------------------------------------------------------------------------
// withMCPRetry helper
// ---------------------------------------------------------------------------

describe("withMCPRetry", () => {
  test("returns value immediately on first success", async () => {
    const failures: string[] = [];
    const result = await withMCPRetry(
      "mcp__chrome__tool",
      async () => "ok",
      (tool, _err, _attempt) => { failures.push(tool); }
    );
    expect(result).toBe("ok");
    expect(failures).toHaveLength(0);
  });

  test("retries once on first failure then succeeds", async () => {
    let calls = 0;
    const failures: number[] = [];
    const result = await withMCPRetry(
      "mcp__chrome__tool",
      async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
        return "recovered";
      },
      (_tool, _err, attempt) => { failures.push(attempt); },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBe(0); // attempt 0
  });

  test(`throws after ${MAX_RETRIES} failures`, async () => {
    let calls = 0;
    const failures: number[] = [];
    await expect(
      withMCPRetry(
        "mcp__chrome__tool",
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        (_tool, _err, attempt) => { failures.push(attempt); }
      )
    ).rejects.toThrow(`fail ${MAX_RETRIES}`);
    expect(calls).toBe(MAX_RETRIES);
    expect(failures).toHaveLength(MAX_RETRIES);
  });

  test("calls onFailure with the tool name and error", async () => {
    const recorded: Array<{ tool: string; msg: string }> = [];
    await expect(
      withMCPRetry(
        "mcp__cursor__search",
        async () => { throw new Error("boom"); },
        (tool, err) => { recorded.push({ tool, msg: err.message }); }
      )
    ).rejects.toThrow("boom");
    expect(recorded.every((r) => r.tool === "mcp__cursor__search")).toBe(true);
    expect(recorded.every((r) => r.msg === "boom")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Singleton — getMCPFallbackManager / resetMCPFallbackManager
// ---------------------------------------------------------------------------

describe("singleton", () => {
  afterEach(() => {
    resetMCPFallbackManager();
  });

  test("getMCPFallbackManager returns the same instance", () => {
    const a = getMCPFallbackManager();
    const b = getMCPFallbackManager();
    expect(a).toBe(b);
  });

  test("singleton comes pre-populated with default mappings", () => {
    const mgr = getMCPFallbackManager();
    expect(mgr.resolveFallback("mcp__claude-in-chrome__read_page")).toBe("WebFetch");
    expect(mgr.resolveFallback("mcp__cursor__search")).toBe("Grep");
    expect(mgr.resolveFallback("mcp__plugin_ashlr_ashlr__ashlr__grep")).toBe("Grep");
  });

  test("resetMCPFallbackManager creates a fresh instance", () => {
    const a = getMCPFallbackManager();
    resetMCPFallbackManager();
    const b = getMCPFallbackManager();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

describe("MCPFallbackManager.formatStatus", () => {
  test("shows healthy status for known servers with no failures", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    const output = mgr.formatStatus(["chrome"]);
    expect(output).toContain("chrome");
    expect(output).toContain("healthy");
  });

  test("shows degraded status after threshold failures", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("e1"));
    mgr.recordFailure("mcp__chrome__read_page", new Error("e2"));
    const output = mgr.formatStatus(["chrome"]);
    expect(output).toContain("degraded");
  });

  test("shows ACTIVE marker on fallback when server is degraded", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("e1"));
    mgr.recordFailure("mcp__chrome__read_page", new Error("e2"));
    const output = mgr.formatStatus([]);
    expect(output).toContain("ACTIVE");
  });

  test("shows failure count in matrix", () => {
    const mgr = makeManager();
    mgr.register("mcp__chrome__read_page", "WebFetch");
    mgr.recordFailure("mcp__chrome__read_page", new Error("e1"));
    const output = mgr.formatStatus([]);
    expect(output).toContain("1 fail");
  });

  test("shows 'No MCP servers configured' when list is empty and no failures", () => {
    const mgr = makeManager();
    const output = mgr.formatStatus([]);
    expect(output).toContain("No MCP servers configured");
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry integration — pre-execution fallback suggestion
// ---------------------------------------------------------------------------

describe("ToolRegistry — MCP fallback pre-execution check", () => {
  beforeEach(() => {
    resetMCPFallbackManager();
  });

  afterEach(() => {
    resetMCPFallbackManager();
  });

  test("passes through normally for healthy MCP tools (not registered in registry)", async () => {
    const registry = new ToolRegistry();
    // mcp__chrome__tool is unknown to registry but server is healthy — should
    // return unknown-tool error (not a fallback suggestion)
    const result = await registry.execute("mcp__chrome__tool", {}, mockContext());
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Unknown tool");
  });

  test("returns fallback suggestion when MCP server is degraded", async () => {
    // Manually degrade via the singleton
    const mgr = getMCPFallbackManager();
    mgr.recordFailure("mcp__claude-in-chrome__read_page", new Error("timeout 1"));
    mgr.recordFailure("mcp__claude-in-chrome__read_page", new Error("timeout 2"));

    const registry = new ToolRegistry();
    const result = await registry.execute(
      "mcp__claude-in-chrome__read_page",
      {},
      mockContext()
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("degraded");
    expect(result.result).toContain("WebFetch");
  });

  test("non-MCP tools bypass the fallback check entirely", async () => {
    const registry = new ToolRegistry();
    registry.register(mockTool("Bash", { call: async () => "bash ran" }));
    const result = await registry.execute("Bash", {}, mockContext());
    expect(result.isError).toBe(false);
    expect(result.result).toBe("bash ran");
  });

  test("degraded MCP tool without registered fallback returns unknown-tool error", async () => {
    const mgr = getMCPFallbackManager();
    // Degrade a tool that has no fallback registered
    mgr.recordFailure("mcp__mystery__tool", new Error("e1"));
    mgr.recordFailure("mcp__mystery__tool", new Error("e2"));

    const registry = new ToolRegistry();
    const result = await registry.execute("mcp__mystery__tool", {}, mockContext());
    // isServerDegraded is true but no fallback — falls through to unknown-tool
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Unknown tool");
  });
});
