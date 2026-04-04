/**
 * Coordinator Mode — multi-agent orchestration.
 *
 * A lead agent that:
 * 1. Breaks complex tasks into subtasks
 * 2. Dispatches to specialized sub-agents (team members or ad-hoc)
 * 3. Tracks progress via completion callbacks
 * 4. Merges results and resolves conflicts
 * 5. Runs verification on the combined output
 *
 * Activate via /coordinate command.
 */

import { runSubAgent, runSubAgentsParallel, type SubAgentConfig, type SubAgentResult } from "./sub-agent.ts";
import { loadTeam, pickTeammateForTask, recordTeammateActivity, type Team, type Teammate } from "./team.ts";
import { runVerification, type VerificationConfig } from "./verification.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";

export interface CoordinatorConfig {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  /** Team ID to use for dispatching (optional — creates ad-hoc agents if no team) */
  teamId?: string;
  /** Max parallel sub-agents */
  maxParallel?: number;
  /** Auto-verify results after all agents complete */
  autoVerify?: boolean;
  /** Progress callback */
  onProgress?: (event: CoordinatorEvent) => void;
}

export type CoordinatorEvent =
  | { type: "planning"; message: string }
  | { type: "dispatching"; taskIndex: number; totalTasks: number; agentName: string }
  | { type: "agent_complete"; taskIndex: number; agentName: string; success: boolean }
  | { type: "verifying" }
  | { type: "complete"; summary: string };

export interface SubTask {
  description: string;
  role: string; // "explorer", "implementer", "test-writer", "code-reviewer"
  readOnly?: boolean;
  files?: string[]; // Hint for which files this subtask touches
}

export interface CoordinatorResult {
  tasks: Array<{
    description: string;
    agentName: string;
    result: SubAgentResult;
    success: boolean;
  }>;
  verificationPassed?: boolean;
  summary: string;
}

/**
 * Break a complex task into sub-tasks using the LLM.
 */
async function planSubTasks(
  goal: string,
  config: CoordinatorConfig,
): Promise<SubTask[]> {
  config.onProgress?.({ type: "planning", message: "Analyzing task and creating subtask plan..." });

  const planResult = await runSubAgent({
    name: "coordinator-planner",
    prompt: `You are a task planner. Break the following goal into independent, parallelizable subtasks.

## Goal
${goal}

## Output Format
Return a JSON array of subtasks. Each subtask has:
- description: What needs to be done (detailed enough for an agent to execute)
- role: One of "explorer", "implementer", "test-writer", "code-reviewer"
- readOnly: true if the task only reads (exploration, review)
- files: Array of file paths this task will likely touch (empty if unknown)

Example:
\`\`\`json
[
  {"description": "Explore the auth module to understand current patterns", "role": "explorer", "readOnly": true, "files": ["src/auth/"]},
  {"description": "Implement the new JWT validation middleware", "role": "implementer", "readOnly": false, "files": ["src/auth/jwt.ts"]},
  {"description": "Write tests for the JWT validation", "role": "test-writer", "readOnly": false, "files": ["src/__tests__/jwt.test.ts"]}
]
\`\`\`

Return ONLY the JSON array, no explanation.`,
    systemPrompt: config.systemPrompt,
    router: config.router,
    toolRegistry: config.toolRegistry,
    toolContext: config.toolContext,
    readOnly: true,
    maxIterations: 5,
  });

  // Parse subtasks from agent output
  try {
    const jsonMatch = planResult.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as SubTask[];
    }
  } catch {
    // Parsing failed — fall through
  }

  // Fallback: single task
  return [{ description: goal, role: "implementer", readOnly: false }];
}

/**
 * Dispatch subtasks to agents (team members or ad-hoc).
 */
async function dispatchTasks(
  tasks: SubTask[],
  config: CoordinatorConfig,
  team?: Team | null,
): Promise<CoordinatorResult["tasks"]> {
  const maxParallel = config.maxParallel ?? 3;
  const results: CoordinatorResult["tasks"] = [];

  // Process in waves of maxParallel
  for (let wave = 0; wave < tasks.length; wave += maxParallel) {
    const batch = tasks.slice(wave, wave + maxParallel);

    const agentConfigs: SubAgentConfig[] = batch.map((task, i) => {
      const taskIndex = wave + i;
      const teammate = team ? pickTeammateForTask(team, task.role) : null;
      const agentName = teammate?.name ?? `agent-${task.role}-${taskIndex}`;
      const agentPrompt = teammate?.systemPrompt ?? `You are a ${task.role}.`;

      config.onProgress?.({
        type: "dispatching",
        taskIndex,
        totalTasks: tasks.length,
        agentName,
      });

      return {
        name: agentName,
        prompt: task.description,
        systemPrompt: config.systemPrompt + "\n\n" + agentPrompt,
        router: config.router,
        toolRegistry: config.toolRegistry,
        toolContext: config.toolContext,
        readOnly: task.readOnly,
        maxIterations: 15,
      };
    });

    const waveResults = await runSubAgentsParallel(agentConfigs);

    for (let i = 0; i < waveResults.length; i++) {
      const task = batch[i]!;
      const agentResult = waveResults[i]!;
      const taskIndex = wave + i;
      const success = !agentResult.text.includes("[ERROR]") && agentResult.text.length > 0;

      // Record activity for team members
      if (team) {
        const teammate = pickTeammateForTask(team, task.role);
        if (teammate) {
          await recordTeammateActivity(
            team.id,
            teammate.id,
            success ? 1 : 0,
            agentResult.toolCalls.length,
          );
        }
      }

      config.onProgress?.({
        type: "agent_complete",
        taskIndex,
        agentName: agentResult.name,
        success,
      });

      results.push({
        description: task.description,
        agentName: agentResult.name,
        result: agentResult,
        success,
      });
    }
  }

  return results;
}

/**
 * Run the coordinator: plan → dispatch → (verify) → summarize.
 */
export async function coordinate(
  goal: string,
  config: CoordinatorConfig,
): Promise<CoordinatorResult> {
  // Step 1: Plan subtasks
  const subtasks = await planSubTasks(goal, config);

  // Step 2: Load team if specified
  let team: Team | null = null;
  if (config.teamId) {
    team = await loadTeam(config.teamId);
  }

  // Step 3: Dispatch
  const taskResults = await dispatchTasks(subtasks, config, team);

  // Step 4: Optional verification
  let verificationPassed: boolean | undefined;
  if (config.autoVerify) {
    config.onProgress?.({ type: "verifying" });
    const verifyConfig: VerificationConfig = {
      router: config.router,
      toolRegistry: config.toolRegistry,
      toolContext: config.toolContext,
      systemPrompt: config.systemPrompt,
    };
    const modifiedFiles = subtasks.flatMap(t => t.files ?? []);
    if (modifiedFiles.length > 0) {
      const vResult = await runVerification(verifyConfig, { intent: goal, files: modifiedFiles });
      verificationPassed = vResult.passed;
    }
  }

  // Step 5: Summarize
  const successCount = taskResults.filter(t => t.success).length;
  const summary = `Coordinator completed: ${successCount}/${taskResults.length} tasks succeeded${verificationPassed !== undefined ? `, verification ${verificationPassed ? "passed" : "failed"}` : ""}`;

  config.onProgress?.({ type: "complete", summary });

  return { tasks: taskResults, verificationPassed, summary };
}

/**
 * Format coordinator results for display.
 */
export function formatCoordinatorReport(result: CoordinatorResult): string {
  const lines: string[] = [];

  lines.push("## Coordinator Report");
  lines.push("");
  lines.push(`**${result.summary}**`);
  lines.push("");

  for (const task of result.tasks) {
    const icon = task.success ? "✓" : "✗";
    lines.push(`### ${icon} ${task.agentName}`);
    lines.push(`**Task:** ${task.description}`);
    lines.push(`**Tools used:** ${task.result.toolCalls.length}`);
    if (task.result.text) {
      lines.push(`**Result:** ${task.result.text.slice(0, 300)}`);
    }
    lines.push("");
  }

  if (result.verificationPassed !== undefined) {
    lines.push(result.verificationPassed
      ? "### ✓ Verification Passed"
      : "### ✗ Verification Failed");
  }

  return lines.join("\n");
}
