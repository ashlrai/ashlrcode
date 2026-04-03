import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createWorkflow,
  listWorkflows,
  deleteWorkflow,
  executeWorkflow,
  markWorkflowRun,
  loadWorkflow,
  type WorkflowStep,
  type Workflow,
} from "../agent/workflow.ts";
import { setConfigDirForTests } from "../config/settings.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-workflow-test-"));
  setConfigDirForTests(configDir);
});

afterEach(() => {
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

/** Helper to create a mock executor */
function mockExecutor(overrides?: Partial<Parameters<typeof executeWorkflow>[1]>) {
  return {
    runPrompt: async (prompt: string) => `Response to: ${prompt}`,
    runCommand: async (cmd: string) => ({ output: `ran: ${cmd}`, exitCode: 0 }),
    runTool: async (name: string, _input: Record<string, unknown>) => ({
      result: `tool ${name} done`,
      isError: false,
    }),
    onStepStart: () => {},
    onStepEnd: () => {},
    ...overrides,
  };
}

describe("createWorkflow", () => {
  test("saves workflow to disk", async () => {
    const steps: WorkflowStep[] = [
      { name: "say hi", type: "prompt", value: "Hello" },
    ];
    const wf = await createWorkflow("Test WF", "A test workflow", steps);

    expect(wf.id).toMatch(/^wf-/);
    expect(wf.name).toBe("Test WF");
    expect(wf.runCount).toBe(0);

    const path = join(configDir, "workflows", `${wf.id}.json`);
    expect(existsSync(path)).toBe(true);
  });
});

describe("listWorkflows", () => {
  test("returns saved workflows sorted by name", async () => {
    await createWorkflow("Zeta", "Last", []);
    await new Promise((r) => setTimeout(r, 5));
    await createWorkflow("Alpha", "First", []);

    const workflows = await listWorkflows();
    expect(workflows.length).toBe(2);
    expect(workflows[0]!.name).toBe("Alpha");
    expect(workflows[1]!.name).toBe("Zeta");
  });

  test("returns empty array when no workflows dir exists", async () => {
    const workflows = await listWorkflows();
    expect(workflows).toEqual([]);
  });
});

describe("deleteWorkflow", () => {
  test("removes workflow file and returns true", async () => {
    const wf = await createWorkflow("ToDelete", "Will be deleted", []);
    const deleted = await deleteWorkflow(wf.id);
    expect(deleted).toBe(true);

    const path = join(configDir, "workflows", `${wf.id}.json`);
    expect(existsSync(path)).toBe(false);
  });

  test("returns false for non-existent workflow", async () => {
    const deleted = await deleteWorkflow("wf-nonexistent");
    expect(deleted).toBe(false);
  });
});

describe("markWorkflowRun", () => {
  test("increments run counter and sets lastRunAt", async () => {
    const wf = await createWorkflow("Counter", "Tracks runs", []);
    expect(wf.runCount).toBe(0);
    expect(wf.lastRunAt).toBeUndefined();

    await markWorkflowRun(wf.id);
    const updated = await loadWorkflow(wf.id);
    expect(updated!.runCount).toBe(1);
    expect(updated!.lastRunAt).toBeDefined();

    await markWorkflowRun(wf.id);
    const updated2 = await loadWorkflow(wf.id);
    expect(updated2!.runCount).toBe(2);
  });
});

describe("executeWorkflow", () => {
  test("runs command steps", async () => {
    const wf = await createWorkflow("CmdTest", "Test commands", [
      { name: "list files", type: "command", value: "ls" },
      { name: "greet", type: "prompt", value: "Say hello" },
    ]);

    const result = await executeWorkflow(wf, mockExecutor());
    expect(result.stepsCompleted).toBe(2);
    expect(result.stepsTotal).toBe(2);
    expect(result.results.length).toBe(2);
    expect(result.results[0]!.success).toBe(true);
    expect(result.results[1]!.success).toBe(true);
  });

  test("stops on error when continueOnError is not set", async () => {
    const wf = await createWorkflow("FailTest", "Stops on error", [
      { name: "fail step", type: "command", value: "bad-command" },
      { name: "never reached", type: "prompt", value: "Should not run" },
    ]);

    const executor = mockExecutor({
      runCommand: async () => ({ output: "error", exitCode: 1 }),
    });

    const result = await executeWorkflow(wf, executor);
    expect(result.stepsCompleted).toBe(1); // First step runs (but fails)
    expect(result.results[0]!.success).toBe(false);
    // Second step should not have run
    expect(result.results.length).toBe(1);
  });

  test("continues past error when continueOnError is set", async () => {
    const wf = await createWorkflow("ContinueTest", "Continues on error", [
      { name: "fail step", type: "command", value: "bad", continueOnError: true },
      { name: "still runs", type: "prompt", value: "This should run" },
    ]);

    const executor = mockExecutor({
      runCommand: async () => ({ output: "error", exitCode: 1 }),
    });

    const result = await executeWorkflow(wf, executor);
    expect(result.stepsCompleted).toBe(2);
    expect(result.results.length).toBe(2);
    expect(result.results[0]!.success).toBe(false);
    expect(result.results[1]!.success).toBe(true);
  });

  test("handles tool steps", async () => {
    const wf = await createWorkflow("ToolTest", "Test tool steps", [
      { name: "read file", type: "tool", value: "Read", input: { file_path: "/tmp/test" } },
    ]);

    const result = await executeWorkflow(wf, mockExecutor());
    expect(result.stepsCompleted).toBe(1);
    expect(result.results[0]!.success).toBe(true);
  });

  test("handles exceptions in steps", async () => {
    const wf = await createWorkflow("ExceptionTest", "Throws", [
      { name: "explode", type: "command", value: "boom" },
      { name: "unreached", type: "prompt", value: "nope" },
    ]);

    const executor = mockExecutor({
      runCommand: async () => { throw new Error("kaboom"); },
    });

    const result = await executeWorkflow(wf, executor);
    expect(result.results[0]!.success).toBe(false);
    expect(result.results[0]!.output).toContain("kaboom");
    expect(result.results.length).toBe(1);
  });

  test("reports timing info", async () => {
    const wf = await createWorkflow("TimingTest", "Timing", [
      { name: "quick", type: "prompt", value: "fast" },
    ]);

    const result = await executeWorkflow(wf, mockExecutor());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.workflow).toBe("TimingTest");
  });
});
