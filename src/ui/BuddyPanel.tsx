/**
 * BuddyPanel — fixed-height Ink component for the buddy's ASCII art
 * with speech bubble rendered beside it.
 *
 * Owns its own terminal region so Ink knows exactly how many lines to
 * clear on re-render, preventing the duplication/flicker that plagued
 * the previous inline approach.
 */

import React from "react";
import { Box, Text } from "ink";
import { renderBuddyWithBubble } from "./speech-bubble.ts";

interface Props {
  art: string[];
  name: string;
  quip: string;
  quipType: "quip" | "suggestion" | "reaction";
}

export function BuddyPanel({ art, name, quip, quipType }: Props) {
  const formatted = quipType === "suggestion" ? `💡 ${quip}` : quip;
  const lines = renderBuddyWithBubble(formatted, art, name, 1);
  const height = lines.length;

  return (
    <Box flexDirection="column" alignItems="flex-end" height={height} flexShrink={0}>
      {lines.map((line, i) => <Text key={i} color="cyan">{line}</Text>)}
    </Box>
  );
}
