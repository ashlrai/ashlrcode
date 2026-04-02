/**
 * Unified color theme for AshlrCode CLI.
 *
 * Consistent palette across all UI elements for a premium feel.
 */

import chalk, { type ChalkInstance } from "chalk";

export const theme = {
  // Primary accent — bright cyan (matches AshlrAI brand)
  accent: chalk.hex("#00E5FF"),
  accentDim: chalk.hex("#00838F"),

  // Success / tools completing
  success: chalk.hex("#00E676"),
  successDim: chalk.hex("#1B5E20"),

  // Warning / approaching limits
  warning: chalk.hex("#FFD600"),
  warningDim: chalk.hex("#F57F17"),

  // Error / failures
  error: chalk.hex("#FF1744"),
  errorDim: chalk.hex("#B71C1C"),

  // Info / secondary content
  info: chalk.hex("#82B1FF"),
  infoDim: chalk.hex("#455A64"),

  // Plan mode
  plan: chalk.hex("#E040FB"),
  planDim: chalk.hex("#7B1FA2"),

  // Text hierarchy
  primary: chalk.hex("#E0E0E0"),     // main text
  secondary: chalk.hex("#9E9E9E"),   // secondary info
  tertiary: chalk.hex("#616161"),    // de-emphasized
  muted: chalk.hex("#424242"),       // very dim

  // Special
  cost: chalk.hex("#FFD54F"),        // cost/money display
  tokens: chalk.hex("#80DEEA"),      // token counts
  path: chalk.hex("#A5D6A7"),        // file paths

  // Tool categories
  toolName: chalk.hex("#00E5FF").bold,
  toolIcon: chalk.hex("#00B8D4"),
  toolResult: chalk.hex("#B0BEC5"),

  // Prompt styles
  prompt: {
    normal: chalk.hex("#00E676")("❯ "),
    plan: chalk.hex("#E040FB")("❯ "),
    edits: chalk.hex("#FFD600")("❯ "),
    yolo: chalk.hex("#FF1744")("❯ "),
  },
} as const;

/**
 * Format a file path with consistent styling.
 */
export function stylePath(p: string): string {
  return theme.path(p);
}

/**
 * Format a cost value.
 */
export function styleCost(usd: number): string {
  return theme.cost(`$${usd < 0.01 ? usd.toFixed(6) : usd.toFixed(4)}`);
}

/**
 * Format token count.
 */
export function styleTokens(count: number): string {
  if (count >= 1_000_000) return theme.tokens(`${(count / 1_000_000).toFixed(1)}M`);
  if (count >= 1_000) return theme.tokens(`${(count / 1_000).toFixed(0)}K`);
  return theme.tokens(`${count}`);
}
