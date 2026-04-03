/**
 * AsyncLocalStorage context isolation — per-agent namespace safety.
 * Prevents context leakage between concurrent sub-agents sharing a process.
 *
 * Each sub-agent runs inside its own AsyncLocalStorage store so that any
 * code calling getAgentContext() sees the correct agent identity, cwd, and
 * permission flags without prop-drilling through every layer.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentContext {
  agentId: string;
  agentName: string;
  cwd: string;
  readOnly: boolean;
  parentAgentId?: string;
  /** Nesting depth: 0 = root REPL session */
  depth: number;
  startedAt: string;
}

const storage = new AsyncLocalStorage<AgentContext>();

/** Run a function with an isolated agent context. */
export function runWithAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Get the current agent context (null if not inside any agent scope). */
export function getAgentContext(): AgentContext | null {
  return storage.getStore() ?? null;
}

/** Create a child context derived from an optional parent. */
export function createChildContext(
  parentCtx: AgentContext | null,
  name: string,
  cwd: string,
  readOnly: boolean,
): AgentContext {
  return {
    agentId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentName: name,
    cwd,
    readOnly,
    parentAgentId: parentCtx?.agentId,
    depth: (parentCtx?.depth ?? -1) + 1,
    startedAt: new Date().toISOString(),
  };
}

/** True when running inside a nested sub-agent (depth > 0). */
export function isNestedAgent(): boolean {
  const ctx = getAgentContext();
  return ctx !== null && ctx.depth > 0;
}

/** Human-readable label for the current agent scope (for logs/debugging). */
export function getAgentChain(): string {
  const ctx = getAgentContext();
  if (!ctx) return "(no agent context)";
  return `${ctx.agentName} (depth=${ctx.depth}, id=${ctx.agentId})`;
}
