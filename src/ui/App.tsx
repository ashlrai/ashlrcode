/**
 * Main Ink REPL — clean layout.
 *
 * Output scrolls above. Buddy + bubble right-aligned above input.
 * Full-width input box. Status line below.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
// speech-bubble.ts available but not used in live area (causes duplication)

interface OutputItem { id: number; text: string; }

interface AppProps {
  onSubmit: (text: string) => void;
  onExit: () => void;
  onModeSwitch: () => void;
  mode: string;
  modeColor: string;
  contextPercent: number;
  contextUsed: string;
  contextLimit: string;
  buddyName: string;
  buddyQuip: string;
  buddyQuipType: "quip" | "suggestion" | "reaction";
  buddyArt: string[];
  items: OutputItem[];
  isProcessing: boolean;
  spinnerText: string;
  commands: string[];
}

export function App({
  onSubmit, onExit, onModeSwitch, mode, modeColor,
  contextPercent, contextUsed, contextLimit,
  buddyName, buddyQuip, buddyQuipType, buddyArt,
  items, isProcessing, spinnerText, commands,
}: AppProps) {
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0); // Change key to force remount (resets cursor)
  const { exit } = useApp();
  const w = process.stdout.columns || 80;

  const suggestion = input.startsWith("/") && input.length > 1
    ? commands.find(c => c.startsWith(input) && c !== input)
    : undefined;

  const handleSubmit = useCallback((value: string) => {
    const text = value.trim();
    setInput("");
    setInputKey(k => k + 1); // Remount to reset cursor
    if (text) onSubmit(text);
  }, [onSubmit]);

  const handleModeSwitch = useCallback(() => onModeSwitch(), [onModeSwitch]);

  // Accept autocomplete: set value AND force remount to reset cursor to end
  const acceptSuggestion = useCallback(() => {
    if (!suggestion) return;
    setInput(suggestion + " ");
    setInputKey(k => k + 1); // Force TextInput remount — cursor goes to end
  }, [suggestion]);

  useInput(useCallback((ch: string, key: any) => {
    if (key.ctrl && ch === "c") { onExit(); exit(); }
    if (key.tab && key.shift) { handleModeSwitch(); return; }
    if (key.tab && suggestion) { acceptSuggestion(); return; }
    if (key.rightArrow && suggestion && input.length > 0) { acceptSuggestion(); }
  }, [suggestion, input, handleModeSwitch, onExit, exit, acceptSuggestion]));

  const barWidth = 10;
  const filled = Math.round((contextPercent / 100) * barWidth);
  const empty = barWidth - filled;
  const ctxColor = contextPercent < 50 ? "green" : contextPercent < 75 ? "yellow" : "red";

  return (
    <Box flexDirection="column">
      {/* Scrollable output */}
      <Static items={items}>
        {(item) => <Text key={item.id}>{item.text}</Text>}
      </Static>

      {/* Spinner */}
      {isProcessing && <Text dimColor>  ⠋ {spinnerText}</Text>}

      {/* Input box — full width */}
      <Text dimColor>{"-".repeat(w)}</Text>
      <Box>
        <Text color={modeColor} bold>❯ </Text>
        {isProcessing ? (
          <Text dimColor>waiting for response...</Text>
        ) : (
          <Box>
            <TextInput
              key={inputKey}
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="Type a message..."
            />
            {suggestion && <Text dimColor>{suggestion.slice(input.length)}</Text>}
          </Box>
        )}
      </Box>
      {/* Autocomplete hints */}
      {input.startsWith("/") && input.length > 1 && !isProcessing && (
        <Box marginLeft={2}>
          <Text dimColor>{commands.filter(c => c.startsWith(input)).slice(0, 5).join("  ")}</Text>
          {suggestion && <Text dimColor italic>  tab ↹</Text>}
        </Box>
      )}
      <Text dimColor>{"-".repeat(w)}</Text>

      {/* Status + Buddy — single row to avoid multi-line flicker */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={modeColor} bold>❯❯ </Text>
          <Text color={modeColor}>{mode}</Text>
          <Text dimColor> (shift+tab)</Text>
          <Text>{"    "}</Text>
          <Text color={ctxColor}>{"█".repeat(filled)}</Text>
          <Text dimColor>{"░".repeat(empty)}</Text>
          <Text> </Text>
          <Text color={ctxColor}>{contextPercent}%</Text>
          <Text dimColor> · {contextUsed}/{contextLimit}</Text>
        </Box>
        <Box>
          {/* Buddy art as single text — prevents duplication */}
          <Text color="cyan" dimColor>{buddyArt.join(" ")}</Text>
          <Text> </Text>
          <Text color="cyan" bold>{buddyName}</Text>
        </Box>
      </Box>
      {/* Buddy quip — separate line, right-aligned */}
      <Box justifyContent="flex-end">
        {buddyQuipType === "suggestion" ? (
          <Text color="green">💡 {buddyQuip}</Text>
        ) : buddyQuipType === "reaction" ? (
          <Text color="yellow">{buddyQuip}</Text>
        ) : (
          <Text dimColor italic>{buddyName}: "{buddyQuip}"</Text>
        )}
      </Box>
    </Box>
  );
}
