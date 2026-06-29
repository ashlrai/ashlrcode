/**
 * Tests for Multi-Provider Tool Capability Registry & Auto-Fallback.
 *
 * Covers:
 * - canExecute() for all support levels
 * - getBestProvider() ranking, cost-preference, filtering
 * - Cost multiplier tracking
 * - Substitute / fallback chains
 * - checkToolCapability() and logCapabilityMismatch() helpers
 * - Unknown tool handling
 * - Provider switch scenarios
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  CapabilityRegistry,
  globalCapabilityRegistry,
  type ToolCapability,
  type ProviderId,
} from "../providers/capability-registry.ts";
import {
  checkToolCapability,
  checkAllCapabilities,
  logCapabilityMismatch,
  type CapabilityCheckOutput,
} from "../tools/capability-check.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  toolName: string,
  overrides: Partial<ToolCapability> = {}
): ToolCapability {
  return {
    toolName,
    category: "utility",
    support: {},
    costMultipliers: {},
    substitutes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CapabilityRegistry unit tests
// ---------------------------------------------------------------------------

describe("CapabilityRegistry", () => {
  let reg: CapabilityRegistry;

  beforeEach(() => {
    reg = new CapabilityRegistry();
  });

  // ── register / get ────────────────────────────────────────────────────────

  test("registers and retrieves an entry", () => {
    const entry = makeEntry("Bash");
    reg.register(entry);
    expect(reg.get("Bash")).toBe(entry);
  });

  test("returns undefined for unknown tool", () => {
    expect(reg.get("DoesNotExist")).toBeUndefined();
  });

  test("overwriting an entry replaces it", () => {
    reg.register(makeEntry("Read", { category: "filesystem" }));
    reg.register(makeEntry("Read", { category: "web" }));
    expect(reg.get("Read")?.category).toBe("web");
  });

  test("allToolNames returns all registered names", () => {
    reg.register(makeEntry("A"));
    reg.register(makeEntry("B"));
    reg.register(makeEntry("C"));
    expect(reg.allToolNames().sort()).toEqual(["A", "B", "C"]);
  });

  test("byCategory filters correctly", () => {
    reg.register(makeEntry("Read", { category: "filesystem" }));
    reg.register(makeEntry("Bash", { category: "execution" }));
    reg.register(makeEntry("Grep", { category: "filesystem" }));
    const fs = reg.byCategory("filesystem");
    expect(fs.map((e) => e.toolName).sort()).toEqual(["Grep", "Read"]);
  });

  // ── canExecute ────────────────────────────────────────────────────────────

  test("canExecute returns true for native support", () => {
    reg.register(
      makeEntry("Read", { support: { anthropic: "native" } })
    );
    const result = reg.canExecute("Read", "anthropic");
    expect(result.canExecute).toBe(true);
    expect(result.supportLevel).toBe("native");
  });

  test("canExecute returns true for via-mcp support", () => {
    reg.register(
      makeEntry("WebSearch", { support: { ollama: "via-mcp" } })
    );
    const result = reg.canExecute("WebSearch", "ollama");
    expect(result.canExecute).toBe(true);
    expect(result.supportLevel).toBe("via-mcp");
  });

  test("canExecute returns true for emulated support", () => {
    reg.register(
      makeEntry("Edit", { support: { groq: "emulated" } })
    );
    const result = reg.canExecute("Edit", "groq");
    expect(result.canExecute).toBe(true);
    expect(result.supportLevel).toBe("emulated");
  });

  test("canExecute returns false for unsupported", () => {
    reg.register(
      makeEntry("Coordinate", {
        support: { ollama: "unsupported" },
        substitutes: ["Agent"],
      })
    );
    const result = reg.canExecute("Coordinate", "ollama");
    expect(result.canExecute).toBe(false);
    expect(result.supportLevel).toBe("unsupported");
    expect(result.alternatives).toEqual(["Agent"]);
  });

  test("canExecute defaults to native when provider absent from map", () => {
    reg.register(makeEntry("Bash", { support: {} }));
    const result = reg.canExecute("Bash", "deepseek");
    expect(result.canExecute).toBe(true);
    expect(result.supportLevel).toBe("native");
  });

  test("canExecute returns false for unknown tool", () => {
    const result = reg.canExecute("GhostTool", "anthropic");
    expect(result.canExecute).toBe(false);
    expect(result.reason).toMatch(/not registered/);
  });

  // ── cost multipliers ──────────────────────────────────────────────────────

  test("costMultiplier returns 1.0 when not set", () => {
    reg.register(makeEntry("Bash", { support: { xai: "native" } }));
    const result = reg.canExecute("Bash", "xai");
    expect(result.costMultiplier).toBe(1.0);
  });

  test("costMultiplier reflects configured value", () => {
    reg.register(
      makeEntry("Vision", {
        support: { anthropic: "native" },
        costMultipliers: { anthropic: 1.5 },
      })
    );
    const result = reg.canExecute("Vision", "anthropic");
    expect(result.costMultiplier).toBe(1.5);
  });

  test("via-mcp tools carry correct cost multiplier", () => {
    reg.register(
      makeEntry("WebSearch", {
        support: { ollama: "via-mcp" },
        costMultipliers: { ollama: 1.2 },
      })
    );
    const result = reg.canExecute("WebSearch", "ollama");
    expect(result.costMultiplier).toBe(1.2);
  });

  // ── getBestProvider ───────────────────────────────────────────────────────

  test("getBestProvider returns native provider over emulated", () => {
    reg.register(
      makeEntry("Edit", {
        support: {
          anthropic: "native",
          ollama: "emulated",
        },
      })
    );
    const result = reg.getBestProvider("Edit");
    expect(result.provider).toBe("anthropic");
    expect(result.supportLevel).toBe("native");
  });

  test("getBestProvider returns null when all providers unsupported", () => {
    reg.register(
      makeEntry("UltraSpecial", {
        support: {
          anthropic: "unsupported",
          xai: "unsupported",
          openai: "unsupported",
          ollama: "unsupported",
          groq: "unsupported",
          deepseek: "unsupported",
        },
      })
    );
    const result = reg.getBestProvider("UltraSpecial");
    expect(result.provider).toBeNull();
  });

  test("getBestProvider preferLowestCost breaks rank ties by cost", () => {
    reg.register(
      makeEntry("Bash", {
        support: {
          anthropic: "native",
          xai: "native",
          openai: "native",
          // Explicitly mark other providers unsupported so they don't sneak in
          // as cost-0 "native" defaults and beat xai's 1.1.
          ollama: "unsupported",
          groq: "unsupported",
          deepseek: "unsupported",
        },
        costMultipliers: {
          anthropic: 1.3,
          xai: 1.1,
          openai: 1.2,
        },
      })
    );
    const result = reg.getBestProvider("Bash", { preferLowestCost: true });
    expect(result.provider).toBe("xai");
    expect(result.costMultiplier).toBe(1.1);
  });

  test("getBestProvider exclude filter removes providers", () => {
    reg.register(
      makeEntry("Read", {
        support: { anthropic: "native", xai: "native" },
      })
    );
    const result = reg.getBestProvider("Read", { exclude: ["anthropic"] });
    expect(result.provider).toBe("xai");
  });

  test("getBestProvider include filter restricts to listed providers", () => {
    reg.register(
      makeEntry("Read", {
        support: {
          anthropic: "native",
          xai: "native",
          groq: "native",
        },
      })
    );
    const result = reg.getBestProvider("Read", {
      include: ["groq", "xai"],
    });
    expect(["groq", "xai"]).toContain(result.provider);
  });

  test("getBestProvider returns null with empty include list after filter", () => {
    reg.register(makeEntry("Read", { support: { anthropic: "native" } }));
    const result = reg.getBestProvider("Read", { include: ["groq"] });
    // groq has no support entry → defaults to native → should be selected
    expect(result.provider).toBe("groq");
  });

  test("getBestProvider returns null for unknown tool", () => {
    const result = reg.getBestProvider("FakeTool");
    expect(result.provider).toBeNull();
    expect(result.reason).toMatch(/not registered/);
  });

  // ── getSubstitutes ────────────────────────────────────────────────────────

  test("getSubstitutes returns empty list when canExecute", () => {
    reg.register(
      makeEntry("Bash", { support: { anthropic: "native" } })
    );
    expect(reg.getSubstitutes("Bash", "anthropic")).toEqual([]);
  });

  test("getSubstitutes returns substitutes when unsupported", () => {
    reg.register(
      makeEntry("WebBrowser", {
        support: { ollama: "unsupported" },
        substitutes: ["WebFetch"],
      })
    );
    expect(reg.getSubstitutes("WebBrowser", "ollama")).toEqual(["WebFetch"]);
  });
});

// ---------------------------------------------------------------------------
// Global registry smoke tests
// ---------------------------------------------------------------------------

describe("globalCapabilityRegistry", () => {
  test("has at least 42 tool entries", () => {
    expect(globalCapabilityRegistry.allToolNames().length).toBeGreaterThanOrEqual(42);
  });

  test("Read is native on anthropic", () => {
    const result = globalCapabilityRegistry.canExecute("Read", "anthropic");
    expect(result.canExecute).toBe(true);
    expect(result.supportLevel).toBe("native");
  });

  test("Vision has 1.5x cost multiplier on anthropic", () => {
    const result = globalCapabilityRegistry.canExecute("Vision", "anthropic");
    expect(result.costMultiplier).toBe(1.5);
  });

  test("WebBrowser is unsupported on ollama and suggests WebFetch", () => {
    const result = globalCapabilityRegistry.canExecute("WebBrowser", "ollama");
    expect(result.canExecute).toBe(false);
    expect(result.alternatives).toContain("WebFetch");
  });

  test("Coordinate is unsupported on deepseek and suggests Agent", () => {
    const result = globalCapabilityRegistry.canExecute("Coordinate", "deepseek");
    expect(result.canExecute).toBe(false);
    expect(result.alternatives).toContain("Agent");
  });

  test("getBestProvider for Vision excludes groq (unsupported)", () => {
    const result = globalCapabilityRegistry.getBestProvider("Vision", {
      include: ["groq"],
    });
    expect(result.provider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkToolCapability helper
// ---------------------------------------------------------------------------

describe("checkToolCapability", () => {
  test("returns optimistic pass when no provider given", () => {
    const result = checkToolCapability("Bash");
    expect(result.canExecute).toBe(true);
    expect(result.supportLevel).toBe("native");
  });

  test("delegates to globalCapabilityRegistry when provider given", () => {
    const direct = globalCapabilityRegistry.canExecute("Read", "anthropic");
    const helper = checkToolCapability("Read", "anthropic");
    expect(helper.canExecute).toBe(direct.canExecute);
    expect(helper.supportLevel).toBe(direct.supportLevel);
  });

  test("checkAllCapabilities returns map with one entry per tool", () => {
    const tools = ["Read", "Write", "Bash"];
    const map = checkAllCapabilities(tools, "anthropic");
    expect(map.size).toBe(3);
    for (const name of tools) {
      expect(map.has(name)).toBe(true);
    }
  });

  test("checkAllCapabilities marks unsupported correctly in batch", () => {
    const map = checkAllCapabilities(["WebBrowser", "Read"], "ollama");
    expect(map.get("WebBrowser")?.canExecute).toBe(false);
    expect(map.get("Read")?.canExecute).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// logCapabilityMismatch — stderr output
// ---------------------------------------------------------------------------

describe("logCapabilityMismatch", () => {
  test("does not write for native tools", () => {
    const original = process.stderr.write.bind(process.stderr);
    const messages: string[] = [];
    (process.stderr as any).write = (msg: string) => {
      messages.push(msg);
      return true;
    };

    const nativeResult: CapabilityCheckOutput = {
      canExecute: true,
      supportLevel: "native",
      costMultiplier: 1.0,
      reason: "native",
      alternatives: [],
    };
    logCapabilityMismatch("Bash", "anthropic", nativeResult);
    (process.stderr as any).write = original;

    expect(messages).toHaveLength(0);
  });

  test("writes DEGRADED for emulated support", () => {
    const original = process.stderr.write.bind(process.stderr);
    const messages: string[] = [];
    (process.stderr as any).write = (msg: string) => {
      messages.push(msg);
      return true;
    };

    const emulated: CapabilityCheckOutput = {
      canExecute: true,
      supportLevel: "emulated",
      costMultiplier: 1.1,
      reason: "emulated on ollama",
      alternatives: [],
    };
    logCapabilityMismatch("Edit", "ollama", emulated);
    (process.stderr as any).write = original;

    expect(messages[0]).toMatch(/DEGRADED/);
    expect(messages[0]).toMatch(/Edit/);
  });

  test("writes BLOCKED for unsupported with alternatives", () => {
    const original = process.stderr.write.bind(process.stderr);
    const messages: string[] = [];
    (process.stderr as any).write = (msg: string) => {
      messages.push(msg);
      return true;
    };

    const blocked: CapabilityCheckOutput = {
      canExecute: false,
      supportLevel: "unsupported",
      costMultiplier: 1.0,
      reason: "not supported",
      alternatives: ["WebFetch"],
    };
    logCapabilityMismatch("WebBrowser", "ollama", blocked);
    (process.stderr as any).write = original;

    expect(messages[0]).toMatch(/BLOCKED/);
    expect(messages[0]).toMatch(/WebFetch/);
  });
});
