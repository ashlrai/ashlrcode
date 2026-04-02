import { test, expect, describe } from "bun:test";
import { runPreToolHooks, runPostToolHooks } from "../config/hooks.ts";
import type { HooksConfig, HookDefinition } from "../config/hooks.ts";

describe("runPreToolHooks", () => {
  test("returns allow when no hooks are configured", async () => {
    const result = await runPreToolHooks({}, "Bash", { command: "ls" });
    expect(result.action).toBe("allow");
  });

  test("returns allow when no hooks match", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "Write", action: "deny" }],
    };
    const result = await runPreToolHooks(hooks, "Bash", {});
    expect(result.action).toBe("allow");
  });

  test("denies when exact toolName matches deny hook", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "Bash", action: "deny", message: "no bash" }],
    };
    const result = await runPreToolHooks(hooks, "Bash", {});
    expect(result.action).toBe("deny");
    expect(result.message).toBe("no bash");
  });

  test("allows when exact toolName matches allow hook", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "Read", action: "allow" }],
    };
    const result = await runPreToolHooks(hooks, "Read", {});
    expect(result.action).toBe("allow");
  });

  test("matches glob patterns in toolName", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "Bash*", action: "deny", message: "no bash" }],
    };
    const result = await runPreToolHooks(hooks, "BashTool", {});
    expect(result.action).toBe("deny");
  });

  test("matches wildcard * to any tool", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "*", action: "deny", message: "all blocked" }],
    };
    const result = await runPreToolHooks(hooks, "AnyTool", {});
    expect(result.action).toBe("deny");
    expect(result.message).toBe("all blocked");
  });

  test("matches inputPattern against serialized input", async () => {
    const hooks: HooksConfig = {
      preToolUse: [
        {
          inputPattern: "rm\\s+-rf",
          action: "deny",
          message: "dangerous command",
        },
      ],
    };
    const result = await runPreToolHooks(hooks, "Bash", {
      command: "rm -rf /",
    });
    expect(result.action).toBe("deny");
  });

  test("does not match inputPattern when pattern is absent from input", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ inputPattern: "rm\\s+-rf", action: "deny" }],
    };
    const result = await runPreToolHooks(hooks, "Bash", { command: "ls -la" });
    expect(result.action).toBe("allow");
  });

  test("matches when both toolName and inputPattern match", async () => {
    const hooks: HooksConfig = {
      preToolUse: [
        {
          toolName: "Bash",
          inputPattern: "sudo",
          action: "deny",
          message: "no sudo",
        },
      ],
    };
    // Both match
    const result = await runPreToolHooks(hooks, "Bash", {
      command: "sudo rm foo",
    });
    expect(result.action).toBe("deny");

    // toolName matches but inputPattern doesn't
    const result2 = await runPreToolHooks(hooks, "Bash", { command: "ls" });
    expect(result2.action).toBe("allow");
  });

  test("hook with no toolName or inputPattern matches everything", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ action: "deny", message: "global deny" }],
    };
    const result = await runPreToolHooks(hooks, "AnyTool", {});
    expect(result.action).toBe("deny");
  });

  test("runs command-based hook and denies on non-zero exit", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "Bash", command: "exit 1" }],
    };
    const result = await runPreToolHooks(hooks, "Bash", {});
    expect(result.action).toBe("deny");
  });

  test("runs command-based hook and allows on zero exit", async () => {
    const hooks: HooksConfig = {
      preToolUse: [{ toolName: "Bash", command: "exit 0" }],
    };
    const result = await runPreToolHooks(hooks, "Bash", {});
    expect(result.action).toBe("allow");
  });
});

describe("runPostToolHooks", () => {
  test("runs without error with no hooks", async () => {
    // Should not throw
    await runPostToolHooks({}, "Bash", {}, "output");
  });

  test("runs without error with matching hook", async () => {
    const hooks: HooksConfig = {
      postToolUse: [{ toolName: "Bash", command: "true" }],
    };
    // Fire and forget, should not throw
    await runPostToolHooks(hooks, "Bash", {}, "output");
  });

  test("does not run hooks that don't match", async () => {
    const hooks: HooksConfig = {
      postToolUse: [{ toolName: "Write", command: "exit 1" }],
    };
    // Should not throw because the hook shouldn't match "Bash"
    await runPostToolHooks(hooks, "Bash", {}, "output");
  });
});
