/**
 * BuddyPanel — fixed-height Ink component for the buddy's ASCII art
 * with speech bubble rendered beside it.
 *
 * Uses a constant height to prevent Ink's Static component from
 * miscounting terminal lines on re-render (which causes duplication).
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

// Fixed height: covers most art (5 lines) + name + short bubble without excess space
const FIXED_HEIGHT = 6;

export function BuddyPanel({ art, name, quip, quipType }: Props) {
  const bubbleText = quipType === "suggestion" ? `💡 ${quip}` : quip;
  const lines = renderBuddyWithBubble(bubbleText, art, name, 1, FIXED_HEIGHT);

  return (
    <Box flexDirection="column" alignItems="flex-end" height={FIXED_HEIGHT} flexShrink={0}>
      {lines.map((line, i) => <Text key={i} color="cyan">{line}</Text>)}
    </Box>
  );
}
