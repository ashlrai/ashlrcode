/**
 * End-to-end smoke tests for AshlrCode CLI.
 *
 * Validates that the CLI can start up, parse flags, and that core modules
 * initialize correctly — all without making API calls or requiring keys.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Helpers ────────────────────────────────────────────────────────────

const CLI_PATH = join(import.meta.dir, "../cli.ts");
const SPAWN_TIMEOUT_MS = 10_000;

async function runCLI(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const timeout = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  return { stdout, stderr, exitCode };
}

// ── CLI flag tests ─────────────────────────────────────────────────────

describe("E2E Smoke: CLI flags", () => {
  test("--version outputs a version string", async () => {
    const { stdout, exitCode } = await runCLI(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^AshlrCode v\d+\.\d+\.\d+/);
  });

  test("-v outputs a version string", async () => {
    const { stdout, exitCode } = await runCLI(["-v"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^AshlrCode v\d+\.\d+\.\d+/);
  });

  test("--help outputs help text with expected sections", async () => {
    const { stdout, exitCode } = await runCLI(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("OPTIONS");
    expect(stdout).toContain("COMMANDS");
  });

  test("-h outputs help text", async () => {
    const { stdout, exitCode } = await runCLI(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });
});

// ── Module import tests ────────────────────────────────────────────────

describe("E2E Smoke: module imports", () => {
  test("cli.ts can be imported without errors", async () => {
    // Dynamic import validates that the module parses and its top-level
    // imports resolve. The module's main() is behind an iife guard, so
    // importing alone does not start the REPL.
    const mod = await import("../cli.ts");
    expect(mod).toBeDefined();
  });
});

// ── Tool registry tests ───────────────────────────────────────────────

describe("E2E Smoke: tool registry", () => {
  test("registry can be instantiated with all core tools", async () => {
    const { ToolRegistry } = await import("../tools/registry.ts");
    const registry = new ToolRegistry();

    // Import all the same tools that cli.ts registers
    const { bashTool } = await import("../tools/bash.ts");
    const { fileReadTool } = await import("../tools/file-read.ts");
    const { fileWriteTool } = await import("../tools/file-write.ts");
    const { fileEditTool } = await import("../tools/file-edit.ts");
    const { globTool } = await import("../tools/glob.ts");
    const { grepTool } = await import("../tools/grep.ts");
    const { askUserTool } = await import("../tools/ask-user.ts");
    const { webFetchTool } = await import("../tools/web-fetch.ts");
    const { enterPlanTool, exitPlanTool, planWriteTool } = await import("../planning/plan-tools.ts");
    const { agentTool } = await import("../tools/agent.ts");
    const { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } = await import("../tools/tasks.ts");
    const { lsTool } = await import("../tools/ls.ts");
    const { configTool } = await import("../tools/config.ts");
    const { enterWorktreeTool, exitWorktreeTool } = await import("../tools/worktree.ts");
    const { webSearchTool } = await import("../tools/web-search.ts");
    const { toolSearchTool } = await import("../tools/tool-search.ts");
    const { memorySaveTool, memoryListTool, memoryDeleteTool } = await import("../tools/memory.ts");
    const { notebookEditTool } = await import("../tools/notebook-edit.ts");
    const { sendMessageTool, checkMessagesTool } = await import("../tools/send-message.ts");
    const { sleepTool } = await import("../tools/sleep.ts");
    const { todoWriteTool } = await import("../tools/todo-write.ts");
    const { diffTool } = await import("../tools/diff.ts");
    const { snipTool } = await import("../tools/snip.ts");
    const { lspTool } = await import("../tools/lsp.ts");
    const { teamCreateTool, teamDeleteTool, teamListTool, teamDispatchTool } = await import("../tools/team.ts");
    const { workflowTool } = await import("../tools/workflow.ts");
    const { listPeersTool } = await import("../tools/peers.ts");
    const { verifyTool } = await import("../tools/verify.ts");
    const { coordinateTool } = await import("../tools/coordinate.ts");

    const tools = [
      bashTool, fileReadTool, fileWriteTool, fileEditTool, globTool,
      grepTool, askUserTool, webFetchTool, enterPlanTool, exitPlanTool,
      planWriteTool, agentTool, taskCreateTool, taskUpdateTool, taskListTool,
      taskGetTool, lsTool, configTool, enterWorktreeTool, exitWorktreeTool,
      webSearchTool, toolSearchTool, memorySaveTool, memoryListTool,
      memoryDeleteTool, notebookEditTool, sendMessageTool, checkMessagesTool,
      sleepTool, todoWriteTool, diffTool, snipTool, lspTool,
      teamCreateTool, teamDeleteTool, teamListTool, teamDispatchTool,
      workflowTool, listPeersTool, verifyTool, coordinateTool,
    ];

    for (const tool of tools) {
      registry.register(tool);
    }

    const allTools = registry.getAll();
    expect(allTools.length).toBeGreaterThanOrEqual(41);

    // Spot-check a few well-known tools are present
    expect(registry.get("Bash")).toBeDefined();
    expect(registry.get("Read")).toBeDefined();
    expect(registry.get("Write")).toBeDefined();
    expect(registry.get("Edit")).toBeDefined();
    expect(registry.get("Glob")).toBeDefined();
    expect(registry.get("Grep")).toBeDefined();
  });
});

// ── Settings tests ────────────────────────────────────────────────────

describe("E2E Smoke: settings", () => {
  test("loadSettings returns an object with providers", async () => {
    const { loadSettings } = await import("../config/settings.ts");
    const settings = await loadSettings();
    expect(settings).toBeDefined();
    expect(settings.providers).toBeDefined();
    expect(typeof settings.providers).toBe("object");
  });
});

// ── Session persistence tests ─────────────────────────────────────────

describe("E2E Smoke: session lifecycle", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ashlrcode-e2e-smoke-"));
  });

  afterEach(() => {
    const { setConfigDirForTests } = require("../config/settings.ts");
    setConfigDirForTests(null);
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  test("create session, append messages, load and verify", async () => {
    const { setConfigDirForTests } = await import("../config/settings.ts");
    const { Session } = await import("../persistence/session.ts");

    setConfigDirForTests(configDir);

    const session = new Session("smoke-test");
    await session.init("test-provider", "test-model");

    // Append a user message and an assistant message
    await session.appendMessage({ role: "user", content: "Hello from smoke test" });
    await session.appendMessage({ role: "assistant", content: "Hello back!" });
    await session.flush();

    // Load messages and verify
    const messages = await session.loadMessages();
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Hello from smoke test");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("Hello back!");

    // Verify file was created on disk
    const sessionFile = join(configDir, "sessions", "smoke-test.jsonl");
    expect(existsSync(sessionFile)).toBe(true);
  });
});
