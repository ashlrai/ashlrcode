/**
 * Tool capability check — validates tool availability for a given provider
 * before execution and returns structured results with alternatives.
 *
 * Used by the tool registry at registration time and by the executor at
 * dispatch time to surface provider-mismatch errors early.
 */

import {
  globalCapabilityRegistry,
  type ProviderId,
  type SupportLevel,
} from "../providers/capability-registry.ts";

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
