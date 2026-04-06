/**
 * Checkpoint system — pause/resume coordinator workflows.
 *
 * Inspired by Claude Code's checkpoint-driven workflows where tasks can
 * pause at human gates, serialize state, and resume with fresh agent context.
 *
 * Checkpoints are stored in ~/.ashlrcode/checkpoints/<id>.json and can be
 * resumed via `/coordinate resume <id>`.
 */

import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { getConfigDir } from "../config/settings.ts";

// ── Types ────────────────────────────────────────────────────────────

export type CheckpointType =
  | "auth_gate"
  | "user_decision"
  | "review"
  | "approval"
  | "custom";

export interface Checkpoint {
  /** Unique checkpoint ID */
  id: string;
  /** ID of the coordinator session that created this checkpoint */
  coordinatorId: string;
  /** What kind of gate this is */
  type: CheckpointType;
  /** Human-readable reason for pausing */
  reason: string;
  /** Question or prompt to show the user */
  prompt: string;
  /** Tasks that were already completed before the checkpoint */
  completedTasks: Array<{ id: string; description: string; role: string; readOnly?: boolean; files?: string[]; dependsOn?: string[] }>;
  /** Results from completed tasks */
  completedResults: Array<{
    taskId: string;
    agentName: string;
    success: boolean;
    summary: string;
  }>;
  /** Tasks that are pending (after the checkpoint) */
  pendingTasks: Array<{ id: string; description: string; role: string; readOnly?: boolean; files?: string[]; dependsOn?: string[] }>;
  /** Arbitrary serialized context the coordinator needs to resume */
  context: Record<string, unknown>;
  /** The original user goal */
  goal: string;
  /** Working directory at time of checkpoint */
  cwd: string;
  /** When the checkpoint was created */
  createdAt: string;
  /** User's response (populated when resuming) */
  userResponse?: string;
  /** Whether this checkpoint has been resumed */
  resumed: boolean;
}

// ── Storage ──────────────────────────────────���───────────────────────

function getCheckpointDir(): string {
  return join(getConfigDir(), "checkpoints");
}

function getCheckpointPath(id: string): string {
  return join(getCheckpointDir(), `${id}.json`);
}

/**
 * Save a checkpoint to disk. Returns the checkpoint ID.
 */
export async function saveCheckpoint(checkpoint: Omit<Checkpoint, "id" | "createdAt" | "resumed">): Promise<Checkpoint> {
  const dir = getCheckpointDir();
  await mkdir(dir, { recursive: true });

  const full: Checkpoint = {
    ...checkpoint,
    id: randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    resumed: false,
  };

  await writeFile(getCheckpointPath(full.id), JSON.stringify(full, null, 2), "utf-8");
  return full;
}

/**
 * Load a checkpoint by ID.
 */
export async function loadCheckpoint(id: string): Promise<Checkpoint | null> {
  const path = getCheckpointPath(id);
  if (!existsSync(path)) return null;

  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * List all checkpoints, newest first.
 */
export async function listCheckpoints(): Promise<Checkpoint[]> {
  const dir = getCheckpointDir();
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const checkpoints: Checkpoint[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      checkpoints.push(JSON.parse(raw) as Checkpoint);
    } catch {
      // Skip corrupt files
    }
  }

  // Newest first
  return checkpoints.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * List only pending (non-resumed) checkpoints.
 */
export async function listPendingCheckpoints(): Promise<Checkpoint[]> {
  const all = await listCheckpoints();
  return all.filter((c) => !c.resumed);
}

/**
 * Mark a checkpoint as resumed with the user's response.
 */
export async function markCheckpointResumed(id: string, userResponse: string): Promise<Checkpoint | null> {
  const checkpoint = await loadCheckpoint(id);
  if (!checkpoint) return null;

  checkpoint.resumed = true;
  checkpoint.userResponse = userResponse;

  await writeFile(getCheckpointPath(id), JSON.stringify(checkpoint, null, 2), "utf-8");
  return checkpoint;
}

/**
 * Delete a checkpoint.
 */
export async function deleteCheckpoint(id: string): Promise<boolean> {
  const path = getCheckpointPath(id);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}

/**
 * Clean up old checkpoints (older than 7 days).
 */
export async function cleanupOldCheckpoints(maxAgeDays = 7): Promise<number> {
  const all = await listCheckpoints();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const checkpoint of all) {
    if (new Date(checkpoint.createdAt).getTime() < cutoff) {
      await deleteCheckpoint(checkpoint.id);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Build a resume prompt for a coordinator that's picking up from a checkpoint.
 * This gives the fresh agent all the context it needs to continue.
 */
export function buildResumePrompt(checkpoint: Checkpoint): string {
  const completedSummary = checkpoint.completedResults
    .map((r) => `  - ${r.taskId}: ${r.success ? "✓" : "✗"} ${r.summary}`)
    .join("\n");

  const pendingList = checkpoint.pendingTasks
    .map((t) => `  - ${t.id}: ${t.description} (${t.role})`)
    .join("\n");

  return `You are resuming a coordinator workflow from a checkpoint.

## Original Goal
${checkpoint.goal}

## Checkpoint Reason
Type: ${checkpoint.type}
Reason: ${checkpoint.reason}
Prompt: ${checkpoint.prompt}

## User's Response
${checkpoint.userResponse ?? "(no response yet)"}

## Completed Tasks
${completedSummary || "  (none)"}

## Pending Tasks
${pendingList || "  (none)"}

## Instructions
Continue the workflow from where it left off. The user has responded to the checkpoint.
Execute the pending tasks, taking the user's response into account.
${checkpoint.context.additionalInstructions ? `\nAdditional context: ${JSON.stringify(checkpoint.context.additionalInstructions)}` : ""}`;
}
