/**
 * Ink-based input box component.
 *
 * Renders: top line → prompt with text input → bottom line → status
 * Cursor stays at the input because Ink manages positioning.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { Mode } from "./mode.ts";

interface InputBoxProps {
  mode: Mode;
  contextPercent: number;
  contextUsed: string;
  contextLimit: string;
  buddyName: string;
  buddyQuip: string;
  onSubmit: (text: string) => void;
}

export function InputBox({
  mode,
  contextPercent,
  contextUsed,
  contextLimit,
  buddyName,
  buddyQuip,
  onSubmit,
}: InputBoxProps) {
  const [input, setInput] = useState("");
  const { exit } = useApp();

  useInput((ch, key) => {
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (text) onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl && ch === "c") {
      exit();
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  const w = process.stdout.columns || 80;
  const line = "─".repeat(w);

  // Mode colors
  const modeColors: Record<string, string> = {
    normal: "green",
    plan: "magenta",
    "accept-edits": "yellow",
    yolo: "red",
  };
  const modeColor = modeColors[mode] ?? "green";

  // Context bar
  const barWidth = 10;
  const filled = Math.round((contextPercent / 100) * barWidth);
  const empty = barWidth - filled;
  const ctxColor = contextPercent < 50 ? "green" : contextPercent < 75 ? "yellow" : "red";

  return (
    <Box flexDirection="column">
      {/* Top line */}
      <Text dimColor>{line}</Text>

      {/* Prompt + input */}
      <Box>
        <Text color={modeColor} bold>❯ </Text>
        <Text>{input}</Text>
        <Text dimColor>█</Text>
      </Box>

      {/* Bottom line */}
      <Text dimColor>{line}</Text>

      {/* Status line */}
      <Box>
        <Text color={modeColor} bold>❯❯ </Text>
        <Text color={modeColor}>{mode} mode</Text>
        <Text dimColor> (shift+tab to cycle)</Text>
        <Text>{"          "}</Text>
        <Text color={ctxColor}>{"█".repeat(filled)}</Text>
        <Text dimColor>{"░".repeat(empty)}</Text>
        <Text> </Text>
        <Text color={ctxColor}>{contextPercent}%</Text>
        <Text dimColor> · {contextUsed}/{contextLimit}</Text>
        <Text dimColor> · {buddyName}: </Text>
        <Text dimColor>"{buddyQuip}"</Text>
      </Box>
    </Box>
  );
}
