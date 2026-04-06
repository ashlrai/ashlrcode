/**
 * cmux Split Management — spawn sub-agents in visible terminal panes.
 *
 * When running inside cmux, sub-agents can be dispatched to separate
 * split panes instead of running in-process. This gives visual feedback
 * of parallel agent work in the cmux sidebar.
 *
 * Falls back to in-process execution when cmux is not available.
 */

import { isCmuxAvailable, createSplit, sendText, type SplitOptions } from "./client.ts";

export interface CmuxAgentSplit {
  surfaceId: string;
  direction: SplitOptions["direction"];
  agentName: string;
}

const activeSplits = new Map<string, CmuxAgentSplit>();

/**
 * Spawn an AshlrCode sub-agent in a new cmux split pane.
 * Returns the surface ID if successful, null if cmux is unavailable.
 *
 * The sub-agent is launched as a new `ac --print` process in the split,
 * which runs the prompt in single-shot mode and exits.
 */
export async function spawnAgentInSplit(
  agentName: string,
  prompt: string,
  options: {
    direction?: SplitOptions["direction"];
    readOnly?: boolean;
    /** Additional flags to pass to `ac` */
    flags?: string[];
  } = {},
): Promise<string | null> {
  if (!isCmuxAvailable()) return null;

  const direction = options.direction ?? "right";
  const safeFlags: string[] = [];
  if (options.readOnly) safeFlags.push("--plan");
  // Only allow known safe flags — reject anything that looks like injection
  for (const flag of options.flags ?? []) {
    if (/^--[a-z-]+$/.test(flag)) safeFlags.push(flag);
  }

  // Shell-escape prompt: wrap in single quotes, escape internal single quotes
  const escaped = prompt.replace(/'/g, "'\\''");
  const command = `ac --print ${safeFlags.join(" ")} '${escaped}'`;

  const surfaceId = await createSplit({ direction, command });
  if (surfaceId) {
    activeSplits.set(agentName, { surfaceId, direction, agentName });
  }
  return surfaceId;
}

/**
 * Send a follow-up message to an existing split agent.
 */
export async function sendToSplit(agentName: string, text: string): Promise<boolean> {
  const split = activeSplits.get(agentName);
  if (!split) return false;
  return sendText(split.surfaceId, text);
}

/**
 * Get all active agent splits.
 */
export function getActiveSplits(): CmuxAgentSplit[] {
  return Array.from(activeSplits.values());
}

/**
 * Remove a split from tracking (called after the agent finishes).
 */
export function removeSplit(agentName: string): void {
  activeSplits.delete(agentName);
}

/**
 * Check if cmux splits are available for sub-agent dispatch.
 */
export function canUseSplits(): boolean {
  return isCmuxAvailable();
}
