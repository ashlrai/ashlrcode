/**
 * Tool registry — manages available tools and dispatches calls.
 * Integrates with hook system for pre/post tool execution.
 *
 * v2.1: Added tool execution timeouts and permission mutex to prevent
 * parallel agents from double-prompting for the same tool permission.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolDefinition } from "../providers/types.ts";
import { toolToDefinition } from "./types.ts";
import { runPreToolHooks, runPostToolHooks, type HooksConfig } from "../config/hooks.ts";
import { checkRules } from "../config/permissions.ts";
import { emitSpan } from "../telemetry/pulse-hud.ts";
import {
  checkSurgicalToolGate,
  formatSurgicalBlockMessage,
  type SurgicalGateOptions,
} from "./guards/surgical-tool-gate.ts";
import { getMCPFallbackManager } from "../mcp/fallback-manager.ts";

/** Default timeout for tool execution (2 minutes). Configurable via settings.toolTimeoutMs. */
let DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Tools exempt from execution timeout (they wait for external input or spawn long-running sub-agents). */
const NO_TIMEOUT_TOOLS = new Set(["AskUser", "Agent", "Coordinate"]);

/** Override the default tool timeout (called from settings). */
export function setDefaultToolTimeout(ms: number): void {
  DEFAULT_TOOL_TIMEOUT_MS = ms;
}

/**
 * Simple async mutex for serializing permission prompts.
 * Prevents parallel agents from showing duplicate permission dialogs.
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const permissionMutex = new AsyncMutex();

function formatInputPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return `Run: ${input.command}`;
    case "Write":
      return `Write to: ${input.file_path}`;
    case "Edit":
      return `Edit: ${input.file_path}`;
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private hooks: HooksConfig = {};
  private _surgicalGate: SurgicalGateOptions | null = null;

  /** Activate surgical-mode tool restrictions for this registry instance. */
  setSurgicalGate(opts: SurgicalGateOptions): void {
    this._surgicalGate = opts;
  }

  /** Deactivate surgical-mode tool restrictions. */
  clearSurgicalGate(): void {
    this._surgicalGate = null;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  setHooks(hooks: HooksConfig): void {
    this.hooks = hooks;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(toolToDefinition);
  }

  /** Get only read-only tools (for plan mode) */
  getReadOnlyDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter((t) => t.isReadOnly())
      .map(toolToDefinition);
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    /** Override the default tool execution timeout (ms). */
    timeoutMs?: number
  ): Promise<{ result: string; isError: boolean }> {
    // Pre-execution fallback check: if this looks like an MCP tool name and
    // the owning server is degraded, suggest the built-in fallback proactively
    // so the agent can switch without stalling.
    if (toolName.startsWith("mcp__")) {
      const fallbackMgr = getMCPFallbackManager();
      if (fallbackMgr.isServerDegraded(toolName)) {
        const suggestion = fallbackMgr.resolveFallback(toolName);
        if (suggestion) {
          return {
            result: `MCP server degraded. Suggested fallback for "${toolName}": use "${suggestion}" instead.`,
            isError: true,
          };
        }
      }
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      return { result: `Unknown tool: ${toolName}`, isError: true };
    }

    // Validate input first (before permissions — don't prompt for invalid input)
    const validationError = tool.validateInput(input);
    if (validationError) {
      return { result: `Validation error: ${validationError}`, isError: true };
    }

    // Semantic validation — deeper checks (path traversal, dangerous patterns, glob breadth).
    // Runs after schema validation but before permission prompts.
    if (tool.validateSemantics) {
      const semanticError = await tool.validateSemantics(input, context);
      if (semanticError) {
        return { result: `Permission denied (semantic validation): ${semanticError}`, isError: true };
      }
    }

    // Surgical tool gate — in surgical mode, restrict which tools and Bash
    // patterns are allowed based on the active ScopeTier. Runs after semantic
    // validation but before permission prompts so blocked tools never surface
    // a permission dialog.
    if (this._surgicalGate) {
      const gateResult = checkSurgicalToolGate(toolName, input, this._surgicalGate);
      if (gateResult.verdict === "block") {
        return {
          result: formatSurgicalBlockMessage(gateResult),
          isError: true,
        };
      }
    }

    // Check permissions for non-read-only tools.
    // Uses mutex to prevent parallel agents from showing duplicate permission dialogs.
    if (!tool.isReadOnly()) {
      const ruleResult = checkRules(toolName, input);
      if (ruleResult === "deny") {
        return { result: "Denied by permission rule", isError: true };
      }
      if (ruleResult !== "allow") {
        // Serialize permission prompts across parallel agents
        await permissionMutex.acquire();
        try {
          // Re-check rules in case another agent's prompt changed them
          const recheck = checkRules(toolName, input);
          if (recheck === "deny") {
            return { result: "Denied by permission rule", isError: true };
          }
          if (recheck !== "allow") {
            const inputPreview = formatInputPreview(toolName, input);
            const allowed = await context.requestPermission(toolName, inputPreview);
            if (!allowed) {
              return { result: "Permission denied by user", isError: true };
            }
          }
        } finally {
          permissionMutex.release();
        }
      }
    }

    // Tool-specific permission check
    if (tool.checkPermissions) {
      const permError = tool.checkPermissions(input, context);
      if (permError) {
        return { result: `Permission denied: ${permError}`, isError: true };
      }
    }

    // Run pre-tool hooks (after permission check)
    const hookResult = await runPreToolHooks(this.hooks, toolName, input);
    if (hookResult.action === "deny") {
      return { result: hookResult.message ?? "Denied by hook", isError: true };
    }

    // Execute tool with timeout protection (exempt tools that wait for human input or run sub-agents)
    const skipTimeout = NO_TIMEOUT_TOOLS.has(toolName);
    const timeout = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const _spanStart = Date.now();
    try {
      const result = skipTimeout
        ? await tool.call(input, context)
        : await Promise.race([
            tool.call(input, context),
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`Tool "${toolName}" timed out after ${Math.round(timeout / 1000)}s`)),
                timeout
              );
            }),
          ]);

      // Run post-tool hooks (fire and forget)
      runPostToolHooks(this.hooks, toolName, input, result).catch(() => {});

      emitSpan({ name: `tool ${toolName}`, kind: "tool", durationMs: Date.now() - _spanStart, attrs: { "gen_ai.tool.name": toolName } });
      return { result, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitSpan({ name: `tool ${toolName}`, kind: "tool", durationMs: Date.now() - _spanStart, error: message, attrs: { "gen_ai.tool.name": toolName } });
      return { result: `Error: ${message}`, isError: true };
    }
  }
}
