/**
 * Hook system — pre/post tool execution hooks from settings.json.
 *
 * Hooks can approve, deny, or modify tool calls via shell commands.
 */

export interface HookDefinition {
  /** Match by tool name (exact or glob pattern) */
  toolName?: string;
  /** Match by input pattern (regex against JSON-serialized input) */
  inputPattern?: string;
  /** Shell command to execute (has access to env vars: TOOL_NAME, TOOL_INPUT) */
  command?: string;
  /** Direct action without running a command */
  action?: "allow" | "deny";
  /** Message to show when action is deny */
  message?: string;
}

export interface HooksConfig {
  preToolUse?: HookDefinition[];
  postToolUse?: HookDefinition[];
}

export interface PreHookResult {
  action: "allow" | "deny";
  message?: string;
}

/**
 * Run pre-tool-use hooks. Returns deny if any hook denies.
 */
export async function runPreToolHooks(
  hooks: HooksConfig,
  toolName: string,
  input: Record<string, unknown>
): Promise<PreHookResult> {
  const preHooks = hooks.preToolUse ?? [];

  for (const hook of preHooks) {
    if (!matchesHook(hook, toolName, input)) continue;

    // Direct action (no command needed)
    if (hook.action === "deny") {
      return { action: "deny", message: hook.message ?? `Denied by hook for ${toolName}` };
    }
    if (hook.action === "allow") {
      return { action: "allow" };
    }

    // Run shell command
    if (hook.command) {
      const result = await runHookCommand(hook.command, toolName, input);
      if (result.exitCode !== 0) {
        return {
          action: "deny",
          message: result.output || `Hook command failed for ${toolName}`,
        };
      }
    }
  }

  return { action: "allow" };
}

/**
 * Run post-tool-use hooks. Fire-and-forget.
 */
export async function runPostToolHooks(
  hooks: HooksConfig,
  toolName: string,
  input: Record<string, unknown>,
  result: string
): Promise<void> {
  const postHooks = hooks.postToolUse ?? [];

  for (const hook of postHooks) {
    if (!matchesHook(hook, toolName, input)) continue;

    if (hook.command) {
      // Fire and forget
      runHookCommand(hook.command, toolName, input, result).catch(() => {});
    }
  }
}

function matchesHook(
  hook: HookDefinition,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  // Match tool name
  if (hook.toolName) {
    if (hook.toolName.includes("*")) {
      try {
        // Escape regex metacharacters, then expand * to .*
        const escaped = hook.toolName
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*");
        const regex = new RegExp("^" + escaped + "$");
        if (!regex.test(toolName)) return false;
      } catch {
        // Invalid pattern, fall back to exact match
        if (hook.toolName !== toolName) return false;
      }
    } else if (hook.toolName !== toolName) {
      return false;
    }
  }

  // Match input pattern (with length guard against ReDoS)
  if (hook.inputPattern) {
    const inputStr = JSON.stringify(input);
    // Guard against catastrophic backtracking on large inputs
    if (inputStr.length > 10_000) {
      // For very large inputs, use simple string.includes as fallback
      if (!inputStr.includes(hook.inputPattern)) return false;
    } else {
      try {
        const regex = new RegExp(hook.inputPattern);
        if (!regex.test(inputStr)) return false;
      } catch {
        return false; // Invalid regex, skip this hook
      }
    }
  }

  return true;
}

/**
 * Convert settings.json toolHooks format into internal HooksConfig.
 * This bridges the user-facing config shape (tool/inputPattern/command/action)
 * to the internal HookDefinition shape (toolName/inputPattern/command/action/message).
 */
export function loadHooksFromSettings(toolHooks: {
  preToolUse?: Array<{
    tool?: string;
    inputPattern?: string;
    command?: string;
    action?: "allow" | "deny";
  }>;
  postToolUse?: Array<{
    tool?: string;
    command?: string;
  }>;
}): HooksConfig {
  const config: HooksConfig = {};

  if (toolHooks.preToolUse) {
    config.preToolUse = toolHooks.preToolUse.map((rule) => ({
      toolName: rule.tool,
      inputPattern: rule.inputPattern,
      command: rule.command,
      action: rule.action,
      message: rule.action === "deny" ? `Denied by toolHooks rule for ${rule.tool ?? "*"}` : undefined,
    }));
  }

  if (toolHooks.postToolUse) {
    config.postToolUse = toolHooks.postToolUse.map((rule) => ({
      toolName: rule.tool,
      command: rule.command,
    }));
  }

  return config;
}

async function runHookCommand(
  command: string,
  toolName: string,
  input: Record<string, unknown>,
  result?: string
): Promise<{ exitCode: number; output: string }> {
  const env = {
    ...process.env,
    TOOL_NAME: toolName,
    TOOL_INPUT: JSON.stringify(input),
    ...(result ? { TOOL_RESULT: result.slice(0, 10_000) } : {}),
  };

  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Timeout hook commands at 15 seconds
  const timeoutId = setTimeout(() => proc.kill(), 15_000);

  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);
    return { exitCode, output: stdout.trim() };
  } catch {
    clearTimeout(timeoutId);
    return { exitCode: 1, output: "Hook command timed out" };
  }
}
