/**
 * Ink component for tool permission prompts.
 *
 * Renders a styled permission request inline in the REPL output,
 * showing the tool name, description, and available key options.
 */

import { Box, Text } from "ink";
import React from "react";

interface Props {
  toolName: string;
  description: string;
}

export function PermissionPrompt({ toolName, description }: Props) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="yellow" bold>
          ⚡ Permission:{" "}
        </Text>
        <Text bold>{toolName}</Text>
      </Box>
      <Text dimColor> {description}</Text>
      <Box marginTop={1}>
        <Text dimColor> [y] allow [a] always [n] deny [d] always deny</Text>
      </Box>
    </Box>
  );
}

// ── Boxed permission prompt strings (for console output) ──

import chalk from "chalk";

const BORDER_COLOR = chalk.hex("#FBBF24"); // amber-400 (warning/yellow)
const DIM_BORDER = chalk.hex("#D97706"); // amber-500 (dimmer)

/**
 * Build a boxed permission prompt string for console output.
 * Adapts width to terminal columns.
 */
export function formatPermissionBox(toolName: string, description: string): string {
  const cols = Math.min(process.stdout.columns || 80, 72);
  const innerW = cols - 4; // account for "│  " + " │"

  const titleText = " ⚡ Permission Required ";
  const topBar =
    BORDER_COLOR("┌─") +
    chalk.hex("#FBBF24").bold(titleText) +
    BORDER_COLOR("─".repeat(Math.max(0, cols - 2 - titleText.length - 2)) + "┐");
  const emptyLine = BORDER_COLOR("│") + " ".repeat(cols - 2) + BORDER_COLOR("│");
  const bottom = BORDER_COLOR("└" + "─".repeat(cols - 2) + "┘");

  function padLine(content: string, rawLen: number): string {
    const pad = Math.max(0, cols - 2 - 2 - rawLen);
    return BORDER_COLOR("│") + "  " + content + " ".repeat(pad) + BORDER_COLOR("│");
  }

  const toolLabel = chalk.hex("#94A3B8")("Tool:   ") + chalk.hex("#F1F5F9").bold(toolName);
  const actionLabel = chalk.hex("#94A3B8")("Action: ") + chalk.hex("#CBD5E1")(truncate(description, innerW - 10));

  const allowOnce = chalk.green.bold("[Y]") + chalk.green(" Allow once");
  const allowAlways = chalk.cyan.bold("[A]") + chalk.cyan(" Allow always");
  const denyOnce = chalk.yellow.bold.underline("[N]") + chalk.yellow.bold(" Deny once");
  const denyAlways = chalk.red.bold("[D]") + chalk.red(" Deny always");

  const lines = [
    "",
    topBar,
    emptyLine,
    padLine(toolLabel, 8 + toolName.length),
    padLine(actionLabel, 8 + Math.min(description.length, innerW - 10)),
    emptyLine,
    padLine(allowOnce + "    " + allowAlways, 28),
    padLine(denyOnce + "     " + denyAlways, 28),
    emptyLine,
    bottom,
    "",
  ];

  return lines.join("\n");
}

/**
 * Build a compact options-only reminder for invalid key presses.
 */
export function formatPermissionOptions(): string {
  const cols = Math.min(process.stdout.columns || 80, 72);
  const emptyLine = BORDER_COLOR("│") + " ".repeat(cols - 2) + BORDER_COLOR("│");

  const allowOnce = chalk.green.bold("[Y]") + chalk.green(" Allow once");
  const allowAlways = chalk.cyan.bold("[A]") + chalk.cyan(" Allow always");
  const denyOnce = chalk.yellow.bold.underline("[N]") + chalk.yellow.bold(" Deny once");
  const denyAlways = chalk.red.bold("[D]") + chalk.red(" Deny always");

  function padLine(content: string, rawLen: number): string {
    const pad = Math.max(0, cols - 2 - 2 - rawLen);
    return BORDER_COLOR("│") + "  " + content + " ".repeat(pad) + BORDER_COLOR("│");
  }

  const lines = [
    BORDER_COLOR("├" + "─".repeat(cols - 2) + "┤"),
    padLine(chalk.hex("#FBBF24").bold("  Invalid key. Choose:"), 22),
    emptyLine,
    padLine(allowOnce + "    " + allowAlways, 28),
    padLine(denyOnce + "     " + denyAlways, 28),
    emptyLine,
    BORDER_COLOR("└" + "─".repeat(cols - 2) + "┘"),
  ];

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
