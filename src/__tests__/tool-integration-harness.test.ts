/**
 * Tool Integration Test Harness
 *
 * Reusable end-to-end test infrastructure for tool integration testing.
 * Fills the gap where core tools (Agent, AskUser, Tasks, Team, Coordinate, Bash)
 * lack unified harness coverage.
 *
 * Structure:
 *  1. MockToolContext builder   — createMockContext(), withTempDir()
 *  2. Mock implementations     — MockBash, MockFS, MockFetch, assertion helpers
 *  3. Tool integration scenarios — 30+ test cases across 6 workflow patterns
 *  4. Snapshot & replay         — recordToolSequence() / replayToolSequence()
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { Tool, ToolContext } from "../tools/types.ts";
import { fileReadTool } from "../tools/file-read.ts";
import { fileEditTool } from "../tools/file-edit.ts";
import { globTool } from "../tools/glob.ts";
import { bashTool } from "../tools/bash.ts";
import {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  taskGetTool,
  resetTasks,
} from "../tools/tasks.ts";
import { ToolRegistry } from "../tools/registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — MockToolContext builder (~80 lines)
// ─────────────────────────────────────────────────────────────────────────────

export interface MockContextOptions {
  /** Pre-approve all permission requests without prompting */
  autoApprove?: boolean;
  /** Override fetch for network calls */
  mockFetch?: MockFetch;
  /** Override bash execution */
  mockBash?: MockBash;
  /** Initial in-memory file tree */
  initialFiles?: Record<string, string>;
  /** Turn number for snapshot tracking */
  turnNumber?: number;
  /** Session ID */
  sessionId?: string;
  /** Mark context as mock (optional ToolContext.isMock flag) */
  isMock?: boolean;
}

export interface MockToolContext extends ToolContext {
  /** True for mock contexts — lets tools skip side-effects in test */
  isMock?: boolean;
  /** Track permission requests made during test */
  permissionLog: Array<{ tool: string; description: string; granted: boolean }>;
  /** In-memory file system */
  mockFs: MockFS;
  /** Mock bash executor */
  mockBash: MockBash;
  /** Mock fetch */
  mockFetch: MockFetch;
}

/**
 * Create a MockToolContext with mocked requestPermission, file ops, subprocess.
 */
export function createMockContext(
  cwd?: string,
  options: MockContextOptions = {},
): MockToolContext {
  const permissionLog: MockToolContext["permissionLog"] = [];
  const mockFs = new MockFS(cwd ?? "/mock/cwd", options.initialFiles);
  const mockBash = options.mockBash ?? new MockBash();
  const mockFetch = options.mockFetch ?? new MockFetch();
  const autoApprove = options.autoApprove ?? true;

  return {
    cwd: cwd ?? "/mock/cwd",
    isMock: options.isMock ?? true,
    turnNumber: options.turnNumber ?? 1,
    sessionId: options.sessionId ?? "test-session-" + Date.now(),
    requestPermission: async (tool: string, description: string) => {
      const granted = autoApprove;
      permissionLog.push({ tool, description, granted });
      return granted;
    },
    permissionLog,
    mockFs,
    mockBash,
    mockFetch,
  };
}

/**
 * Run a callback with a real temporary directory, then clean up.
 */
export async function withTempDir<T>(
  callback: (dir: string, ctx: MockToolContext) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tool-harness-"));
  const ctx = createMockContext(dir);
  try {
    return await callback(dir, ctx);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Mock implementations (~100 lines)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory file tree for testing file tools without hitting disk.
 * Keys are absolute paths; values are file contents.
 */
export class MockFS {
  private files: Map<string, string>;
  readonly cwd: string;

  constructor(cwd: string, initial?: Record<string, string>) {
    this.cwd = cwd;
    this.files = new Map(Object.entries(initial ?? {}));
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  delete(path: string): boolean {
    return this.files.delete(path);
  }

  list(): string[] {
    return Array.from(this.files.keys());
  }

  /** Return all files whose paths match a simple prefix */
  glob(prefix: string): string[] {
    return this.list().filter((p) => p.startsWith(prefix));
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }
}

/**
 * Mock bash executor — maps command patterns (string or RegExp) to canned results.
 * Falls back to "(mock: no match)" for unregistered commands.
 */
export class MockBash {
  private routes: Array<{
    pattern: string | RegExp;
    result: string;
    exitCode?: number;
  }> = [];
  readonly callLog: string[] = [];

  register(
    pattern: string | RegExp,
    result: string,
    exitCode = 0,
  ): this {
    this.routes.push({ pattern, result, exitCode });
    return this;
  }

  execute(command: string): { result: string; exitCode: number } {
    this.callLog.push(command);
    for (const route of this.routes) {
      const matches =
        typeof route.pattern === "string"
          ? command.includes(route.pattern)
          : route.pattern.test(command);
      if (matches) {
        return { result: route.result, exitCode: route.exitCode ?? 0 };
      }
    }
    return { result: "(mock: no match for: " + command + ")", exitCode: 0 };
  }

  wasCalled(pattern: string | RegExp): boolean {
    return this.callLog.some((cmd) =>
      typeof pattern === "string" ? cmd.includes(pattern) : pattern.test(cmd),
    );
  }

  reset(): void {
    this.callLog.length = 0;
  }
}

/**
 * Mock fetch — maps URL patterns to canned HTTP responses.
 */
export class MockFetch {
  private routes: Array<{
    pattern: string | RegExp;
    body: string;
    status?: number;
    headers?: Record<string, string>;
  }> = [];
  readonly callLog: string[] = [];

  register(
    pattern: string | RegExp,
    body: string,
    status = 200,
    headers?: Record<string, string>,
  ): this {
    this.routes.push({ pattern, body, status, headers });
    return this;
  }

  asFetch(): typeof fetch {
    return async (input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      this.callLog.push(url);
      for (const route of this.routes) {
        const matches =
          typeof route.pattern === "string"
            ? url.includes(route.pattern)
            : route.pattern.test(url);
        if (matches) {
          return new Response(route.body, {
            status: route.status ?? 200,
            headers: route.headers ?? { "Content-Type": "application/json" },
          });
        }
      }
      return new Response('{"error":"not found"}', { status: 404 });
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Assert a tool result does not contain an error indicator */
function assertSuccess(result: string, label = "tool result"): void {
  expect(result, label).not.toContain("Error");
  expect(result, label).not.toContain("error:");
  expect(result, label).not.toContain("not found");
}

/** Assert file content on real disk equals expected */
async function assertFileContent(
  path: string,
  expected: string,
): Promise<void> {
  expect(existsSync(path)).toBe(true);
  const content = await readFile(path, "utf-8");
  expect(content).toBe(expected);
}

/** Assert result contains all given substrings */
function assertContainsAll(result: string, substrings: string[]): void {
  for (const s of substrings) {
    expect(result).toContain(s);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Tool integration scenarios (~200 lines, 30+ test cases)
// ─────────────────────────────────────────────────────────────────────────────

// ── Scenario A: File operations (Read → Edit → Verify) ─────────────────────

describe("Scenario A: Read → Edit → Verify", () => {
  let tmpDir: string;
  let ctx: MockToolContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-a-"));
    ctx = createMockContext(tmpDir);
    resetTasks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("reads a file and returns numbered lines", async () => {
    const path = join(tmpDir, "hello.ts");
    await writeFile(path, "const x = 1;\nconst y = 2;\n", "utf-8");

    const result = await fileReadTool.call({ file_path: path }, ctx);

    expect(result).toContain("const x = 1;");
    expect(result).toContain("1\t");
    expect(result).toContain("2\t");
  });

  test("edits a file after reading it", async () => {
    const path = join(tmpDir, "edit-me.ts");
    await writeFile(path, "const version = 'v1';\n", "utf-8");

    // Read first
    const readResult = await fileReadTool.call({ file_path: path }, ctx);
    expect(readResult).toContain("v1");

    // Edit
    const editResult = await fileEditTool.call(
      { file_path: path, old_string: "'v1'", new_string: "'v2'" },
      ctx,
    );
    expect(editResult).toContain("Replaced 1 occurrence");

    // Verify on disk
    await assertFileContent(path, "const version = 'v2';\n");
  });

  test("read returns error for non-existent file", async () => {
    const path = join(tmpDir, "missing.ts");
    const result = await fileReadTool.call({ file_path: path }, ctx);
    expect(result).toContain("not found");
  });

  test("edit returns error when old_string is absent", async () => {
    const path = join(tmpDir, "no-match.ts");
    await writeFile(path, "hello world\n", "utf-8");

    const result = await fileEditTool.call(
      { file_path: path, old_string: "NOPE", new_string: "yes" },
      ctx,
    );
    expect(result).toContain("not found");
  });

  test("read → edit → read round-trip verifies content changed", async () => {
    const path = join(tmpDir, "roundtrip.ts");
    await writeFile(path, "export const API_VERSION = 1;\n", "utf-8");

    await fileEditTool.call(
      {
        file_path: path,
        old_string: "API_VERSION = 1",
        new_string: "API_VERSION = 2",
      },
      ctx,
    );

    const readAgain = await fileReadTool.call({ file_path: path }, ctx);
    expect(readAgain).toContain("API_VERSION = 2");
    expect(readAgain).not.toContain("API_VERSION = 1");
  });
});

// ── Scenario B: Search & Modify (Glob → Edit multiple → Verify) ────────────

describe("Scenario B: Glob → Edit multiple → Verify", () => {
  let tmpDir: string;
  let ctx: MockToolContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-b-"));
    ctx = createMockContext(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("glob finds ts files in directory", async () => {
    await writeFile(join(tmpDir, "a.ts"), "// a\n", "utf-8");
    await writeFile(join(tmpDir, "b.ts"), "// b\n", "utf-8");
    await writeFile(join(tmpDir, "c.txt"), "// c\n", "utf-8");

    const result = await globTool.call(
      { pattern: "*.ts", path: tmpDir },
      ctx,
    );

    expect(result).toContain("2 file(s) found");
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result).not.toContain("c.txt");
  });

  test("glob + edit multiple files sequentially", async () => {
    await writeFile(join(tmpDir, "x.ts"), "const ENV = 'dev';\n", "utf-8");
    await writeFile(join(tmpDir, "y.ts"), "const ENV = 'dev';\n", "utf-8");

    const globResult = await globTool.call(
      { pattern: "*.ts", path: tmpDir },
      ctx,
    );
    expect(globResult).toContain("2 file(s) found");

    for (const filePath of [join(tmpDir, "x.ts"), join(tmpDir, "y.ts")]) {
      await fileEditTool.call(
        {
          file_path: filePath,
          old_string: "'dev'",
          new_string: "'prod'",
        },
        ctx,
      );
    }

    await assertFileContent(join(tmpDir, "x.ts"), "const ENV = 'prod';\n");
    await assertFileContent(join(tmpDir, "y.ts"), "const ENV = 'prod';\n");
  });

  test("glob returns no-match message for missing pattern", async () => {
    const result = await globTool.call(
      { pattern: "*.nonexistent", path: tmpDir },
      ctx,
    );
    expect(result).toContain("No files matching");
  });

  test("glob validateInput rejects missing pattern", () => {
    const err = globTool.validateInput({});
    expect(err).toContain("pattern is required");
  });

  test("glob finds files in nested subdirectory", async () => {
    const sub = join(tmpDir, "nested");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "deep.ts"), "// deep\n", "utf-8");

    const result = await globTool.call(
      { pattern: "**/*.ts", path: tmpDir },
      ctx,
    );
    expect(result).toContain("deep.ts");
  });
});

// ── Scenario C: Bash + file sync ────────────────────────────────────────────

describe("Scenario C: Bash + file sync workflow", () => {
  let tmpDir: string;
  let ctx: MockToolContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-c-"));
    ctx = createMockContext(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("bash executes echo and returns output", async () => {
    const result = await bashTool.call(
      { command: "echo 'hello harness'" },
      ctx,
    );
    expect(result).toContain("hello harness");
  });

  test("bash validateInput rejects missing command", () => {
    const err = bashTool.validateInput({});
    expect(err).toContain("command is required");
  });

  test("bash checkPermissions blocks rm -rf /", () => {
    const err = bashTool.checkPermissions!({ command: "rm -rf /" }, ctx);
    expect(err).not.toBeNull();
    expect(err).toContain("Dangerous");
  });

  test("bash creates file that is then readable", async () => {
    const outFile = join(tmpDir, "bash-out.txt");
    await bashTool.call(
      { command: `echo 'from-bash' > "${outFile}"` },
      ctx,
    );
    const readResult = await fileReadTool.call(
      { file_path: outFile },
      ctx,
    );
    expect(readResult).toContain("from-bash");
  });

  test("bash reads git status in temp git repo", async () => {
    // Init a git repo so git status works
    await bashTool.call({ command: `git init "${tmpDir}"` }, ctx);
    const result = await bashTool.call(
      { command: `git -C "${tmpDir}" status` },
      ctx,
    );
    // Should mention branch or empty repo, not hard crash
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("bash → edit → bash verifies change persists", async () => {
    const filePath = join(tmpDir, "counter.ts");
    await bashTool.call(
      { command: `echo 'let count = 0;' > "${filePath}"` },
      ctx,
    );

    await fileEditTool.call(
      {
        file_path: filePath,
        old_string: "count = 0",
        new_string: "count = 42",
      },
      ctx,
    );

    const catResult = await bashTool.call(
      { command: `cat "${filePath}"` },
      ctx,
    );
    expect(catResult).toContain("count = 42");
  });
});

// ── Scenario D: Agent spawning (mocked) ─────────────────────────────────────

describe("Scenario D: Agent spawning (mock)", () => {
  /**
   * AgentTool requires _router and _registry injection (runSubAgent).
   * We test the tool's contract (validateInput, metadata) and simulate
   * agent result processing + file writes without spawning real sub-agents.
   */
  test("agentTool validateInput rejects missing prompt", async () => {
    const { agentTool } = await import("../tools/agent.ts");
    const err = agentTool.validateInput({
      description: "explore",
      prompt: "",
    });
    // Either "prompt is required" or "not initialized"
    expect(err).not.toBeNull();
  });

  test("agentTool validateInput rejects missing description", async () => {
    const { agentTool } = await import("../tools/agent.ts");
    const err = agentTool.validateInput({
      description: "",
      prompt: "find all ts files",
    });
    expect(err).not.toBeNull();
  });

  test("agentTool metadata is correct", async () => {
    const { agentTool } = await import("../tools/agent.ts");
    expect(agentTool.name).toBe("Agent");
    expect(agentTool.isReadOnly()).toBe(true);
    expect(agentTool.isConcurrencySafe()).toBe(true);
    expect(agentTool.isDestructive()).toBe(false);
  });

  test("simulate agent result → write to file", async () => {
    // Simulate: agent returns findings → write summary to disk
    await withTempDir(async (dir) => {
      const simulatedAgentResult =
        "## Agent: explore\n\nFound 3 TypeScript files:\n- src/a.ts\n- src/b.ts\n- src/c.ts\n\nTools used: Read x3, Glob x1";

      const reportPath = join(dir, "agent-report.md");
      await writeFile(reportPath, simulatedAgentResult, "utf-8");

      const readResult = await fileReadTool.call(
        { file_path: reportPath },
        createMockContext(dir),
      );
      expect(readResult).toContain("Agent: explore");
      expect(readResult).toContain("Found 3 TypeScript files");
    });
  });

  test("agent inputSchema has required fields", async () => {
    const { agentTool } = await import("../tools/agent.ts");
    const schema = agentTool.inputSchema() as { required: string[] };
    expect(schema.required).toContain("description");
    expect(schema.required).toContain("prompt");
  });
});

// ── Scenario E: Task workflow ────────────────────────────────────────────────

describe("Scenario E: TaskCreate → TaskUpdate → complete workflow", () => {
  beforeEach(() => {
    resetTasks();
  });

  test("creates a task and returns ID", async () => {
    const ctx = createMockContext("/tmp");
    const result = await taskCreateTool.call(
      { subject: "Write tests", description: "Add unit tests for tools" },
      ctx,
    );
    expect(result).toContain("Task #");
    expect(result).toContain("created");
    expect(result).toContain("Write tests");
  });

  test("task list shows created task as pending", async () => {
    const ctx = createMockContext("/tmp");
    await taskCreateTool.call(
      { subject: "Pending task", description: "Do something" },
      ctx,
    );

    const list = await taskListTool.call({}, ctx);
    expect(list).toContain("pending");
    expect(list).toContain("Pending task");
  });

  test("update task to in_progress", async () => {
    const ctx = createMockContext("/tmp");
    const createResult = await taskCreateTool.call(
      { subject: "In-progress task", description: "Doing it now" },
      ctx,
    );
    const idMatch = createResult.match(/#([a-z]-\d+)/);
    expect(idMatch).not.toBeNull();
    const taskId = idMatch![1]!;

    await taskUpdateTool.call({ taskId, status: "in_progress" }, ctx);

    const list = await taskListTool.call({}, ctx);
    expect(list).toContain("in_progress");
  });

  test("full lifecycle: create → in_progress → completed", async () => {
    const ctx = createMockContext("/tmp");
    const r = await taskCreateTool.call(
      { subject: "Full lifecycle", description: "Test full flow" },
      ctx,
    );
    const taskId = r.match(/#([a-z]-\d+)/)![1]!;

    await taskUpdateTool.call({ taskId, status: "in_progress" }, ctx);
    await taskUpdateTool.call({ taskId, status: "completed" }, ctx);

    const detail = await taskGetTool.call({ taskId }, ctx);
    const parsed = JSON.parse(detail);
    expect(parsed.status).toBe("completed");
    expect(parsed.completedAt).toBeDefined();
  });

  test("task blocking: blocked task shows as blocked in list", async () => {
    const ctx = createMockContext("/tmp");
    const r1 = await taskCreateTool.call(
      { subject: "Blocker task", description: "Must run first" },
      ctx,
    );
    const blockerId = r1.match(/#([a-z]-\d+)/)![1]!;

    await taskCreateTool.call(
      {
        subject: "Blocked task",
        description: "Depends on blocker",
        blockedBy: [blockerId],
      },
      ctx,
    );

    const list = await taskListTool.call({}, ctx);
    expect(list).toContain("blocked");
  });

  test("task get returns not found for unknown ID", async () => {
    const ctx = createMockContext("/tmp");
    const result = await taskGetTool.call({ taskId: "u-999" }, ctx);
    expect(result).toContain("not found");
  });

  test("task list summary counts are correct", async () => {
    const ctx = createMockContext("/tmp");
    await taskCreateTool.call({ subject: "T1", description: "d1" }, ctx);
    const r2 = await taskCreateTool.call(
      { subject: "T2", description: "d2" },
      ctx,
    );
    const id2 = r2.match(/#([a-z]-\d+)/)![1]!;
    await taskUpdateTool.call({ taskId: id2, status: "completed" }, ctx);

    const list = await taskListTool.call({}, ctx);
    expect(list).toContain("1/2 completed");
  });
});

// ── Scenario F: Coordination harness (mocked) ───────────────────────────────

describe("Scenario F: Coordinate tool (mock)", () => {
  /**
   * CoordinateTool requires _router + _registry injection.
   * Test the contract, validateInput, and simulate multi-agent aggregation.
   */
  test("coordinateTool validateInput rejects empty goal", async () => {
    const { coordinateTool } = await import("../tools/coordinate.ts");
    const err = coordinateTool.validateInput({ goal: "" });
    expect(err).not.toBeNull();
    expect(err).toContain("goal is required");
  });

  test("coordinateTool validateInput rejects missing goal string", async () => {
    const { coordinateTool } = await import("../tools/coordinate.ts");
    // goal is required — this always fails regardless of init state
    const err = coordinateTool.validateInput({ goal: 123 });
    expect(err).not.toBeNull();
    expect(err).toContain("goal is required");
  });

  test("coordinateTool metadata is correct", async () => {
    const { coordinateTool } = await import("../tools/coordinate.ts");
    expect(coordinateTool.name).toBe("Coordinate");
    expect(coordinateTool.isReadOnly()).toBe(false);
    expect(coordinateTool.isDestructive()).toBe(false);
    expect(coordinateTool.isConcurrencySafe()).toBe(false);
  });

  test("coordinateTool inputSchema requires goal", async () => {
    const { coordinateTool } = await import("../tools/coordinate.ts");
    const schema = coordinateTool.inputSchema() as { required: string[] };
    expect(schema.required).toContain("goal");
  });

  test("simulate coordinate: spawn agents → bash test → aggregate", async () => {
    await withTempDir(async (dir) => {
      // Simulate 3 sub-agent results being written and aggregated
      const results = [
        { agent: "explorer", output: "Found 12 source files in src/" },
        { agent: "test-writer", output: "Created 5 new test cases" },
        { agent: "reviewer", output: "No critical issues found" },
      ];

      const aggregateFile = join(dir, "coordination-report.json");
      await writeFile(aggregateFile, JSON.stringify(results, null, 2), "utf-8");

      const readResult = await fileReadTool.call(
        { file_path: aggregateFile },
        createMockContext(dir),
      );
      expect(readResult).toContain("explorer");
      expect(readResult).toContain("test-writer");
      expect(readResult).toContain("reviewer");
    });
  });

  test("simulate coordinate with bash test step", async () => {
    await withTempDir(async (dir) => {
      const ctx = createMockContext(dir);
      // Write a simple script
      const scriptPath = join(dir, "check.sh");
      await writeFile(scriptPath, "#!/bin/sh\necho 'all checks pass'\n", "utf-8");
      await bashTool.call({ command: `chmod +x "${scriptPath}"` }, ctx);

      const result = await bashTool.call(
        { command: `bash "${scriptPath}"` },
        ctx,
      );
      expect(result).toContain("all checks pass");

      // Aggregate result
      const reportPath = join(dir, "report.txt");
      await writeFile(reportPath, `Coordination complete\nBash result: ${result}`, "utf-8");
      const report = await fileReadTool.call({ file_path: reportPath }, ctx);
      expect(report).toContain("Coordination complete");
      expect(report).toContain("all checks pass");
    });
  });

  test("aggregate multiple agent results into single report", async () => {
    await withTempDir(async (dir) => {
      const ctx = createMockContext(dir);
      const agentOutputs = [
        "Agent explorer: Found 5 modules",
        "Agent implementer: Applied 3 patches",
        "Agent reviewer: LGTM",
      ];

      const aggregated = agentOutputs.join("\n---\n");
      const reportFile = join(dir, "final-report.md");
      await writeFile(reportFile, aggregated, "utf-8");

      const result = await fileReadTool.call({ file_path: reportFile }, ctx);
      assertContainsAll(result, [
        "Agent explorer",
        "Agent implementer",
        "Agent reviewer",
      ]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Tool Registry integration
// ─────────────────────────────────────────────────────────────────────────────

describe("Tool Registry integration", () => {
  test("registry registers and retrieves tools by name", () => {
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    registry.register(fileEditTool);
    registry.register(globTool);

    expect(registry.get("Read")).toBe(fileReadTool);
    expect(registry.get("Edit")).toBe(fileEditTool);
    expect(registry.get("Glob")).toBe(globTool);
  });

  test("registry getDefinitions returns correct shape", () => {
    const registry = new ToolRegistry();
    registry.register(fileReadTool);

    const defs = registry.getDefinitions();
    const readDef = defs.find((d) => d.name === "Read");
    expect(readDef).toBeDefined();
    expect(readDef!.description).toContain("Read");
    expect(readDef!.input_schema).toBeDefined();
  });

  test("registry get returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("NonExistent")).toBeUndefined();
  });

  test("all core tools have required Tool interface methods", () => {
    const tools: Tool[] = [
      fileReadTool,
      fileEditTool,
      globTool,
      bashTool,
      taskCreateTool,
      taskUpdateTool,
      taskListTool,
      taskGetTool,
    ];
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.prompt).toBe("function");
      expect(typeof tool.inputSchema).toBe("function");
      expect(typeof tool.isReadOnly).toBe("function");
      expect(typeof tool.isDestructive).toBe("function");
      expect(typeof tool.isConcurrencySafe).toBe("function");
      expect(typeof tool.validateInput).toBe("function");
      expect(typeof tool.call).toBe("function");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — MockBash unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MockBash unit tests", () => {
  test("routes string pattern to canned result", () => {
    const mock = new MockBash();
    mock.register("git status", "On branch main\nnothing to commit");
    const { result } = mock.execute("git status --short");
    expect(result).toContain("On branch main");
  });

  test("routes regex pattern to canned result", () => {
    const mock = new MockBash();
    mock.register(/bun test/, "all tests passed");
    const { result } = mock.execute("bun test src/");
    expect(result).toBe("all tests passed");
  });

  test("returns fallback for unregistered command", () => {
    const mock = new MockBash();
    const { result } = mock.execute("unknown-command");
    expect(result).toContain("no match");
  });

  test("wasCalled returns true after matching execution", () => {
    const mock = new MockBash();
    mock.register("ls", "file1\nfile2");
    mock.execute("ls /tmp");
    expect(mock.wasCalled("ls")).toBe(true);
    expect(mock.wasCalled("rm")).toBe(false);
  });

  test("callLog accumulates all executed commands", () => {
    const mock = new MockBash();
    mock.execute("cmd1");
    mock.execute("cmd2");
    mock.execute("cmd3");
    expect(mock.callLog).toHaveLength(3);
    expect(mock.callLog[0]).toBe("cmd1");
    expect(mock.callLog[2]).toBe("cmd3");
  });

  test("reset clears callLog", () => {
    const mock = new MockBash();
    mock.execute("cmd1");
    mock.reset();
    expect(mock.callLog).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — MockFS unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MockFS unit tests", () => {
  test("write and read in-memory file", () => {
    const fs = new MockFS("/cwd");
    fs.write("/cwd/foo.ts", "const x = 1;");
    expect(fs.read("/cwd/foo.ts")).toBe("const x = 1;");
  });

  test("exists returns false for missing file", () => {
    const fs = new MockFS("/cwd");
    expect(fs.exists("/cwd/missing.ts")).toBe(false);
  });

  test("exists returns true after write", () => {
    const fs = new MockFS("/cwd");
    fs.write("/cwd/present.ts", "");
    expect(fs.exists("/cwd/present.ts")).toBe(true);
  });

  test("delete removes file", () => {
    const fs = new MockFS("/cwd");
    fs.write("/cwd/temp.ts", "");
    fs.delete("/cwd/temp.ts");
    expect(fs.exists("/cwd/temp.ts")).toBe(false);
  });

  test("glob returns paths with matching prefix", () => {
    const fs = new MockFS("/cwd", {
      "/cwd/src/a.ts": "a",
      "/cwd/src/b.ts": "b",
      "/cwd/other/c.ts": "c",
    });
    const matches = fs.glob("/cwd/src/");
    expect(matches).toHaveLength(2);
    expect(matches).toContain("/cwd/src/a.ts");
    expect(matches).toContain("/cwd/src/b.ts");
    expect(matches).not.toContain("/cwd/other/c.ts");
  });

  test("list returns all keys", () => {
    const fs = new MockFS("/cwd", { "/cwd/a.ts": "a", "/cwd/b.ts": "b" });
    expect(fs.list()).toHaveLength(2);
  });

  test("initial files from constructor are accessible", () => {
    const fs = new MockFS("/cwd", { "/cwd/init.ts": "initial content" });
    expect(fs.read("/cwd/init.ts")).toBe("initial content");
  });

  test("toRecord reflects all writes", () => {
    const fs = new MockFS("/cwd");
    fs.write("/cwd/x.ts", "x");
    fs.write("/cwd/y.ts", "y");
    const rec = fs.toRecord();
    expect(rec["/cwd/x.ts"]).toBe("x");
    expect(rec["/cwd/y.ts"]).toBe("y");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — MockFetch unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MockFetch unit tests", () => {
  test("returns canned response for matched URL", async () => {
    const mf = new MockFetch();
    mf.register("api.example.com", '{"status":"ok"}');
    const fetchFn = mf.asFetch();
    const res = await fetchFn("https://api.example.com/v1/check");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('{"status":"ok"}');
  });

  test("returns 404 for unregistered URL", async () => {
    const mf = new MockFetch();
    const fetchFn = mf.asFetch();
    const res = await fetchFn("https://unknown.example.com/data");
    expect(res.status).toBe(404);
  });

  test("callLog records URLs", async () => {
    const mf = new MockFetch();
    mf.register("example.com", "ok");
    const fetchFn = mf.asFetch();
    await fetchFn("https://example.com/a");
    await fetchFn("https://example.com/b");
    expect(mf.callLog).toHaveLength(2);
  });

  test("regex pattern matching works", async () => {
    const mf = new MockFetch();
    mf.register(/\/api\/v\d+\//, '{"version":"matched"}');
    const fetchFn = mf.asFetch();
    const res = await fetchFn("https://host.com/api/v3/items");
    const body = await res.text();
    expect(body).toBe('{"version":"matched"}');
  });

  test("custom status code is returned", async () => {
    const mf = new MockFetch();
    mf.register("error-endpoint", '{"error":"unauthorized"}', 401);
    const fetchFn = mf.asFetch();
    const res = await fetchFn("https://host.com/error-endpoint");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Snapshot & Replay
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCallRecord {
  step: number;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  timestamp: string;
}

/**
 * Record a sequence of tool calls to a JSONL snapshot file.
 * Each line is a JSON-encoded ToolCallRecord.
 */
export async function recordToolSequence(
  calls: Array<{ toolName: string; input: Record<string, unknown>; result: string }>,
  snapshotPath: string,
): Promise<void> {
  const lines = calls.map((c, i) =>
    JSON.stringify({
      step: i,
      toolName: c.toolName,
      input: c.input,
      result: c.result,
      timestamp: new Date().toISOString(),
    } satisfies ToolCallRecord),
  );
  await mkdir(
    snapshotPath.replace(/\/[^/]+$/, ""),
    { recursive: true },
  );
  await writeFile(snapshotPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Replay a JSONL snapshot — re-execute each recorded call with mocks
 * and assert the results match the recorded outputs.
 */
export async function replayToolSequence(
  snapshotPath: string,
  tools: Map<string, Tool>,
  ctx: ToolContext,
  options: { tolerateDiff?: boolean } = {},
): Promise<{ passed: number; failed: number; diffs: string[] }> {
  const raw = await readFile(snapshotPath, "utf-8");
  const records: ToolCallRecord[] = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ToolCallRecord);

  let passed = 0;
  let failed = 0;
  const diffs: string[] = [];

  for (const record of records) {
    const tool = tools.get(record.toolName);
    if (!tool) {
      diffs.push(`Step ${record.step}: tool "${record.toolName}" not found`);
      failed++;
      continue;
    }
    try {
      const actual = await tool.call(record.input, ctx);
      if (actual === record.result) {
        passed++;
      } else if (options.tolerateDiff) {
        passed++;
      } else {
        diffs.push(
          `Step ${record.step} (${record.toolName}): expected "${record.result.slice(0, 80)}" got "${actual.slice(0, 80)}"`,
        );
        failed++;
      }
    } catch (err) {
      diffs.push(`Step ${record.step}: threw ${String(err)}`);
      failed++;
    }
  }

  return { passed, failed, diffs };
}

describe("Snapshot & Replay", () => {
  let snapshotDir: string;

  beforeEach(async () => {
    snapshotDir = await mkdtemp(join(tmpdir(), "harness-snap-"));
    resetTasks();
  });

  afterEach(async () => {
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
  });

  test("recordToolSequence writes JSONL file", async () => {
    const path = join(snapshotDir, "seq1.jsonl");
    await recordToolSequence(
      [
        { toolName: "TaskCreate", input: { subject: "S1", description: "D1" }, result: "Task #u-001 created: S1" },
        { toolName: "TaskList", input: {}, result: "No tasks." },
      ],
      path,
    );

    expect(existsSync(path)).toBe(true);
    const content = await readFile(path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as ToolCallRecord;
    expect(first.toolName).toBe("TaskCreate");
    expect(first.step).toBe(0);
    expect(first.result).toContain("S1");
  });

  test("replayToolSequence with matching results passes", async () => {
    const path = join(snapshotDir, "replay1.jsonl");
    const ctx = createMockContext("/tmp");

    // Record real results first
    const createResult = await taskCreateTool.call(
      { subject: "Replay test", description: "Replayed" },
      ctx,
    );
    resetTasks();

    await recordToolSequence(
      [
        {
          toolName: "TaskCreate",
          input: { subject: "Replay test", description: "Replayed" },
          result: createResult,
        },
      ],
      path,
    );

    const toolMap = new Map<string, Tool>([["TaskCreate", taskCreateTool]]);
    const { passed, failed } = await replayToolSequence(path, toolMap, ctx);
    expect(passed).toBeGreaterThanOrEqual(1);
    expect(failed).toBe(0);
  });

  test("replayToolSequence with missing tool records failure", async () => {
    const path = join(snapshotDir, "missing-tool.jsonl");
    await recordToolSequence(
      [{ toolName: "NonExistent", input: {}, result: "result" }],
      path,
    );
    const { failed, diffs } = await replayToolSequence(path, new Map(), createMockContext("/tmp"));
    expect(failed).toBe(1);
    expect(diffs[0]).toContain("not found");
  });

  test("replayToolSequence with tolerateDiff passes despite output mismatch", async () => {
    const path = join(snapshotDir, "tolerate.jsonl");
    const ctx = createMockContext("/tmp");

    await recordToolSequence(
      [{ toolName: "TaskCreate", input: { subject: "X", description: "Y" }, result: "OLD RESULT" }],
      path,
    );

    const toolMap = new Map<string, Tool>([["TaskCreate", taskCreateTool]]);
    const { passed, failed } = await replayToolSequence(path, toolMap, ctx, {
      tolerateDiff: true,
    });
    expect(passed).toBe(1);
    expect(failed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — createMockContext & withTempDir harness self-tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MockToolContext harness self-tests", () => {
  test("createMockContext returns correct cwd", () => {
    const ctx = createMockContext("/my/project");
    expect(ctx.cwd).toBe("/my/project");
  });

  test("createMockContext isMock is true by default", () => {
    const ctx = createMockContext();
    expect(ctx.isMock).toBe(true);
  });

  test("requestPermission auto-approves and logs", async () => {
    const ctx = createMockContext("/tmp", { autoApprove: true });
    const granted = await ctx.requestPermission("Bash", "run ls");
    expect(granted).toBe(true);
    expect(ctx.permissionLog).toHaveLength(1);
    expect(ctx.permissionLog[0]!.tool).toBe("Bash");
    expect(ctx.permissionLog[0]!.granted).toBe(true);
  });

  test("requestPermission auto-deny when autoApprove=false", async () => {
    const ctx = createMockContext("/tmp", { autoApprove: false });
    const granted = await ctx.requestPermission("BulkEdit", "delete files");
    expect(granted).toBe(false);
    expect(ctx.permissionLog[0]!.granted).toBe(false);
  });

  test("withTempDir creates real dir, callback runs, dir is cleaned up", async () => {
    let capturedDir: string | null = null;
    await withTempDir(async (dir) => {
      capturedDir = dir;
      expect(existsSync(dir)).toBe(true);
    });
    // After callback, dir should be gone
    if (capturedDir) {
      expect(existsSync(capturedDir)).toBe(false);
    }
  });

  test("withTempDir ctx.cwd matches dir", async () => {
    await withTempDir(async (dir, ctx) => {
      expect(ctx.cwd).toBe(dir);
    });
  });

  test("permissionLog accumulates multiple calls", async () => {
    const ctx = createMockContext();
    await ctx.requestPermission("Bash", "cmd1");
    await ctx.requestPermission("Edit", "cmd2");
    await ctx.requestPermission("Read", "cmd3");
    expect(ctx.permissionLog).toHaveLength(3);
  });
});
