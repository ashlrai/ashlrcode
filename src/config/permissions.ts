/**
 * Permission rules — configurable allow/deny/ask rules for tools.
 */

export interface PermissionRule {
  tool: string;
  pattern?: string; // regex to match against tool input
  action: "allow" | "deny" | "ask";
}

export interface PermissionConfig {
  rules: PermissionRule[];
  /** Tools that are always allowed without asking */
  alwaysAllow: Set<string>;
  /** Tools that are always denied */
  alwaysDeny: Set<string>;
}

const DEFAULT_ALWAYS_ALLOW = new Set(["Read", "Glob", "Grep", "AskUser", "WebFetch"]);
const DEFAULT_ALWAYS_DENY = new Set<string>();

let config: PermissionConfig = {
  rules: [],
  alwaysAllow: DEFAULT_ALWAYS_ALLOW,
  alwaysDeny: DEFAULT_ALWAYS_DENY,
};

export function getPermissionConfig(): PermissionConfig {
  return config;
}

export function shouldAskPermission(toolName: string): boolean {
  if (config.alwaysDeny.has(toolName)) return false; // will be blocked
  if (config.alwaysAllow.has(toolName)) return false; // auto-allowed
  return true; // ask user
}

export function isToolAllowed(toolName: string): boolean {
  if (config.alwaysDeny.has(toolName)) return false;
  return true;
}

export function addAlwaysAllow(toolName: string): void {
  config.alwaysAllow.add(toolName);
  config.alwaysDeny.delete(toolName);
}

export function addAlwaysDeny(toolName: string): void {
  config.alwaysDeny.add(toolName);
  config.alwaysAllow.delete(toolName);
}
