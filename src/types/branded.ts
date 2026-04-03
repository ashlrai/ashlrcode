/**
 * Branded types — compile-time safety for string types.
 * Prevents accidentally passing a SessionId where a SystemPrompt is expected.
 *
 * Usage: wrap raw strings with the `as*` helpers when creating values,
 * then use the branded type in function signatures for type-safe APIs.
 *
 * Not yet adopted in existing code — available for new code going forward.
 */

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type SystemPrompt = Brand<string, "SystemPrompt">;
export type SessionId = Brand<string, "SessionId">;
export type AgentId = Brand<string, "AgentId">;
export type ToolName = Brand<string, "ToolName">;

export function asSystemPrompt(s: string): SystemPrompt { return s as SystemPrompt; }
export function asSessionId(s: string): SessionId { return s as SessionId; }
export function asAgentId(s: string): AgentId { return s as AgentId; }
export function asToolName(s: string): ToolName { return s as ToolName; }
