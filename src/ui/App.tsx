/**
 * Main Ink REPL — clean layout.
 *
 * Output scrolls above. Buddy + bubble right-aligned above input.
 * Full-width input box. Status line below.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { BuddyPanel } from "./BuddyPanel.tsx";
import { getAction, type InputHistory } from "./keybindings.ts";

interface OutputItem { id: number; text: string; }

interface AppProps {
  onSubmit: (text: string) => void;
  onExit: () => void;
  onModeSwitch: () => void;
  onUndo?: () => void;
  onEffortCycle?: () => void;
  onCompact?: () => void;
  onClearScreen?: () => void;
  onVoiceToggle?: () => void;
  inputHistory?: InputHistory;
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
  onSubmit, onExit, onModeSwitch, onUndo, onEffortCycle, onCompact, onClearScreen, onVoiceToggle,
  inputHistory, mode, modeColor,
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
    // Map Ink key event to a normalized key name
    const keyName = key.tab ? "tab" : key.upArrow ? "up" : key.downArrow ? "down"
      : key.leftArrow ? "left" : key.rightArrow ? "right" : key.escape ? "escape"
      : key.return ? "return" : key.backspace ? "backspace" : key.delete ? "delete"
      : ch;

    const action = getAction(keyName, !!key.ctrl, !!key.shift, !!key.meta);

    switch (action) {
      case "exit":
        onExit(); exit(); return;
      case "mode-switch":
        handleModeSwitch(); return;
      case "autocomplete":
        if (suggestion && (key.tab || (key.rightArrow && input.length > 0))) {
          acceptSuggestion();
        }
        return;
      case "history-prev":
        if (inputHistory) {
          const prev = inputHistory.prev(input);
          if (prev !== null) { setInput(prev); setInputKey(k => k + 1); }
        }
        return;
      case "history-next":
        if (inputHistory) {
          const next = inputHistory.next();
          if (next !== null) { setInput(next); setInputKey(k => k + 1); }
        }
        return;
      case "clear-input":
        setInput(""); setInputKey(k => k + 1); return;
      case "undo":
        onUndo?.(); return;
      case "effort-cycle":
        onEffortCycle?.(); return;
      case "compact":
        onCompact?.(); return;
      case "clear-screen":
        onClearScreen?.(); return;
      case "voice-toggle":
        onVoiceToggle?.(); return;
    }
  }, [suggestion, input, handleModeSwitch, onExit, exit, acceptSuggestion, inputHistory, onUndo, onEffortCycle, onCompact, onClearScreen, onVoiceToggle]));

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
      {/* Autocomplete hints — only shown when typing a slash command */}
      {input.startsWith("/") && input.length > 1 && !isProcessing && (
        <Box marginLeft={2}>
          <Text dimColor>{commands.filter(c => c.startsWith(input)).slice(0, 5).join("  ")}</Text>
          {suggestion && <Text dimColor italic>  tab ↹</Text>}
        </Box>
      )}
      <Text dimColor>{"-".repeat(w)}</Text>

      {/* Bottom: status left, buddy right */}
      <Box>
        <Box flexGrow={1} flexDirection="column">
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
        </Box>

        {/* Buddy panel — fixed height, right-aligned */}
        <Box width={42} flexShrink={0}>
          <BuddyPanel art={buddyArt} name={buddyName} quip={buddyQuip} quipType={buddyQuipType} />
        </Box>
      </Box>
    </Box>
  );
}
