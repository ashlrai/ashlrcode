/**
 * BuddyPanel — fixed-height Ink component for the buddy's ASCII art
 * with speech bubble rendered beside it.
 *
 * Key design decision: ALL art lines are rendered as a SINGLE <Text> element
 * with \n newlines, NOT as multiple child <Text key={i}> elements.
 *
 * Why: Ink's reconciler re-renders the live area on every state change. When
 * multiple <Text> children exist, the terminal cannot always clear the previous
 * render cleanly — especially in Claude Code's terminal emulator — causing
 * ghost/duplicate lines. A single Text with embedded newlines is treated as one
 * terminal region that Ink knows how to repaint atomically.
 *
 * The <Box height={N} flexShrink={0}> reserves a FIXED terminal region so Ink
 * knows exactly how many lines to clear on every re-render cycle.
 */

import { Box, Text } from "ink";
import React from "react";
import { type BuddyData, getBuddyArt } from "./buddy.ts";
import { renderBuddyWithBubble } from "./speech-bubble.ts";

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

// Module-level frame counter — incremented externally to avoid setInterval
// triggering full Ink re-renders (which causes duplicate separator lines).
let _buddyFrame = 0;
export function tickBuddyFrame() {
  _buddyFrame++;
}

export function BuddyPanel({ buddy, quip, quipType }: Props) {
  const height = getBuddyHeight();
  const art = getBuddyArt(buddy, _buddyFrame);
  const bubbleText = quipType === "suggestion" ? `💡 ${quip}` : quip;
  const lines = renderBuddyWithBubble(bubbleText, art, buddy.name, 1, height);

  // Render all lines as a SINGLE Text element joined by \n.
  // This is the critical fix: one React node = one terminal region = no ghost lines.
  // Multiple <Text key={i}> children cause Ink to emit separate cursor movements
  // per line, which race with the clear pass and leave artefacts.
  const singleBlock = lines.join("\n");

  return (
    <Box flexDirection="column" alignItems="flex-end" height={height} flexShrink={0}>
      <Text color="cyan">{singleBlock}</Text>
    </Box>
  );
}
