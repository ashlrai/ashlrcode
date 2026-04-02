/**
 * Tool registry — manages available tools and dispatches calls.
 * Integrates with hook system for pre/post tool execution.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolDefinition } from "../providers/types.ts";
import { toolToDefinition } from "./types.ts";
import { runPreToolHooks, runPostToolHooks, type HooksConfig } from "../config/hooks.ts";

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
    context: ToolContext
  ): Promise<{ result: string; isError: boolean }> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { result: `Unknown tool: ${toolName}`, isError: true };
    }

    // Validate input
    const validationError = tool.validateInput(input);
    if (validationError) {
      return { result: `Validation error: ${validationError}`, isError: true };
    }

    // Check permissions for non-read-only tools (before hooks, so hooks
    // don't execute shell commands for tools the user would deny)
    if (!tool.isReadOnly()) {
      const inputPreview = formatInputPreview(toolName, input);
      const allowed = await context.requestPermission(toolName, inputPreview);
      if (!allowed) {
        return { result: "Permission denied by user", isError: true };
      }
    }

    // Run pre-tool hooks (after permission check)
    const hookResult = await runPreToolHooks(this.hooks, toolName, input);
    if (hookResult.action === "deny") {
      return { result: hookResult.message ?? "Denied by hook", isError: true };
    }

    try {
      const result = await tool.call(input, context);

      // Run post-tool hooks (fire and forget)
      runPostToolHooks(this.hooks, toolName, input, result).catch(() => {});

      return { result, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error: ${message}`, isError: true };
    }
  }
}
