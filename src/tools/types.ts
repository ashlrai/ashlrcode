/**
 * Tool interface — every tool implements this contract.
 * Follows Claude Code's pattern: validate → permissions → execute.
 */

import type { ToolDefinition } from "../providers/types.ts";

export interface ToolContext {
  cwd: string;
  /** Ask user for permission to run a tool */
  requestPermission: (tool: string, description: string) => Promise<boolean>;
  /** Current turn number (for file history tracking) */
  turnNumber?: number;
  /** Session ID (for task board, persistence) */
  sessionId?: string;
}

export interface Tool {
  /** Tool name used in API calls */
  name: string;

  /** Human-readable description for the LLM */
  prompt(): string;

  /** JSON Schema for the tool's input parameters */
  inputSchema(): Record<string, unknown>;

  /** Whether this tool only reads data (safe in plan mode) */
  isReadOnly(): boolean;

  /** Whether this tool could cause damage if misused */
  isDestructive(): boolean;

  /** Whether multiple instances can run concurrently */
  isConcurrencySafe(): boolean;

  /** Validate input before execution */
  validateInput(input: Record<string, unknown>): string | null;

  /** Tool-specific permission check. Return null if allowed, or error string if denied. */
  checkPermissions?(input: Record<string, unknown>, context: ToolContext): string | null;

  /** Execute the tool and return result text */
  call(input: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/** Convert a Tool to the provider-facing ToolDefinition */
export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.prompt(),
    input_schema: tool.inputSchema(),
  };
}
