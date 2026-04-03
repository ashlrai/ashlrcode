/**
 * BuddyPanel — fixed-height Ink component for the buddy's ASCII art.
 *
 * Owns its own terminal region so Ink knows exactly how many lines to
 * clear on re-render, preventing the duplication/flicker that plagued
 * the previous inline approach.
 */

import React from "react";
import { Box, Text } from "ink";

interface Props {
  art: string[];
  name: string;
  quip: string;
  quipType: "quip" | "suggestion" | "reaction";
}

export function BuddyPanel({ art, name, quip, quipType }: Props) {
  // Fixed height = art lines + name line + quip line
  const height = art.length + 2;

  return (
    <Box flexDirection="column" alignItems="flex-end" height={height} flexShrink={0}>
      <Text color="cyan">{art.join("\n")}</Text>
      <Text color="cyan" bold>{name}</Text>
      {quipType === "suggestion" ? (
        <Text color="green">💡 {quip}</Text>
      ) : quipType === "reaction" ? (
        <Text color="yellow">{quip}</Text>
      ) : (
        <Text dimColor italic>"{quip}"</Text>
      )}
    </Box>
  );
}
