/**
 * Workflow system — define and run multi-step automation scripts.
 * Workflows are stored as JSON files in .ashlrcode/workflows/
 */

import { existsSync } from "fs";
import { readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface WorkflowStep {
  name: string;
  type: "prompt" | "command" | "tool";
  value: string; // prompt text, shell command, or tool name
  input?: Record<string, unknown>; // for tool type
  continueOnError?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
}

export interface WorkflowResult {
  workflow: string;
  stepsCompleted: number;
  stepsTotal: number;
  results: Array<{ step: string; success: boolean; output: string }>;
  durationMs: number;
}

function getWorkflowsDir(): string {
  return join(getConfigDir(), "workflows");
}

export async function createWorkflow(
  name: string,
  description: string,
  steps: WorkflowStep[],
): Promise<Workflow> {
  await mkdir(getWorkflowsDir(), { recursive: true });
  const workflow: Workflow = {
    id: `wf-${Date.now()}`,
    name,
    description,
    steps,
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
  await saveWorkflow(workflow);
  return workflow;
}

export async function listWorkflows(): Promise<Workflow[]> {
  const dir = getWorkflowsDir();
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const workflows: Workflow[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      workflows.push(JSON.parse(raw) as Workflow);
    } catch {
      // skip malformed workflow files
    }
  }
  return workflows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadWorkflow(id: string): Promise<Workflow | null> {
  const path = join(getWorkflowsDir(), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const path = join(getWorkflowsDir(), `${id}.json`);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}

export async function markWorkflowRun(id: string): Promise<void> {
  const wf = await loadWorkflow(id);
  if (!wf) return;
  wf.lastRunAt = new Date().toISOString();
  wf.runCount++;
  await saveWorkflow(wf);
}

async function saveWorkflow(wf: Workflow): Promise<void> {
  await mkdir(getWorkflowsDir(), { recursive: true });
  await writeFile(
    join(getWorkflowsDir(), `${wf.id}.json`),
    JSON.stringify(wf, null, 2),
    "utf-8",
  );
}

/**
 * Execute a workflow step by step.
 * The executor callbacks allow the caller to wire up actual prompt/command/tool
 * execution and observe progress.
 */
export async function executeWorkflow(
  workflow: Workflow,
  executor: {
    runPrompt: (prompt: string) => Promise<string>;
    runCommand: (cmd: string) => Promise<{ output: string; exitCode: number }>;
    runTool: (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ result: string; isError: boolean }>;
    onStepStart: (step: WorkflowStep, index: number) => void;
    onStepEnd: (
      step: WorkflowStep,
      index: number,
      success: boolean,
      output: string,
    ) => void;
  },
): Promise<WorkflowResult> {
  const startTime = Date.now();
  const results: WorkflowResult["results"] = [];
  let completed = 0;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    executor.onStepStart(step, i);

    try {
      let output: string;
      let success: boolean;

      switch (step.type) {
        case "prompt":
          output = await executor.runPrompt(step.value);
          success = true;
          break;
        case "command": {
          const cmdResult = await executor.runCommand(step.value);
          output = cmdResult.output;
          success = cmdResult.exitCode === 0;
          break;
        }
        case "tool": {
          const toolResult = await executor.runTool(
            step.value,
            step.input ?? {},
          );
          output = toolResult.result;
          success = !toolResult.isError;
          break;
        }
        default:
          output = `Unknown step type: ${(step as WorkflowStep).type}`;
          success = false;
      }

      results.push({ step: step.name, success, output: output.slice(0, 500) });
      executor.onStepEnd(step, i, success, output);
      completed++;

      if (!success && !step.continueOnError) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ step: step.name, success: false, output: msg });
      executor.onStepEnd(step, i, false, msg);
      if (!step.continueOnError) break;
    }
  }

  return {
    workflow: workflow.name,
    stepsCompleted: completed,
    stepsTotal: workflow.steps.length,
    results,
    durationMs: Date.now() - startTime,
  };
}
