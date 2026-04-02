/**
 * Context window usage visualization with themed colors.
 */

import { theme, styleTokens } from "./theme.ts";
import { estimateTokens, getProviderContextLimit } from "../agent/context.ts";
import type { Message } from "../providers/types.ts";

const BAR_WIDTH = 24;

/**
 * Render the context usage bar with color-coded progress.
 */
export function renderContextBar(
  messages: Message[],
  providerName: string,
  systemPromptTokens: number = 0
): string {
  const limit = getProviderContextLimit(providerName);
  const used = estimateTokens(messages) + systemPromptTokens;
  const percentage = Math.min(100, Math.round((used / limit) * 100));

  if (percentage < 1 && messages.length < 3) return ""; // Don't show on first message

  const filled = Math.round((percentage / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  // Color based on usage level
  let barColor: (s: string) => string;
  let label: string;
  if (percentage < 25) {
    barColor = theme.success;
    label = theme.secondary(`${percentage}%`);
  } else if (percentage < 50) {
    barColor = theme.success;
    label = theme.secondary(`${percentage}%`);
  } else if (percentage < 75) {
    barColor = theme.warning;
    label = theme.warning(`${percentage}%`);
  } else {
    barColor = theme.error;
    label = theme.error(`${percentage}%`);
  }

  const filledBar = barColor("█".repeat(filled));
  const emptyBar = theme.muted("░".repeat(empty));

  return (
    theme.tertiary("  ctx ") +
    theme.muted("[") +
    filledBar +
    emptyBar +
    theme.muted("] ") +
    label +
    theme.muted(" · ") +
    styleTokens(used) +
    theme.muted(" / ") +
    styleTokens(limit)
  );
}
