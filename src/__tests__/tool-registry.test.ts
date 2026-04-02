import { test, expect, describe, beforeEach } from "bun:test";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { HooksConfig } from "../config/hooks.ts";

/** Create a minimal mock tool for testing. */
function mockTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? "MockTool",
    prompt: () => "A mock tool",
    inputSchema: () => ({ type: "object", properties: {} }),
    isReadOnly: () => overrides.isReadOnly?.() ?? false,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    validateInput: overrides.validateInput ?? (() => null),
    call: overrides.call ?? (async () => "mock result"),
  };
}

function mockContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/tmp",
    requestPermission: overrides.requestPermission ?? (async () => true),
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register and get", () => {
    test("registers and retrieves a tool", () => {
      const tool = mockTool({ name: "Bash" });
      registry.register(tool);
      expect(registry.get("Bash")).toBe(tool);
    });

    test("returns undefined for unregistered tool", () => {
      expect(registry.get("DoesNotExist")).toBeUndefined();
    });

    test("getAll returns all registered tools", () => {
      registry.register(mockTool({ name: "A" }));
      registry.register(mockTool({ name: "B" }));
      expect(registry.getAll()).toHaveLength(2);
    });

    test("overwriting a tool with the same name replaces it", () => {
      const tool1 = mockTool({ name: "T", call: async () => "v1" });
      const tool2 = mockTool({ name: "T", call: async () => "v2" });
      registry.register(tool1);
      registry.register(tool2);
      expect(registry.get("T")).toBe(tool2);
    });
  });

  describe("getDefinitions", () => {
    test("returns tool definitions for all tools", () => {
      registry.register(mockTool({ name: "Read" }));
      const defs = registry.getDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0]!.name).toBe("Read");
    });

    test("getReadOnlyDefinitions filters to read-only tools", () => {
      registry.register(mockTool({ name: "Read", isReadOnly: () => true }));
      registry.register(mockTool({ name: "Write", isReadOnly: () => false }));
      const readOnly = registry.getReadOnlyDefinitions();
      expect(readOnly).toHaveLength(1);
      expect(readOnly[0]!.name).toBe("Read");
    });
  });

  describe("execute", () => {
    test("returns error for unknown tool", async () => {
      const result = await registry.execute("Nope", {}, mockContext());
      expect(result.isError).toBe(true);
      expect(result.result).toContain("Unknown tool");
    });

    test("returns validation error when validateInput fails", async () => {
      registry.register(
        mockTool({ name: "Bad", validateInput: () => "missing required field" })
      );
      const result = await registry.execute("Bad", {}, mockContext());
      expect(result.isError).toBe(true);
      expect(result.result).toContain("Validation error");
    });

    test("executes tool and returns result on success", async () => {
      registry.register(
        mockTool({ name: "Good", call: async () => "hello world" })
      );
      const result = await registry.execute("Good", {}, mockContext());
      expect(result.isError).toBe(false);
      expect(result.result).toBe("hello world");
    });

    test("catches thrown errors from tool.call", async () => {
      registry.register(
        mockTool({
          name: "Throws",
          call: async () => {
            throw new Error("boom");
          },
        })
      );
      const result = await registry.execute("Throws", {}, mockContext());
      expect(result.isError).toBe(true);
      expect(result.result).toContain("boom");
    });

    test("skips permission check for read-only tools", async () => {
      let permissionRequested = false;
      registry.register(
        mockTool({ name: "Viewer", isReadOnly: () => true, call: async () => "data" })
      );
      const ctx = mockContext({
        requestPermission: async () => {
          permissionRequested = true;
          return false; // Would deny if called
        },
      });
      const result = await registry.execute("Viewer", {}, ctx);
      expect(result.isError).toBe(false);
      expect(permissionRequested).toBe(false);
    });

    test("denies execution when permission is refused", async () => {
      registry.register(mockTool({ name: "Write" }));
      const ctx = mockContext({ requestPermission: async () => false });
      const result = await registry.execute("Write", {}, ctx);
      expect(result.isError).toBe(true);
      expect(result.result).toContain("Permission denied");
    });
  });

  describe("hook integration", () => {
    test("denies when pre-hook returns deny action", async () => {
      registry.register(mockTool({ name: "Bash" }));
      registry.setHooks({
        preToolUse: [
          { toolName: "Bash", action: "deny", message: "blocked by policy" },
        ],
      });
      const result = await registry.execute("Bash", {}, mockContext());
      expect(result.isError).toBe(true);
      expect(result.result).toContain("blocked by policy");
    });

    test("allows when pre-hook returns allow action", async () => {
      registry.register(
        mockTool({ name: "Bash", call: async () => "ran ok" })
      );
      registry.setHooks({
        preToolUse: [{ toolName: "Bash", action: "allow" }],
      });
      const result = await registry.execute("Bash", {}, mockContext());
      expect(result.isError).toBe(false);
      expect(result.result).toBe("ran ok");
    });
  });
});
