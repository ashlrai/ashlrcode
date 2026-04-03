/**
 * Team Persistence — manage persistent agent teammates.
 *
 * Pattern from Claude Code's coordinator mode: a lead agent can create
 * teammates that persist across sessions, claim tasks from a shared
 * board, and report results back.
 */

import { existsSync } from "fs";
import { readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface Teammate {
  id: string;
  name: string;
  role: string; // e.g., "code-reviewer", "test-writer", "explorer"
  systemPrompt: string; // Specialized instructions for this teammate
  createdAt: string;
  lastActiveAt?: string;
  stats: {
    tasksCompleted: number;
    totalIterations: number;
  };
}

export interface Team {
  id: string;
  name: string;
  teammates: Teammate[];
  createdAt: string;
  updatedAt: string;
}

function getTeamsDir(): string {
  return join(getConfigDir(), "teams");
}

function getTeamPath(teamId: string): string {
  return join(getTeamsDir(), `${teamId}.json`);
}

/**
 * Create a new team.
 */
export async function createTeam(name: string): Promise<Team> {
  await mkdir(getTeamsDir(), { recursive: true });

  const team: Team = {
    id: `team-${Date.now()}`,
    name,
    teammates: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveTeam(team);
  return team;
}

/**
 * Add a teammate to a team.
 */
export async function addTeammate(
  teamId: string,
  name: string,
  role: string,
  systemPrompt?: string,
): Promise<Teammate> {
  const team = await loadTeam(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);

  const rolePrompts: Record<string, string> = {
    "code-reviewer":
      "You are a code reviewer. Focus on bugs, logic errors, security vulnerabilities, and code quality. Be thorough but only flag high-confidence issues.",
    "test-writer":
      "You are a test writer. Write comprehensive tests for the code you're given. Cover edge cases, error scenarios, and happy paths.",
    explorer:
      "You are a codebase explorer. Map patterns, find dependencies, and report findings with specific file paths and line numbers.",
    implementer:
      "You are an implementer. Write clean, well-structured code that follows the existing patterns and conventions in the codebase.",
  };

  const teammate: Teammate = {
    id: `mate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    role,
    systemPrompt: systemPrompt ?? rolePrompts[role] ?? `You are a ${role}.`,
    createdAt: new Date().toISOString(),
    stats: { tasksCompleted: 0, totalIterations: 0 },
  };

  team.teammates.push(teammate);
  team.updatedAt = new Date().toISOString();
  await saveTeam(team);

  return teammate;
}

/**
 * Remove a teammate from a team.
 */
export async function removeTeammate(
  teamId: string,
  teammateId: string,
): Promise<boolean> {
  const team = await loadTeam(teamId);
  if (!team) return false;

  const idx = team.teammates.findIndex((t) => t.id === teammateId);
  if (idx === -1) return false;

  team.teammates.splice(idx, 1);
  team.updatedAt = new Date().toISOString();
  await saveTeam(team);
  return true;
}

/**
 * Record teammate activity.
 */
export async function recordTeammateActivity(
  teamId: string,
  teammateId: string,
  tasksCompleted: number = 1,
  iterations: number = 0,
): Promise<void> {
  const team = await loadTeam(teamId);
  if (!team) return;

  const mate = team.teammates.find((t) => t.id === teammateId);
  if (!mate) return;

  mate.stats.tasksCompleted += tasksCompleted;
  mate.stats.totalIterations += iterations;
  mate.lastActiveAt = new Date().toISOString();
  team.updatedAt = new Date().toISOString();
  await saveTeam(team);
}

/**
 * Load a team by ID.
 */
export async function loadTeam(teamId: string): Promise<Team | null> {
  const path = getTeamPath(teamId);
  if (!existsSync(path)) return null;

  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Team;
  } catch {
    return null;
  }
}

/**
 * List all teams.
 */
export async function listTeams(): Promise<Team[]> {
  const dir = getTeamsDir();
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const teams: Team[] = [];

  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      teams.push(JSON.parse(raw) as Team);
    } catch {
      // Skip corrupt team files
    }
  }

  return teams.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

/**
 * Delete a team.
 */
export async function deleteTeam(teamId: string): Promise<boolean> {
  const path = getTeamPath(teamId);
  if (!existsSync(path)) return false;

  await unlink(path);
  return true;
}

/**
 * Save team to disk.
 */
async function saveTeam(team: Team): Promise<void> {
  await mkdir(getTeamsDir(), { recursive: true });
  await writeFile(
    getTeamPath(team.id),
    JSON.stringify(team, null, 2),
    "utf-8",
  );
}

/**
 * Get the best teammate for a task type.
 */
export function pickTeammateForTask(
  team: Team,
  taskType: string,
): Teammate | null {
  // Match by role
  const roleMatch = team.teammates.find((t) => t.role === taskType);
  if (roleMatch) return roleMatch;

  // Fallback: least busy teammate
  const sorted = [...team.teammates].sort(
    (a, b) => a.stats.tasksCompleted - b.stats.tasksCompleted,
  );
  return sorted[0] ?? null;
}
