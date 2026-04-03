/**
 * Main Ink REPL application.
 *
 * Layout: output scrolls above, input box with buddy beside it at bottom.
 * Buddy sits to the right of the input lines (like Claude Code's Velum).
 */

import React, { useState, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { renderBuddyWithBubble } from "./speech-bubble.ts";

interface OutputItem {
  id: number;
  text: string;
}

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
  buddyArt: string[];
  items: OutputItem[];
  isProcessing: boolean;
  spinnerText: string;
  /** Available slash commands for autocomplete */
  commands: string[];
}

export function App({
  onSubmit,
  onExit,
  onModeSwitch,
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
  commands,
}: AppProps) {
  const [input, setInput] = useState("");
  const { exit } = useApp();
  const w = process.stdout.columns || 80;
  const buddyWidth = 16;
  const lineWidth = w - buddyWidth;

  // Autocomplete: find matching command when input starts with /
  const suggestion = input.startsWith("/") && input.length > 1
    ? commands.find(c => c.startsWith(input) && c !== input)
    : undefined;

  const handleSubmit = useCallback((value: string) => {
    const text = value.trim();
    setInput("");
    if (text) onSubmit(text);
  }, [onSubmit]);

  const handleModeSwitch = useCallback(() => {
    onModeSwitch();
  }, [onModeSwitch]);

  useInput(useCallback((ch: string, key: any) => {
    if (key.ctrl && ch === "c") {
      onExit();
      exit();
    }
    // Shift+Tab cycles mode
    if (key.tab && key.shift) {
      handleModeSwitch();
      return;
    }
    // Tab or right arrow accepts autocomplete (only if suggestion exists)
    if (key.tab && suggestion) {
      setInput(suggestion + " "); // trailing space moves cursor to end
      return;
    }
    if (key.rightArrow && suggestion && input.length > 0) {
      setInput(suggestion + " ");
    }
  }, [suggestion, input, handleModeSwitch, onExit, exit]));

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
          <Text dimColor>{"-".repeat(lineWidth)}</Text>
          <Box>
            <Text color={modeColor} bold>❯ </Text>
            {isProcessing ? (
              <Text dimColor>waiting for response...</Text>
            ) : (
              <Box>
                <TextInput
                  value={input}
                  onChange={setInput}
                  onSubmit={handleSubmit}
                  placeholder="Type a message..."
                />
                {suggestion && (
                  <Text dimColor>{suggestion.slice(input.length)}</Text>
                )}
              </Box>
            )}
          </Box>
          {/* Autocomplete suggestions */}
          {input.startsWith("/") && input.length > 1 && !isProcessing && (
            <Box marginLeft={2}>
              <Text dimColor>
                {commands.filter(c => c.startsWith(input)).slice(0, 5).join("  ")}
              </Text>
              {suggestion && <Text dimColor italic>  tab ↹</Text>}
            </Box>
          )}
          <Text dimColor>{"-".repeat(lineWidth)}</Text>
        </Box>

        {/* Right: Buddy with speech bubble */}
        <Box flexDirection="column" marginLeft={1}>
          {renderBuddyWithBubble(buddyQuip, buddyArt, buddyName).map((line, i) => (
            <Text key={i} color="cyan" dimColor>{line}</Text>
          ))}
        </Box>
      </Box>

      {/* Status line — separate, below input+buddy */}
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
  );
}
