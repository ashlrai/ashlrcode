/**
 * Main Ink REPL application.
 *
 * Uses Ink's <Static> for scrollable output above,
 * and a live InputBox pinned at the bottom.
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
  items,
  isProcessing,
  spinnerText,
}: AppProps) {
  const [input, setInput] = useState("");
  const { exit } = useApp();
  const w = process.stdout.columns || 80;
  const line = "─".repeat(w);

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

      {/* Input box */}
      <Text dimColor>{line}</Text>
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
      <Text dimColor>{line}</Text>

      {/* Status line */}
      <Box>
        <Text color={modeColor} bold>❯❯ </Text>
        <Text color={modeColor}>{mode} mode</Text>
        <Text dimColor> (shift+tab to cycle)</Text>
        <Text>{"        "}</Text>
        <Text color={ctxColor}>{"█".repeat(filled)}</Text>
        <Text dimColor>{"░".repeat(empty)}</Text>
        <Text> </Text>
        <Text color={ctxColor}>{contextPercent}%</Text>
        <Text dimColor> · {contextUsed}/{contextLimit}</Text>
        <Text dimColor> · {buddyName}: "{buddyQuip}"</Text>
      </Box>
    </Box>
  );
}
