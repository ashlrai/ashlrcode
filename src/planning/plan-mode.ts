/**
 * Plan Mode — read-only exploration → strategic questions → plan → execute.
 *
 * When plan mode is active:
 * - Only read-only tools are available (Read, Glob, Grep, WebFetch, AskUser)
 * - Write/Edit/Bash are blocked
 * - The model writes a plan to a .md file
 * - User approves → plan mode exits → execution begins
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface PlanState {
  active: boolean;
  planFilePath: string | null;
  startedAt: string | null;
}

function getPlansDir(): string {
  return join(getConfigDir(), "plans");
}

let state: PlanState = {
  active: false,
  planFilePath: null,
  startedAt: null,
};

/**
 * Generate a memorable plan name (adjective-noun format).
 */
function generatePlanName(): string {
  const adjectives = [
    "swift", "bold", "calm", "deep", "keen", "bright", "clear", "sharp",
    "steady", "agile", "precise", "focused", "direct", "elegant", "robust",
    "clean", "solid", "smart", "lean", "fluid",
  ];
  const nouns = [
    "falcon", "compass", "anchor", "bridge", "prism", "beacon", "forge",
    "summit", "atlas", "cipher", "nexus", "pulse", "spark", "vector",
    "zenith", "orbit", "ridge", "delta", "apex", "crest",
  ];

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!;
  return `${adj}-${noun}`;
}

export async function enterPlanMode(): Promise<string> {
  const plansDir = getPlansDir();
  await mkdir(plansDir, { recursive: true });

  const planName = generatePlanName();
  const planFile = join(plansDir, `${planName}.md`);

  state = {
    active: true,
    planFilePath: planFile,
    startedAt: new Date().toISOString(),
  };

  return planFile;
}

export function exitPlanMode(): void {
  state = {
    active: false,
    planFilePath: null,
    startedAt: null,
  };
}

export function isPlanMode(): boolean {
  return state.active;
}

export function getPlanFilePath(): string | null {
  return state.planFilePath;
}

export function getPlanState(): PlanState {
  return { ...state };
}

export async function writePlan(content: string): Promise<void> {
  if (!state.planFilePath) throw new Error("No active plan");
  await writeFile(state.planFilePath, content, "utf-8");
}

export async function readPlan(): Promise<string | null> {
  if (!state.planFilePath || !existsSync(state.planFilePath)) return null;
  return await readFile(state.planFilePath, "utf-8");
}

/**
 * Get the plan mode system prompt addition.
 */
export function getPlanModePrompt(): string {
  if (!state.active) return "";

  return `
## PLAN MODE ACTIVE

You are in plan mode. You MUST follow these rules:
- You MUST NOT make any edits to files (no Write, Edit, or Bash commands that modify files)
- You CAN use read-only tools: Read, Glob, Grep, WebFetch, AskUser
- You SHOULD explore the codebase to understand the problem
- You SHOULD ask strategic questions using AskUser before proposing a plan
- You MUST write your plan to the plan file: ${state.planFilePath}
- Questions should emerge from actual code exploration, not be generic

### Plan Workflow:
1. Explore the codebase with read-only tools
2. Ask 1-4 strategic questions using AskUser
3. Write a detailed plan to the plan file using PlanWrite
4. Call ExitPlan when the plan is ready for user approval

### Plan File Format:
- Start with a Context section explaining why the change is needed
- Include specific file paths to modify
- Reference existing functions/utilities to reuse
- Include a verification section (how to test)
- Be concise but detailed enough to execute
`;
}
