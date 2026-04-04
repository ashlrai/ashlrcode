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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[permissions] Corrupted permissions file, starting fresh:", msg);
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

// --- Ink-mode permission resolver (callback-based, like AskUser) ---

let pendingPermissionResolve: ((decision: "allow_once" | "always_allow" | "deny_once" | "always_deny") => void) | null = null;
let pendingPermissionInfo: { toolName: string; description: string } | null = null;

export function hasPendingPermission(): boolean {
  return pendingPermissionResolve !== null;
}

export function getPendingPermissionInfo(): { toolName: string; description: string } | null {
  return pendingPermissionInfo;
}

/**
 * Resolve a pending Ink-mode permission prompt with a single-key answer.
 * Returns true if the key was recognized and the pending prompt was resolved.
 */
export function answerPendingPermission(key: string): boolean {
  if (!pendingPermissionResolve) return false;
  const decisions: Record<string, "allow_once" | "always_allow" | "deny_once" | "always_deny"> = {
    y: "allow_once",
    a: "always_allow",
    n: "deny_once",
    d: "always_deny",
  };
  const decision = decisions[key.toLowerCase()];
  if (!decision) return false;

  pendingPermissionResolve(decision);
  pendingPermissionResolve = null;
  pendingPermissionInfo = null;
  return true;
}

/**
 * Request permission in Ink mode. Blocks (via Promise) until the user
 * types a recognized key (y/a/n/d) that gets routed through
 * answerPendingPermission().
 */
export async function requestPermissionInk(toolName: string, description: string): Promise<boolean> {
  pendingPermissionInfo = { toolName, description };

  const decision = await new Promise<"allow_once" | "always_allow" | "deny_once" | "always_deny">((resolve) => {
    pendingPermissionResolve = resolve;
  });

  await recordPermission(toolName, decision);
  if (decision === "allow_once") allowForSession(toolName);

  return decision === "allow_once" || decision === "always_allow";
}

export function resetPermissionsForTests(): void {
  state = {
    alwaysAllow: new Set(),
    alwaysDeny: new Set(),
    sessionAllow: new Set(),
  };
  bypassMode = false;
  autoAcceptEdits = false;
  rules = [];
}

// --- Input-based permission rules ---

export interface PermissionRule {
  tool: string;           // Exact name or simple glob ("File*", "*Bash")
  inputPattern?: string;  // Regex to match against JSON-stringified input
  action: "allow" | "deny" | "ask";
}

let rules: PermissionRule[] = [];

function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  if (pattern.startsWith("*") && toolName.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

/**
 * Check input-based permission rules. Returns the action of the first matching rule,
 * or null if no rule matches.
 */
export function checkRules(toolName: string, input?: Record<string, unknown>): "allow" | "deny" | "ask" | null {
  const inputStr = input ? JSON.stringify(input) : "";
  for (const rule of rules) {
    if (!matchesToolPattern(rule.tool, toolName)) continue;
    if (rule.inputPattern) {
      try { if (!new RegExp(rule.inputPattern).test(inputStr)) continue; }
      catch { continue; }
    }
    return rule.action;
  }
  return null;
}

export function setRules(newRules: PermissionRule[]): void { rules = newRules; }
export function getRules(): PermissionRule[] { return rules; }
