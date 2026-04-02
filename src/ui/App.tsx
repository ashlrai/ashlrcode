/**
 * Main Ink REPL application.
 *
 * Layout: output scrolls above, input box with buddy beside it at bottom.
 * Buddy sits to the right of the input lines (like Claude Code's Velum).
 */

import React, { useState, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import TextInput from "ink-text-input";

interface OutputItem {
  id: number;
  text: string;
}

interface AppProps {
  onSubmit: (text: string) => void;
  onExit: () => void;
  mode: string;
  modeColor: string;
  contextPercent: number;
  contextUsed: string;
  contextLimit: string;
  buddyName: string;
  buddyQuip: string;
  buddyArt: string[];
  items: OutputItem[];
  isProcessing: boolean;
  spinnerText: string;
}

export function App({
  onSubmit,
  onExit,
  mode,
  modeColor,
  contextPercent,
  contextUsed,
  contextLimit,
  buddyName,
  buddyQuip,
  buddyArt,
  items,
  isProcessing,
  spinnerText,
}: AppProps) {
  const [input, setInput] = useState("");
  const { exit } = useApp();
  const w = process.stdout.columns || 80;
  const buddyWidth = 16; // space reserved for buddy on the right
  const lineWidth = w - buddyWidth;

  const handleSubmit = useCallback((value: string) => {
    const text = value.trim();
    setInput("");
    if (text) onSubmit(text);
  }, [onSubmit]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      onExit();
      exit();
    }
  });

  // Context bar
  const barWidth = 10;
  const filled = Math.round((contextPercent / 100) * barWidth);
  const empty = barWidth - filled;
  const ctxColor = contextPercent < 50 ? "green" : contextPercent < 75 ? "yellow" : "red";

  return (
    <Box flexDirection="column">
      {/* Scrollable output */}
      <Static items={items}>
        {(item) => (
          <Text key={item.id}>{item.text}</Text>
        )}
      </Static>

      {/* Spinner when processing */}
      {isProcessing && (
        <Text dimColor>  ⠋ {spinnerText}</Text>
      )}

      {/* Input area + Buddy side by side */}
      <Box>
        {/* Left: input box */}
        <Box flexDirection="column" width={lineWidth}>
          <Text dimColor>{"─".repeat(lineWidth)}</Text>
          <Box>
            <Text color={modeColor} bold>❯ </Text>
            {isProcessing ? (
              <Text dimColor>waiting for response...</Text>
            ) : (
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                placeholder="Type a message..."
              />
            )}
          </Box>
          <Text dimColor>{"─".repeat(lineWidth)}</Text>
          {/* Status line */}
          <Box justifyContent="space-between">
            <Box>
              <Text color={modeColor} bold>❯❯ </Text>
              <Text color={modeColor}>{mode}</Text>
              <Text dimColor> (shift+tab)</Text>
            </Box>
            <Box>
              <Text color={ctxColor}>{"█".repeat(filled)}</Text>
              <Text dimColor>{"░".repeat(empty)}</Text>
              <Text> </Text>
              <Text color={ctxColor}>{contextPercent}%</Text>
              <Text dimColor> · {contextUsed}/{contextLimit}</Text>
            </Box>
          </Box>
        </Box>

        {/* Right: Buddy — sits beside the input lines */}
        <Box flexDirection="column" alignItems="center" width={buddyWidth} marginLeft={1}>
          {buddyArt.map((artLine, i) => (
            <Text key={i} color="cyan">{artLine}</Text>
          ))}
          <Text color="cyan" bold>{buddyName}</Text>
        </Box>
      </Box>

      {/* Buddy speech bubble — left of buddy, right-aligned */}
      <Box justifyContent="flex-end" marginRight={buddyWidth + 1}>
        <Text dimColor italic>"{buddyQuip}"</Text>
      </Box>
    </Box>
  );
}
