/**
 * Permission system — configurable allow/deny/ask rules with persistence.
 *
 * Permissions are saved to ~/.ashlrcode/permissions.json and persist
 * across sessions. Users can choose:
 *   y = allow once
 *   a = always allow (persisted)
 *   n = deny once
 *   d = always deny (persisted)
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "./settings.ts";

export interface PermissionState {
  alwaysAllow: Set<string>;
  alwaysDeny: Set<string>;
  /** Session-only allows (not persisted) */
  sessionAllow: Set<string>;
}

interface PersistedPermissions {
  alwaysAllow: string[];
  alwaysDeny: string[];
}

function getPermissionsPath(): string {
  return join(getConfigDir(), "permissions.json");
}

// Default read-only tools that never need permission
const READ_ONLY_AUTO_ALLOW = new Set([
  "Read", "Glob", "Grep", "AskUser", "WebFetch",
  "EnterPlan", "ExitPlan", "PlanWrite",
  "TaskCreate", "TaskUpdate", "TaskList",
  "Agent",
]);

let state: PermissionState = {
  alwaysAllow: new Set(),
  alwaysDeny: new Set(),
  sessionAllow: new Set(),
};

/** Bypass mode — when true, all permissions are auto-approved */
let bypassMode = false;

/** Auto-accept edits — when true, Write/Edit are auto-approved but Bash still asks */
let autoAcceptEdits = false;

export function setBypassMode(enabled: boolean): void {
  bypassMode = enabled;
}

export function setAutoAcceptEdits(enabled: boolean): void {
  autoAcceptEdits = enabled;
}

export function isBypassMode(): boolean {
  return bypassMode;
}

export async function loadPermissions(): Promise<void> {
  const permissionsPath = getPermissionsPath();
  if (!existsSync(permissionsPath)) return;

  try {
    const raw = await readFile(permissionsPath, "utf-8");
    const data = JSON.parse(raw) as PersistedPermissions;
    state.alwaysAllow = new Set(data.alwaysAllow ?? []);
    state.alwaysDeny = new Set(data.alwaysDeny ?? []);
  } catch {
    // Corrupted file, start fresh
  }
}

async function savePermissions(): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  const data: PersistedPermissions = {
    alwaysAllow: Array.from(state.alwaysAllow),
    alwaysDeny: Array.from(state.alwaysDeny),
  };
  await writeFile(getPermissionsPath(), JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Check if a tool needs user permission.
 * Returns: "allow" (auto-approved), "deny" (auto-blocked), "ask" (prompt user)
 */
export function checkPermission(toolName: string): "allow" | "deny" | "ask" {
  // Bypass mode — approve everything
  if (bypassMode) return "allow";

  // Read-only tools are always allowed
  if (READ_ONLY_AUTO_ALLOW.has(toolName)) return "allow";

  // Auto-accept edits mode — approve Write/Edit but still ask for Bash
  if (autoAcceptEdits && (toolName === "Write" || toolName === "Edit")) return "allow";

  // Check persistent deny
  if (state.alwaysDeny.has(toolName)) return "deny";

  // Check persistent allow
  if (state.alwaysAllow.has(toolName)) return "allow";

  // Check session allow
  if (state.sessionAllow.has(toolName)) return "allow";

  return "ask";
}

/**
 * Record a permission decision.
 */
export async function recordPermission(
  toolName: string,
  decision: "allow_once" | "always_allow" | "deny_once" | "always_deny"
): Promise<void> {
  switch (decision) {
    case "allow_once":
      // No persistence needed
      break;
    case "always_allow":
      state.alwaysAllow.add(toolName);
      state.alwaysDeny.delete(toolName);
      await savePermissions();
      break;
    case "deny_once":
      // No persistence needed
      break;
    case "always_deny":
      state.alwaysDeny.add(toolName);
      state.alwaysAllow.delete(toolName);
      await savePermissions();
      break;
  }
}

/**
 * Allow a tool for this session only (not persisted).
 */
export function allowForSession(toolName: string): void {
  state.sessionAllow.add(toolName);
}

export function getPermissionState(): PermissionState {
  return state;
}

export function resetPermissionsForTests(): void {
  state = {
    alwaysAllow: new Set(),
    alwaysDeny: new Set(),
    sessionAllow: new Set(),
  };
  bypassMode = false;
  autoAcceptEdits = false;
}
