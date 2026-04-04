/**
 * BuddyPanel — fixed-height Ink component for the buddy's ASCII art
 * with speech bubble rendered beside it.
 *
 * Owns its animation cycle via React hooks so only this component
 * re-renders on frame ticks — prevents ghost lines from full-app rerenders.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { renderBuddyWithBubble } from "./speech-bubble.ts";
import { getBuddyArt, type BuddyData } from "./buddy.ts";

interface Props {
  buddy: BuddyData;
  quip: string;
  quipType: "quip" | "suggestion" | "reaction";
}

// Fixed height: covers most art (5 lines) + name + short bubble without excess space
const FIXED_HEIGHT = 6;

export function BuddyPanel({ buddy, quip, quipType }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame(f => f + 1), 1500);
    return () => clearInterval(id);
  }, []);

  const art = getBuddyArt(buddy, frame);
  const bubbleText = quipType === "suggestion" ? `💡 ${quip}` : quip;
  const lines = renderBuddyWithBubble(bubbleText, art, buddy.name, 1, FIXED_HEIGHT);

  return (
    <Box flexDirection="column" alignItems="flex-end" height={FIXED_HEIGHT} flexShrink={0}>
      {lines.map((line, i) => <Text key={i} color="cyan">{line}</Text>)}
    </Box>
  );
}
