/**
 * Team management tools — create, manage, and delegate to persistent teammates.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { Teammate } from "../agent/team.ts";
import {
  createTeam,
  addTeammate,
  removeTeammate,
  deleteTeam,
  listTeams,
  loadTeam,
  pickTeammateForTask,
  recordTeammateActivity,
} from "../agent/team.ts";
import { runSubAgent } from "../agent/sub-agent.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "./registry.ts";

// Module-level refs injected at registration time (same pattern as agent.ts)
let _router: ProviderRouter | null = null;
let _registry: ToolRegistry | null = null;
let _baseSystemPrompt: string = "";

export function initTeamTools(
  router: ProviderRouter,
  registry: ToolRegistry,
  systemPrompt: string,
) {
  _router = router;
  _registry = registry;
  _baseSystemPrompt = systemPrompt;
}

export const teamCreateTool: Tool = {
  name: "TeamCreate",
  prompt() {
    return "Create a new team or add a teammate. Teams persist across sessions and teammates can be assigned specialized roles.";
  },
  inputSchema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create_team", "add_teammate"],
          description: "What to do",
        },
        teamName: {
          type: "string",
          description: "Team name (for create_team)",
        },
        teamId: {
          type: "string",
          description: "Team ID (for add_teammate)",
        },
        name: { type: "string", description: "Teammate name" },
        role: {
          type: "string",
          enum: ["code-reviewer", "test-writer", "explorer", "implementer"],
          description: "Teammate role",
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
    return true;
  },
  validateInput(input) {
    const action = input.action as string;
    if (action === "create_team" && !input.teamName)
      return "teamName required";
    if (
      action === "add_teammate" &&
      (!input.teamId || !input.name || !input.role)
    )
      return "teamId, name, and role required";
    return null;
  },
  async call(input) {
    const action = input.action as string;
    if (action === "create_team") {
      const team = await createTeam(input.teamName as string);
      return `Team "${team.name}" created (ID: ${team.id})`;
    }
    if (action === "add_teammate") {
      const mate = await addTeammate(
        input.teamId as string,
        input.name as string,
        input.role as string,
      );
      return `Teammate "${mate.name}" (${mate.role}) added (ID: ${mate.id})`;
    }
    return "Unknown action";
  },
};

export const teamDeleteTool: Tool = {
  name: "TeamDelete",
  prompt() {
    return "Delete a team or remove a teammate.";
  },
  inputSchema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["delete_team", "remove_teammate"],
        },
        teamId: { type: "string" },
        teammateId: {
          type: "string",
          description: "For remove_teammate",
        },
      },
      required: ["action", "teamId"],
    };
  },
  isReadOnly() {
    return false;
  },
  isDestructive() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  validateInput(input) {
    if (!input.teamId) return "teamId required";
    if (input.action === "remove_teammate" && !input.teammateId)
      return "teammateId required";
    return null;
  },
  async call(input) {
    if (input.action === "delete_team") {
      const ok = await deleteTeam(input.teamId as string);
      return ok ? `Team deleted` : `Team not found`;
    }
    if (input.action === "remove_teammate") {
      const ok = await removeTeammate(
        input.teamId as string,
        input.teammateId as string,
      );
      return ok ? `Teammate removed` : `Not found`;
    }
    return "Unknown action";
  },
};

export const teamListTool: Tool = {
  name: "TeamList",
  prompt() {
    return "List all teams and their teammates.";
  },
  inputSchema() {
    return {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "Optional: show detail for specific team",
        },
      },
    };
  },
  isReadOnly() {
    return true;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return true;
  },
  validateInput() {
    return null;
  },
  async call(input) {
    if (input.teamId) {
      const team = await loadTeam(input.teamId as string);
      if (!team) return "Team not found";
      const mates = team.teammates
        .map(
          (t) =>
            `  ${t.name} (${t.role}) — ${t.stats.tasksCompleted} tasks done${t.lastActiveAt ? `, last active ${new Date(t.lastActiveAt).toLocaleDateString()}` : ""}`,
        )
        .join("\n");
      return `Team: ${team.name}\nTeammates:\n${mates || "  (none)"}`;
    }

    const teams = await listTeams();
    if (teams.length === 0) return "No teams. Use TeamCreate to create one.";
    return teams
      .map((t) => `${t.name} (${t.id}) — ${t.teammates.length} teammates`)
      .join("\n");
  },
};

export const teamDispatchTool: Tool = {
  name: "TeamDispatch",
  prompt() {
    return "Dispatch a task to a teammate. The teammate runs as a sub-agent with their specialized role and system prompt. Returns the teammate's findings/results.";
  },
  inputSchema() {
    return {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID" },
        teammateId: {
          type: "string",
          description:
            "Teammate ID (optional — auto-picks best match if omitted)",
        },
        task: {
          type: "string",
          description: "Task description for the teammate",
        },
        taskType: {
          type: "string",
          description:
            "Task type for auto-matching (e.g., 'code-reviewer', 'test-writer')",
        },
        mode: {
          type: "string",
          enum: ["in_process", "worktree"],
          description: "Execution mode",
        },
      },
      required: ["teamId", "task"],
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
    if (!input.teamId) return "teamId required";
    if (!input.task) return "task required";
    if (!_router || !_registry)
      return "Team tools not initialized. Call initTeamTools() first.";
    return null;
  },
  async call(input: Record<string, unknown>, context: ToolContext) {
    const teamId = input.teamId as string;
    const team = await loadTeam(teamId);
    if (!team) return "Team not found";

    let teammate: Teammate | null = null;
    if (input.teammateId) {
      teammate =
        team.teammates.find((t) => t.id === (input.teammateId as string)) ??
        null;
    } else {
      teammate = pickTeammateForTask(
        team,
        (input.taskType as string) ?? "",
      );
    }

    if (!teammate) return "No suitable teammate found";

    const task = input.task as string;
    const mode = (input.mode as "in_process" | "worktree") ?? "in_process";
    const readOnly =
      teammate.role === "code-reviewer" || teammate.role === "explorer";

    console.log(`  ◈ Dispatching to ${teammate.name} (${teammate.role})`);

    const result = await runSubAgent({
      name: `${teammate.name}-${teammate.role}`,
      prompt: task,
      systemPrompt:
        _baseSystemPrompt + "\n\n" + teammate.systemPrompt,
      router: _router!,
      toolRegistry: _registry!,
      toolContext: context,
      readOnly,
      maxIterations: 15,
      mode,
    });

    await recordTeammateActivity(
      teamId,
      teammate.id,
      1,
      result.toolCalls.length,
    );

    const worktreeInfo = result.worktree
      ? `\nWorktree: ${result.worktree.path} (${result.worktree.branch})`
      : "";

    return `## ${teammate.name} (${teammate.role})\n\n${result.text}${worktreeInfo}`;
  },
};
