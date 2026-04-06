/**
 * BuddyPanel — fixed-height Ink component for the buddy's ASCII art
 * with speech bubble rendered beside it.
 *
 * Owns its animation cycle via React hooks so only this component
 * re-renders on frame ticks — prevents ghost lines from full-app rerenders.
 */

import React from "react";
import { Box, Text } from "ink";
import { renderBuddyWithBubble } from "./speech-bubble.ts";
import { getBuddyArt, type BuddyData } from "./buddy.ts";

interface Props {
  buddy: BuddyData;
  quip: string;
  quipType: "quip" | "suggestion" | "reaction";
}

// Responsive height: max 6 lines, or 15% of terminal height
function getBuddyHeight(): number {
  const rows = process.stdout.rows;
  if (!rows) return 6;
  return Math.min(6, Math.floor(rows * 0.15));
}

// Module-level frame counter — incremented by the buddy animation in buddy.ts
// No setInterval here to avoid triggering full Ink re-renders (causes duplicate separator lines)
let _buddyFrame = 0;
export function tickBuddyFrame() { _buddyFrame++; }

export function BuddyPanel({ buddy, quip, quipType }: Props) {
  const height = getBuddyHeight();
  const art = getBuddyArt(buddy, _buddyFrame);
  const bubbleText = quipType === "suggestion" ? `💡 ${quip}` : quip;
  const lines = renderBuddyWithBubble(bubbleText, art, buddy.name, 1, height);

  return (
    <Box flexDirection="column" alignItems="flex-end" height={height} flexShrink={0}>
      {lines.map((line, i) => <Text key={i} color="cyan">{line}</Text>)}
    </Box>
  );
}
