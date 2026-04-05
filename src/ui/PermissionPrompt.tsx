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

// ── Shared helpers for boxed permission output ──

function permissionCols(): number {
  return Math.min(process.stdout.columns || 80, 72);
}

function padLine(cols: number, content: string, rawLen: number): string {
  const pad = Math.max(0, cols - 2 - 2 - rawLen);
  return BORDER_COLOR("│") + "  " + content + " ".repeat(pad) + BORDER_COLOR("│");
}

function emptyLine(cols: number): string {
  return BORDER_COLOR("│") + " ".repeat(cols - 2) + BORDER_COLOR("│");
}

function optionLabels(): { allowOnce: string; allowAlways: string; denyOnce: string; denyAlways: string } {
  return {
    allowOnce: chalk.green.bold("[Y]") + chalk.green(" Allow once"),
    allowAlways: chalk.cyan.bold("[A]") + chalk.cyan(" Allow always"),
    denyOnce: chalk.yellow.bold.underline("[N]") + chalk.yellow.bold(" Deny once"),
    denyAlways: chalk.red.bold("[D]") + chalk.red(" Deny always"),
  };
}

/**
 * Build a boxed permission prompt string for console output.
 * Adapts width to terminal columns.
 */
export function formatPermissionBox(toolName: string, description: string): string {
  const cols = permissionCols();
  const innerW = cols - 4; // account for "│  " + " │"

  const titleText = " ⚡ Permission Required ";
  // +1 because ⚡ is a 2-column wide emoji but .length counts it as 1
  const titleVisualWidth = titleText.length + 1;
  const topBar =
    BORDER_COLOR("┌─") +
    BORDER_COLOR.bold(titleText) +
    BORDER_COLOR("─".repeat(Math.max(0, cols - 2 - titleVisualWidth - 2)) + "┐");
  const empty = emptyLine(cols);
  const bottom = BORDER_COLOR("└" + "─".repeat(cols - 2) + "┘");

  const toolLabel = chalk.hex("#94A3B8")("Tool:   ") + chalk.hex("#F1F5F9").bold(toolName);
  const actionLabel = chalk.hex("#94A3B8")("Action: ") + chalk.hex("#CBD5E1")(truncate(description, innerW - 10));
  const { allowOnce, allowAlways, denyOnce, denyAlways } = optionLabels();

  const lines = [
    "",
    topBar,
    empty,
    padLine(cols, toolLabel, 8 + toolName.length),
    padLine(cols, actionLabel, 8 + Math.min(description.length, innerW - 10)),
    empty,
    padLine(cols, allowOnce + "    " + allowAlways, 28),
    padLine(cols, denyOnce + "     " + denyAlways, 28),
    empty,
    bottom,
    "",
  ];

  return lines.join("\n");
}

/**
 * Build a compact options-only reminder for invalid key presses.
 */
export function formatPermissionOptions(): string {
  const cols = permissionCols();
  const empty = emptyLine(cols);
  const { allowOnce, allowAlways, denyOnce, denyAlways } = optionLabels();

  const lines = [
    BORDER_COLOR("├" + "─".repeat(cols - 2) + "┤"),
    padLine(cols, BORDER_COLOR.bold("  Invalid key. Choose:"), 22),
    empty,
    padLine(cols, allowOnce + "    " + allowAlways, 28),
    padLine(cols, denyOnce + "     " + denyAlways, 28),
    empty,
    BORDER_COLOR("└" + "─".repeat(cols - 2) + "┘"),
  ];

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
