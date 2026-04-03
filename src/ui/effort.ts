/**
 * Effort levels — adjust model behavior and token limits.
 *
 * /effort low    → Fast, cheap, less thorough (fewer iterations, shorter responses)
 * /effort normal → Default balanced behavior
 * /effort high   → Maximum thoroughness (more iterations, detailed responses)
 */

export type EffortLevel = "low" | "normal" | "high";

let currentEffort: EffortLevel = "normal";

export function getEffort(): EffortLevel {
  return currentEffort;
}

export function setEffort(level: EffortLevel): void {
  currentEffort = level;
}

export function cycleEffort(): EffortLevel {
  const levels: EffortLevel[] = ["low", "normal", "high"];
  const idx = levels.indexOf(currentEffort);
  currentEffort = levels[(idx + 1) % levels.length]!;
  return currentEffort;
}

/**
 * Get agent config overrides for the current effort level.
 */
export function getEffortConfig(): {
  maxIterations: number;
  maxTokens: number;
  systemPromptSuffix: string;
} {
  switch (currentEffort) {
    case "low":
      return {
        maxIterations: 10,
        maxTokens: 4096,
        systemPromptSuffix: "\n\nIMPORTANT: Be extremely concise. Give the shortest correct answer. Minimize tool calls. Prefer speed over thoroughness.",
      };
    case "high":
      return {
        maxIterations: 50,
        maxTokens: 16384,
        systemPromptSuffix: "\n\nIMPORTANT: Be extremely thorough. Explore all edge cases. Use multiple tools to verify. Explain your reasoning in detail. Quality over speed.",
      };
    case "normal":
    default:
      return {
        maxIterations: 25,
        maxTokens: 8192,
        systemPromptSuffix: "",
      };
  }
}

export function getEffortEmoji(): string {
  switch (currentEffort) {
    case "low": return "⚡";
    case "high": return "🔬";
    default: return "⚖️";
  }
}
