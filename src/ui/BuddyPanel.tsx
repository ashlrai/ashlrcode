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

const MAX_QUIP_WIDTH = 18; // 20-col box minus 2 for padding/emoji

export function BuddyPanel({ art, name, quip, quipType }: Props) {
  // Fixed height = art lines + name line + quip line
  const height = art.length + 2;
  const truncatedQuip = quip.length > MAX_QUIP_WIDTH
    ? quip.slice(0, MAX_QUIP_WIDTH - 1) + "…"
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
