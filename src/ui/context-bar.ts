/**
 * Context window usage visualization.
 *
 * Shows a progress bar indicating how full the context window is.
 */

import chalk from "chalk";
import { estimateTokens, getProviderContextLimit } from "../agent/context.ts";
import type { Message } from "../providers/types.ts";

const BAR_WIDTH = 20;

/**
 * Render the context usage bar.
 */
export function renderContextBar(
  messages: Message[],
  providerName: string,
  systemPromptTokens: number = 0
): string {
  const limit = getProviderContextLimit(providerName);
  const used = estimateTokens(messages) + systemPromptTokens;
  const percentage = Math.min(100, Math.round((used / limit) * 100));

  const filled = Math.round((percentage / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  // Color based on usage
  let colorFn: (s: string) => string;
  if (percentage < 50) {
    colorFn = chalk.green;
  } else if (percentage < 75) {
    colorFn = chalk.yellow;
  } else {
    colorFn = chalk.red;
  }

  const bar = colorFn("█".repeat(filled)) + chalk.dim("░".repeat(empty));
  const label = formatTokenCount(used);
  const limitLabel = formatTokenCount(limit);

  return chalk.dim("  Context: ") + bar + chalk.dim(` ${percentage}% (${label} / ${limitLabel})`);
}

/**
 * Render a compact inline context indicator for the prompt line.
 */
export function renderContextInline(
  messages: Message[],
  providerName: string
): string {
  const limit = getProviderContextLimit(providerName);
  const used = estimateTokens(messages);
  const percentage = Math.min(100, Math.round((used / limit) * 100));

  if (percentage < 25) return ""; // Don't show when context is mostly empty

  let colorFn: (s: string) => string;
  if (percentage < 50) colorFn = chalk.green;
  else if (percentage < 75) colorFn = chalk.yellow;
  else colorFn = chalk.red;

  return colorFn(`${percentage}%`);
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return `${count}`;
}
