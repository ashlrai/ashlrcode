/**
 * WorkflowTool — manage and run multi-step automation workflows.
 * Workflows define a sequence of prompts, shell commands, and tool calls
 * stored in .ashlrcode/workflows/.
 */

import type { Tool, ToolContext } from "./types.ts";
import {
  listWorkflows,
  loadWorkflow,
  deleteWorkflow,
  createWorkflow,
  executeWorkflow,
  markWorkflowRun,
  type WorkflowStep,
} from "../agent/workflow.ts";

export const workflowTool: Tool = {
  name: "Workflow",

  prompt() {
    return `Manage and run multi-step workflows. Workflows define a sequence of prompts, shell commands, and tool calls that execute in order.

Actions:
- list: Show all saved workflows
- run: Execute a workflow by ID
- create: Define a new workflow with steps
- delete: Remove a workflow by ID

Each step has a type: "prompt" (send text to the LLM), "command" (run a shell command), or "tool" (invoke a tool by name). Steps run sequentially and halt on failure unless continueOnError is set.`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "run", "create", "delete"],
          description: "What to do",
        },
        workflowId: {
          type: "string",
          description: "Workflow ID (required for run/delete)",
        },
        name: {
          type: "string",
          description: "Workflow name (required for create)",
        },
        description: {
          type: "string",
          description: "Workflow description (for create)",
        },
        steps: {
          type: "array",
          description:
            'Array of workflow steps (for create). Each step: { name: string, type: "prompt"|"command"|"tool", value: string, input?: object, continueOnError?: boolean }',
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["prompt", "command", "tool"] },
              value: { type: "string" },
              input: { type: "object" },
              continueOnError: { type: "boolean" },
            },
            required: ["name", "type", "value"],
          },
        },
      },
      required: ["action"],
    };
  },

  isReadOnly() {
    return false;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    const action = input.action as string;
    if (!action) return "action is required";
    if (!["list", "run", "create", "delete"].includes(action))
      return `Invalid action: ${action}`;
    if ((action === "run" || action === "delete") && !input.workflowId)
      return "workflowId is required for run/delete";
    if (action === "create") {
      if (!input.name) return "name is required for create";
      if (!input.steps || !Array.isArray(input.steps) || input.steps.length === 0)
        return "steps array is required for create (must have at least one step)";
    }
    return null;
  },

  async call(input, context) {
    const action = input.action as string;

    if (action === "list") {
      const workflows = await listWorkflows();
      if (workflows.length === 0)
        return "No workflows found. Create one with action: create.";
      return workflows
        .map(
          (w) =>
            `${w.id} — ${w.name} (${w.steps.length} steps, run ${w.runCount}x)${w.description ? `\n  ${w.description}` : ""}`,
        )
        .join("\n");
    }

    if (action === "delete") {
      const ok = await deleteWorkflow(input.workflowId as string);
      return ok ? "Workflow deleted." : "Workflow not found.";
    }

    if (action === "create") {
      const wf = await createWorkflow(
        input.name as string,
        (input.description as string) ?? "",
        input.steps as WorkflowStep[],
      );
      return `Workflow "${wf.name}" created (${wf.id}, ${wf.steps.length} steps)`;
    }

    if (action === "run") {
      const wf = await loadWorkflow(input.workflowId as string);
      if (!wf) return "Workflow not found.";

      const result = await executeWorkflow(wf, {
        // Prompt execution: placeholder — real agent integration would
        // feed the prompt into the conversation loop
        runPrompt: async (prompt) =>
          `[Would execute prompt: ${prompt.slice(0, 200)}]`,

        // Command execution: runs via Bun.spawn
        runCommand: async (cmd) => {
          const proc = Bun.spawn(["bash", "-c", cmd], {
            cwd: context.cwd,
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
          return { output, exitCode };
        },

        // Tool execution: placeholder — real integration would dispatch
        // through the ToolRegistry
        runTool: async (name, toolInput) => {
          return {
            result: `[Would call tool: ${name} with ${JSON.stringify(toolInput).slice(0, 200)}]`,
            isError: false,
          };
        },

        onStepStart: (step, i) => {
          console.log(
            `  Step ${i + 1}/${wf.steps.length}: ${step.name} (${step.type})`,
          );
        },
        onStepEnd: (_step, _i, success, _output) => {
          console.log(`  ${success ? "OK" : "FAIL"}: ${_step.name}`);
        },
      });

      await markWorkflowRun(wf.id);

      const lines = [
        `Workflow: ${result.workflow}`,
        `Steps: ${result.stepsCompleted}/${result.stepsTotal}`,
        `Duration: ${result.durationMs}ms`,
        "",
      ];
      for (const r of result.results) {
        lines.push(`${r.success ? "[OK]" : "[FAIL]"} ${r.step}: ${r.output.slice(0, 200)}`);
      }
      return lines.join("\n");
    }

    return `Unknown action: ${action}`;
  },
};
