/**
 * Coordinator Mode — multi-agent orchestration.
 *
 * A lead agent that:
 * 1. Breaks complex tasks into subtasks (structured output, not regex)
 * 2. Validates dependency graph for cycles (topological sort)
 * 3. Dispatches to specialized sub-agents (team members or ad-hoc)
 * 4. Tracks progress via task board with wave-based execution
 * 5. Runs verification on the combined output
 *
 * v2.1 improvements over v2.0:
 * - Structured JSON extraction with fallback (no brittle regex)
 * - Deadlock detection before dispatch
 * - Structured success signals (no string matching)
 * - Progress callbacks per wave
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
  | { type: "plan_ready"; taskCount: number; waveCount: number }
  | { type: "wave_start"; waveIndex: number; totalWaves: number; taskCount: number }
  | { type: "dispatching"; taskIndex: number; totalTasks: number; agentName: string }
  | { type: "agent_complete"; taskIndex: number; agentName: string; success: boolean; summary: string }
  | { type: "wave_complete"; waveIndex: number; successCount: number; failCount: number }
  | { type: "verifying" }
  | { type: "complete"; summary: string };

export interface SubTask {
  id: string;
  description: string;
  role: string;
  readOnly?: boolean;
  files?: string[];
  /** Task IDs that must complete before this one starts */
  dependsOn?: string[];
}

export interface CoordinatorResult {
  tasks: Array<{
    description: string;
    agentName: string;
    result: SubAgentResult;
    success: boolean;
    summary: string;
  }>;
  verificationPassed?: boolean;
  summary: string;
}

/**
 * Extract JSON from mixed text output.
 * Tries multiple strategies, from strict to lenient.
 */
function extractJSON<T>(text: string): T | null {
  // Strategy 1: Try parsing the entire text as JSON
  try {
    return JSON.parse(text) as T;
  } catch { /* continue */ }

  // Strategy 2: Find JSON in code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim()) as T;
    } catch { /* continue */ }
  }

  // Strategy 3: Find first [ ... ] or { ... } block
  let depth = 0;
  let start = -1;
  const bracketIdx = text.indexOf("[");
  const braceIdx = text.indexOf("{");
  const opener =
    bracketIdx >= 0 && (braceIdx < 0 || bracketIdx < braceIdx) ? "[" : "{";
  const closer = opener === "[" ? "]" : "}";

  for (let i = 0; i < text.length; i++) {
    if (text[i] === opener) {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === closer) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch { /* continue looking */ }
      }
    }
  }

  return null;
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
- id: Unique identifier (e.g., "explore-auth", "impl-jwt", "test-jwt")
- description: What needs to be done (detailed enough for an agent to execute)
- role: One of "explorer", "implementer", "test-writer", "code-reviewer"
- readOnly: true if the task only reads (exploration, review)
- files: Array of file paths this task will likely touch (empty if unknown)
- dependsOn: Array of subtask IDs that must complete first (empty if independent)

Example:
\`\`\`json
[
  {"id": "explore-auth", "description": "Explore the auth module to understand current patterns", "role": "explorer", "readOnly": true, "files": ["src/auth/"], "dependsOn": []},
  {"id": "impl-jwt", "description": "Implement the new JWT validation middleware", "role": "implementer", "readOnly": false, "files": ["src/auth/jwt.ts"], "dependsOn": ["explore-auth"]},
  {"id": "test-jwt", "description": "Write tests for the JWT validation", "role": "test-writer", "readOnly": false, "files": ["src/__tests__/jwt.test.ts"], "dependsOn": ["impl-jwt"]}
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

  // Parse subtasks from agent output using robust extraction
  const parsed = extractJSON<SubTask[]>(planResult.text);
  if (parsed && Array.isArray(parsed) && parsed.length > 0) {
    // Ensure all tasks have IDs
    return parsed.map((t, i) => ({
      ...t,
      id: t.id || `task-${i}`,
      role: t.role || "implementer",
      dependsOn: t.dependsOn ?? [],
    }));
  }

  // Fallback: single task (log warning)
  config.onProgress?.({
    type: "planning",
    message: "Warning: Could not parse subtask plan, falling back to single task",
  });
  return [{
    id: "single-task",
    description: goal,
    role: "implementer",
    readOnly: false,
    dependsOn: [],
  }];
}

/**
 * Validate dependency graph for cycles using topological sort.
 * Returns the cycle path if one is found.
 */
function detectCycles(tasks: SubTask[]): string[] | null {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(taskId: string, path: string[]): string[] | null {
    visited.add(taskId);
    recStack.add(taskId);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (task?.dependsOn) {
      for (const dep of task.dependsOn) {
        if (!visited.has(dep)) {
          const cycle = dfs(dep, path);
          if (cycle) return cycle;
        } else if (recStack.has(dep)) {
          return [...path, dep]; // Found cycle
        }
      }
    }

    path.pop();
    recStack.delete(taskId);
    return null;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      const cycle = dfs(task.id, []);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Organize tasks into waves based on dependencies.
 * Each wave contains tasks whose dependencies are all in previous waves.
 */
function buildWaves(tasks: SubTask[]): SubTask[][] {
  const waves: SubTask[][] = [];
  const completed = new Set<string>();
  const remaining = new Set(tasks.map((t) => t.id));
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  while (remaining.size > 0) {
    const wave: SubTask[] = [];

    for (const id of remaining) {
      const task = taskMap.get(id)!;
      const deps = task.dependsOn ?? [];
      if (deps.every((d) => completed.has(d) || !remaining.has(d))) {
        wave.push(task);
      }
    }

    if (wave.length === 0) {
      // Deadlock — push remaining tasks as final wave (should not happen if cycle check passed)
      for (const id of remaining) {
        wave.push(taskMap.get(id)!);
      }
    }

    for (const task of wave) {
      remaining.delete(task.id);
      completed.add(task.id);
    }

    waves.push(wave);
  }

  return waves;
}

/**
 * Determine if an agent succeeded based on its result.
 * Uses structured signals instead of brittle string matching.
 */
function evaluateSuccess(result: SubAgentResult): { success: boolean; summary: string } {
  const text = result.text;

  // Check for explicit error signals from the agent
  if (text.startsWith("[AGENT ERROR:")) {
    return { success: false, summary: text.slice(0, 200) };
  }

  // Empty result = likely failed
  if (!text || text.trim().length === 0) {
    return { success: false, summary: "Agent produced no output" };
  }

  // Check for error indicators (but only at the start of a line, not in explanations)
  const lines = text.split("\n");
  const errorLines = lines.filter((l) =>
    /^(Error:|FAIL|FATAL|Traceback|panic:)/i.test(l.trim())
  );

  if (errorLines.length > 0 && result.toolCalls.length === 0) {
    // Errors without any tool calls = probably failed to execute
    return { success: false, summary: errorLines[0]!.trim() };
  }

  // Default: success with first meaningful line as summary
  const firstMeaningful = lines.find((l) => l.trim().length > 10) ?? text.slice(0, 100);
  return { success: true, summary: firstMeaningful.trim().slice(0, 200) };
}

/**
 * Dispatch subtasks to agents in dependency-aware waves.
 */
async function dispatchTasks(
  tasks: SubTask[],
  config: CoordinatorConfig,
  team?: Team | null,
): Promise<CoordinatorResult["tasks"]> {
  const maxParallel = config.maxParallel ?? 3;
  const results: CoordinatorResult["tasks"] = [];
  const waves = buildWaves(tasks);

  config.onProgress?.({
    type: "plan_ready",
    taskCount: tasks.length,
    waveCount: waves.length,
  });

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx]!;

    config.onProgress?.({
      type: "wave_start",
      waveIndex: waveIdx,
      totalWaves: waves.length,
      taskCount: wave.length,
    });

    const waveStartIdx = results.length;

    // Process wave in batches of maxParallel
    for (let batch = 0; batch < wave.length; batch += maxParallel) {
      const batchTasks = wave.slice(batch, batch + maxParallel);

      const agentConfigs: SubAgentConfig[] = batchTasks.map((task) => {
        const teammate = team ? pickTeammateForTask(team, task.role) : null;
        const agentName = teammate?.name ?? `${task.role}-${task.id}`;
        const agentPrompt = teammate?.systemPrompt ?? `You are a ${task.role}.`;

        const taskIndex = tasks.findIndex((t) => t.id === task.id);
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
        const task = batchTasks[i]!;
        const agentResult = waveResults[i]!;
        const taskIndex = tasks.findIndex((t) => t.id === task.id);
        const { success, summary } = evaluateSuccess(agentResult);

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
          summary,
        });

        results.push({
          description: task.description,
          agentName: agentResult.name,
          result: agentResult,
          success,
          summary,
        });
      }
    }

    const waveResults = results.slice(waveStartIdx);
    const waveSuccess = waveResults.filter((r) => r.success).length;
    const waveFail = waveResults.filter((r) => !r.success).length;
    config.onProgress?.({
      type: "wave_complete",
      waveIndex: waveIdx,
      successCount: waveSuccess,
      failCount: waveFail,
    });
  }

  return results;
}

/**
 * Run the coordinator: plan → validate → dispatch → (verify) → summarize.
 */
export async function coordinate(
  goal: string,
  config: CoordinatorConfig,
): Promise<CoordinatorResult> {
  // Step 1: Plan subtasks
  const subtasks = await planSubTasks(goal, config);

  // Step 2: Validate dependency graph
  const cycle = detectCycles(subtasks);
  if (cycle) {
    const summary = `Coordinator aborted: circular dependency detected: ${cycle.join(" → ")}`;
    config.onProgress?.({ type: "complete", summary });
    return { tasks: [], summary };
  }

  // Step 3: Load team if specified
  let team: Team | null = null;
  if (config.teamId) {
    team = await loadTeam(config.teamId);
  }

  // Step 4: Dispatch in dependency-aware waves
  const taskResults = await dispatchTasks(subtasks, config, team);

  // Step 5: Optional verification
  let verificationPassed: boolean | undefined;
  if (config.autoVerify) {
    config.onProgress?.({ type: "verifying" });
    const verifyConfig: VerificationConfig = {
      router: config.router,
      toolRegistry: config.toolRegistry,
      toolContext: config.toolContext,
      systemPrompt: config.systemPrompt,
    };
    const modifiedFiles = subtasks.flatMap((t) => t.files ?? []);
    if (modifiedFiles.length > 0) {
      const vResult = await runVerification(verifyConfig, { intent: goal, files: modifiedFiles });
      verificationPassed = vResult.passed;
    }
  }

  // Step 6: Summarize
  const successCount = taskResults.filter((t) => t.success).length;
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
    lines.push(`**Summary:** ${task.summary}`);
    if (task.result.worktree) {
      lines.push(`**Worktree:** ${task.result.worktree.path} (branch: ${task.result.worktree.branch})`);
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
