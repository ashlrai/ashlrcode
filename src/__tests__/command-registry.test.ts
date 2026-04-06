import { test, expect, describe, beforeEach } from "bun:test";
import { CommandRegistry } from "../commands/registry.ts";
import type { Command, CommandContext, CommandCategory } from "../commands/types.ts";

/** Create a minimal mock command for testing. */
function mockCommand(overrides: Partial<Command> = {}): Command {
  return {
    name: overrides.name ?? "/test",
    aliases: overrides.aliases,
    description: overrides.description ?? "A test command",
    category: overrides.category ?? "other",
    subcommands: overrides.subcommands,
    handler: overrides.handler ?? (async () => true),
  };
}

/** Create a minimal mock command context. */
function mockCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    addOutput: overrides.addOutput ?? (() => {}),
    update: () => {},
    state: {} as any,
    getProcessing: () => false,
    setProcessing: () => {},
    getSpinnerText: () => "",
    setSpinnerText: () => {},
    runTurnInk: async () => {},
    getItems: () => [],
    backgroundOps: new Map(),
    getAutopilotLoop: () => null,
    setAutopilotLoop: () => {},
    getAutopilotRunning: () => false,
    setAutopilotRunning: () => {},
    getWorkQueue: () => ({} as any),
    getKairos: () => null,
    setKairos: () => {},
    getProductAgent: () => null,
    setProductAgent: () => {},
    getLastFullToolOutput: () => null,
    stripAnsi: (s: string) => s,
    buildCompactSummary: () => "",
    formatTimeAgo: () => "",
  };
}

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  describe("register", () => {
    test("register() adds a command", () => {
      const cmd = mockCommand({ name: "/help" });
      registry.register(cmd);
      expect(registry.get("/help")).toBe(cmd);
    });

    test("registerAll() adds multiple commands", () => {
      const cmds = [
        mockCommand({ name: "/help" }),
        mockCommand({ name: "/quit" }),
      ];
      registry.registerAll(cmds);
      expect(registry.get("/help")).toBeDefined();
      expect(registry.get("/quit")).toBeDefined();
    });
  });

  describe("get", () => {
    test("get() finds by name", () => {
      const cmd = mockCommand({ name: "/status" });
      registry.register(cmd);
      expect(registry.get("/status")).toBe(cmd);
    });

    test("get() finds by alias", () => {
      const cmd = mockCommand({ name: "/quit", aliases: ["/q", "/exit"] });
      registry.register(cmd);
      expect(registry.get("/q")).toBe(cmd);
      expect(registry.get("/exit")).toBe(cmd);
    });

    test("get() returns undefined for unregistered command", () => {
      expect(registry.get("/nope")).toBeUndefined();
    });
  });

  describe("dispatch", () => {
    test("dispatch() calls the correct handler", async () => {
      let called = false;
      registry.register(mockCommand({
        name: "/help",
        handler: async () => { called = true; return true; },
      }));
      const result = await registry.dispatch("/help", mockCtx());
      expect(result).toBe(true);
      expect(called).toBe(true);
    });

    test("dispatch() passes args correctly", async () => {
      let receivedArgs = "";
      registry.register(mockCommand({
        name: "/search",
        handler: async (args) => { receivedArgs = args; return true; },
      }));
      await registry.dispatch("/search hello world", mockCtx());
      expect(receivedArgs).toBe("hello world");
    });

    test("dispatch() returns false for unknown non-slash input", async () => {
      const result = await registry.dispatch("hello", mockCtx());
      expect(result).toBe(false);
    });

    test("dispatch() shows 'Unknown command' for unknown slash commands", async () => {
      let output = "";
      const ctx = mockCtx({ addOutput: (text: string) => { output = text; } });
      const result = await registry.dispatch("/nonexistent", ctx);
      expect(result).toBe(true);
      expect(output).toContain("Unknown command");
    });
  });

  describe("getAutocompleteList", () => {
    test("includes primary names and subcommands", () => {
      registry.register(mockCommand({
        name: "/autopilot",
        subcommands: ["scan", "auto"],
      }));
      const list = registry.getAutocompleteList();
      expect(list).toContain("/autopilot");
      expect(list).toContain("/autopilot scan");
      expect(list).toContain("/autopilot auto");
    });

    test("includes aliases", () => {
      registry.register(mockCommand({
        name: "/quit",
        aliases: ["/q", "/exit"],
      }));
      const list = registry.getAutocompleteList();
      expect(list).toContain("/quit");
      expect(list).toContain("/q");
      expect(list).toContain("/exit");
    });
  });

  describe("getByCategory", () => {
    test("groups commands correctly", () => {
      registry.register(mockCommand({ name: "/help", category: "other" }));
      registry.register(mockCommand({ name: "/plan", category: "workflow" }));
      registry.register(mockCommand({ name: "/status", category: "agent" }));
      registry.register(mockCommand({ name: "/tools", category: "agent" }));

      const groups = registry.getByCategory();
      expect(groups.get("other")?.length).toBe(1);
      expect(groups.get("workflow")?.length).toBe(1);
      expect(groups.get("agent")?.length).toBe(2);
    });

    test("deduplicates aliased commands", () => {
      registry.register(mockCommand({
        name: "/quit",
        aliases: ["/q"],
        category: "other",
      }));
      const groups = registry.getByCategory();
      // Should only appear once despite alias
      expect(groups.get("other")?.length).toBe(1);
    });
  });

  describe("formatHelp", () => {
    test("includes all categories that have commands", () => {
      registry.register(mockCommand({ name: "/help", category: "other", description: "Show help" }));
      registry.register(mockCommand({ name: "/plan", category: "workflow", description: "Plan mode" }));
      registry.register(mockCommand({ name: "/think", category: "agent", description: "Think deeply" }));

      const help = registry.formatHelp();
      expect(help).toContain("Other");
      expect(help).toContain("Workflow");
      expect(help).toContain("Agent Intelligence");
    });
  });
});
