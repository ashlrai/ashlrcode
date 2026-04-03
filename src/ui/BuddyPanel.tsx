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

const PANEL_WIDTH = 20;
// Suggestion quips have a "💡 " prefix (~3 cols); others have 1-col padding
const MAX_QUIP_WIDTH: Record<Props["quipType"], number> = {
  suggestion: PANEL_WIDTH - 4,
  reaction: PANEL_WIDTH - 1,
  quip: PANEL_WIDTH - 2, // quotes add 2 chars but they're outside the text
};

export function BuddyPanel({ art, name, quip, quipType }: Props) {
  // Fixed height = art lines + name line + quip line
  const height = art.length + 2;
  const maxWidth = MAX_QUIP_WIDTH[quipType];
  const truncatedQuip = quip.length > maxWidth
    ? quip.slice(0, maxWidth - 1) + "…"
    : quip;

  return (
    <Box flexDirection="column" alignItems="flex-end" height={height} flexShrink={0}>
      {art.map((line, i) => <Text key={i} color="cyan">{line}</Text>)}
      <Text color="cyan" bold>{name}</Text>
      <QuipText quip={truncatedQuip} quipType={quipType} />
    </Box>
  );
}

function QuipText({ quip, quipType }: Pick<Props, "quip" | "quipType">) {
  if (quipType === "suggestion") {
    return <Text color="green">💡 {quip}</Text>;
  }
  if (quipType === "reaction") {
    return <Text color="yellow">{quip}</Text>;
  }
  return <Text dimColor italic>"{quip}"</Text>;
}
