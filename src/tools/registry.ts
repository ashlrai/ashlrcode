/**
 * Tool registry — manages available tools and dispatches calls.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolDefinition } from "../providers/types.ts";
import { toolToDefinition } from "./types.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
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

    // Check permissions for destructive tools
    if (tool.isDestructive()) {
      const allowed = await context.requestPermission(
        tool.name,
        `Execute ${tool.name} (destructive operation)`
      );
      if (!allowed) {
        return { result: "Permission denied by user", isError: true };
      }
    }

    try {
      const result = await tool.call(input, context);
      return { result, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error: ${message}`, isError: true };
    }
  }
}
