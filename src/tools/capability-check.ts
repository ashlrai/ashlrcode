/**
 * Tool capability check — validates tool availability for a given provider
 * before execution and returns structured results with alternatives.
 *
 * Used by the tool registry at registration time and by the executor at
 * dispatch time to surface provider-mismatch errors early.
 *
 * Enhanced with adaptive per-tool provider fallback:
 * - When a tool is not natively supported by the current provider,
 *   and a better provider is available at a cost multiplier ≤ 1.5×,
 *   the tool is automatically promoted to that provider for this dispatch only.
 * - Dispatch events are logged via event-log.ts for observability.
 */

import {
  globalCapabilityRegistry,
  type ProviderId,
  type SupportLevel,
} from "../providers/capability-registry.ts";
import {
  logToolDispatch,
  recordDispatch,
  type ToolDispatchEvent,
} from "../telemetry/event-log.ts";

export interface CapabilityCheckOutput {
  /** Whether the tool can execute on the given provider. */
  canExecute: boolean;
  /** Support level for this provider. */
  supportLevel: SupportLevel;
  /** Cost multiplier applied to base token cost. */
  costMultiplier: number;
  /**
   * Human-readable reason describing the capability status.
   * Useful for logging and error messages.
   */
  reason: string;
  /**
   * Alternative tool names to try when canExecute is false.
   * Ordered by preference (first = best substitute).
   */
  alternatives: string[];
}

/**
 * Result of an adaptive fallback dispatch resolution.
 *
 * When the current provider lacks native support, resolveToolDispatch() will
 * attempt to find a better provider within the cost ceiling and return it here.
 */
export interface DispatchResolution {
  /** Provider that will actually execute the tool. */
  resolvedProvider: ProviderId;
  /** Whether a fallback provider was selected (vs. the requested one). */
  didFallback: boolean;
  /** Original provider that was requested. */
  originalProvider: ProviderId;
  /** Support level on the resolved provider. */
  supportLevel: SupportLevel;
  /** Cost multiplier on the resolved provider. */
  costMultiplier: number;
  /** Delta between resolved and original cost multipliers (0 when no fallback). */
  costDelta: number;
  /** Human-readable explanation of the resolution decision. */
  reason: string;
  /**
   * If no provider can support this tool at all, structured warning is populated.
   * Mirrors the contextOverflow warning pattern.
   */
  warning?: UnsupportedToolWarning;
}

export interface UnsupportedToolWarning {
  tool: string;
  requestedProvider: ProviderId;
  alternatives: string[];
  message: string;
}

/** Maximum cost multiplier ratio before auto-promotion is refused. */
export const AUTO_PROMOTE_COST_CEILING = 1.5;

/**
 * Validate whether a tool can be executed by a specific provider.
 *
 * When `provider` is omitted the check passes unconditionally so the registry
 * can be used in provider-agnostic contexts without breaking existing callers.
 */
export function checkToolCapability(
  toolName: string,
  provider?: ProviderId
): CapabilityCheckOutput {
  // No provider specified — optimistic pass.
  if (!provider) {
    return {
      canExecute: true,
      supportLevel: "native",
      costMultiplier: 1.0,
      reason: `No provider specified — assuming "${toolName}" is available.`,
      alternatives: [],
    };
  }

  return globalCapabilityRegistry.canExecute(toolName, provider);
}

/**
 * Validate all tools in a list and return a map of toolName → check result.
 * Useful for batch pre-flight checks before a wave of tool calls.
 */
export function checkAllCapabilities(
  toolNames: string[],
  provider: ProviderId
): Map<string, CapabilityCheckOutput> {
  const results = new Map<string, CapabilityCheckOutput>();
  for (const name of toolNames) {
    results.set(name, checkToolCapability(name, provider));
  }
  return results;
}

/**
 * Log a capability mismatch warning to stderr.
 * Called by the tool executor when a tool/provider combination is unsupported
 * or only emulated, so operators can observe degraded-mode execution.
 */
export function logCapabilityMismatch(
  toolName: string,
  provider: ProviderId,
  result: CapabilityCheckOutput
): void {
  if (result.canExecute && result.supportLevel === "native") return; // No mismatch

  const tag = result.canExecute ? "DEGRADED" : "BLOCKED";
  const alts =
    result.alternatives.length > 0
      ? ` Alternatives: [${result.alternatives.join(", ")}].`
      : "";
  process.stderr.write(
    `[capability] ${tag} tool="${toolName}" provider=${provider} level=${result.supportLevel} cost=×${result.costMultiplier.toFixed(2)} — ${result.reason}${alts}\n`
  );
}

/**
 * Resolve the best provider for a single tool dispatch.
 *
 * Algorithm:
 * 1. Check the requested provider's support level.
 * 2. If native — no fallback needed; return as-is.
 * 3. If not native — find the best native-supporting provider via
 *    getBestProvider({ preferLowestCost: true, exclude: [requestedProvider] }).
 * 4. If the best alternative's cost multiplier is ≤ AUTO_PROMOTE_COST_CEILING,
 *    auto-promote to it for this dispatch only.
 * 5. If no provider supports the tool at all, emit a structured warning.
 *
 * The result is always logged as a tool_dispatch event (async, non-blocking).
 *
 * @param toolName         Name of the tool being dispatched.
 * @param requestedProvider The provider currently active for the session.
 * @param logAsync         If true (default), fire-and-forget logToolDispatch.
 */
export function resolveToolDispatch(
  toolName: string,
  requestedProvider: ProviderId,
  logAsync = true
): DispatchResolution {
  const currentCheck = globalCapabilityRegistry.canExecute(toolName, requestedProvider);

  // Happy path: current provider is native — nothing to do.
  if (currentCheck.supportLevel === "native") {
    const payload: ToolDispatchEvent = {
      tool: toolName,
      provider: requestedProvider,
      fallback_provider: null,
      cost_delta: 0,
      reason: "native support on requested provider",
    };
    recordDispatch(payload);
    if (logAsync) void logToolDispatch(payload);
    return {
      resolvedProvider: requestedProvider,
      didFallback: false,
      originalProvider: requestedProvider,
      supportLevel: "native",
      costMultiplier: currentCheck.costMultiplier,
      costDelta: 0,
      reason: payload.reason,
    };
  }

  // Tool is not native on requested provider — look for a better one.
  // Only promote to a provider that has NATIVE support (skip emulated/via-mcp).
  const best = globalCapabilityRegistry.getBestProvider(toolName, {
    preferLowestCost: true,
    exclude: currentCheck.canExecute ? [] : [], // consider all providers
  });

  // No provider can run this tool at all.
  if (best.provider === null) {
    const cap = globalCapabilityRegistry.get(toolName);
    const alternatives = cap?.substitutes ?? [];
    const warning: UnsupportedToolWarning = {
      tool: toolName,
      requestedProvider,
      alternatives,
      message:
        alternatives.length > 0
          ? `No provider supports "${toolName}". Consider using: ${alternatives.join(", ")}.`
          : `No provider supports "${toolName}" and no substitutes are registered.`,
    };
    process.stderr.write(
      `[capability] UNSUPPORTED tool="${toolName}" provider=${requestedProvider}` +
        (alternatives.length > 0 ? ` alternatives=[${alternatives.join(", ")}]` : "") +
        ` — ${warning.message}\n`
    );
    const payload: ToolDispatchEvent = {
      tool: toolName,
      provider: requestedProvider,
      fallback_provider: null,
      cost_delta: 0,
      reason: warning.message,
    };
    recordDispatch(payload);
    if (logAsync) void logToolDispatch(payload);
    return {
      resolvedProvider: requestedProvider,
      didFallback: false,
      originalProvider: requestedProvider,
      supportLevel: "unsupported",
      costMultiplier: currentCheck.costMultiplier,
      costDelta: 0,
      reason: warning.message,
      warning,
    };
  }

  // Best provider found — check if it's native and within cost ceiling.
  const bestCheck = globalCapabilityRegistry.canExecute(toolName, best.provider);
  const baseCost = currentCheck.costMultiplier > 0 ? currentCheck.costMultiplier : 1.0;
  const ratio = bestCheck.costMultiplier / baseCost;

  // Only auto-promote when best provider has native support and cost is acceptable.
  const shouldPromote =
    bestCheck.supportLevel === "native" && ratio <= AUTO_PROMOTE_COST_CEILING;

  if (!shouldPromote) {
    // Stay on current provider — it can run the tool (just not natively).
    const reason = bestCheck.supportLevel !== "native"
      ? `No native provider available; running "${toolName}" on ${requestedProvider} at level "${currentCheck.supportLevel}"`
      : `Best native provider ${best.provider} exceeds cost ceiling (×${ratio.toFixed(2)} > ×${AUTO_PROMOTE_COST_CEILING}); staying on ${requestedProvider}`;
    const payload: ToolDispatchEvent = {
      tool: toolName,
      provider: requestedProvider,
      fallback_provider: null,
      cost_delta: 0,
      reason,
    };
    recordDispatch(payload);
    if (logAsync) void logToolDispatch(payload);
    return {
      resolvedProvider: requestedProvider,
      didFallback: false,
      originalProvider: requestedProvider,
      supportLevel: currentCheck.supportLevel,
      costMultiplier: currentCheck.costMultiplier,
      costDelta: 0,
      reason,
    };
  }

  // Auto-promote to native provider for this dispatch only.
  const costDelta = bestCheck.costMultiplier - baseCost;
  const reason =
    `Auto-promoted "${toolName}" from ${requestedProvider} (${currentCheck.supportLevel}) ` +
    `to ${best.provider} (native) — cost ×${bestCheck.costMultiplier.toFixed(2)} (+${costDelta >= 0 ? "+" : ""}${costDelta.toFixed(2)})`;

  process.stderr.write(`[capability] PROMOTE tool="${toolName}" ${requestedProvider}→${best.provider} — ${reason}\n`);

  const payload: ToolDispatchEvent = {
    tool: toolName,
    provider: requestedProvider,
    fallback_provider: best.provider,
    cost_delta: costDelta,
    reason,
  };
  recordDispatch(payload);
  if (logAsync) void logToolDispatch(payload);

  return {
    resolvedProvider: best.provider,
    didFallback: true,
    originalProvider: requestedProvider,
    supportLevel: "native",
    costMultiplier: bestCheck.costMultiplier,
    costDelta,
    reason,
  };
}
