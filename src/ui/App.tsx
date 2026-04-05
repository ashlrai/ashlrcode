/**
 * Main Ink REPL — clean layout.
 *
 * Output scrolls above. Buddy + bubble right-aligned above input.
 * Full-width input box. Status line below.
 */

import { readdirSync } from "fs";
import { Box, Static, Text, useApp, useInput } from "ink";
import { basename, dirname, join, resolve } from "path";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { BuddyData } from "../ui/buddy.ts";
import { AnimatedSpinner } from "./AnimatedSpinner.tsx";
import { BuddyPanel } from "./BuddyPanel.tsx";
import { getAction, type InputHistory } from "./keybindings.ts";
import { SlashInput } from "./SlashInput.tsx";

/**
 * Extract a file path suggestion for the last word in the input.
 * Returns the full completed input string if a match is found, or undefined.
 */
function getFilePathSuggestion(input: string, cwd: string): string | undefined {
  if (!input || input.startsWith("/")) return undefined;

  // Extract the last word (space-delimited)
  const lastSpaceIdx = input.lastIndexOf(" ");
  const lastWord = lastSpaceIdx === -1 ? input : input.slice(lastSpaceIdx + 1);

  if (!lastWord) return undefined;

  // Check if it looks like a file path — must contain / or start with . or ~
  // (Don't match bare dotted words like "v2.0", "e.g.", "node.js")
  const looksLikePath =
    lastWord.includes("/") ||
    lastWord.startsWith("./") ||
    lastWord.startsWith("../") ||
    lastWord.startsWith("~");
  if (!looksLikePath) return undefined;

  try {
    // Resolve the directory to list and the partial filename to match
    let expanded = lastWord;
    if (expanded.startsWith("~")) {
      expanded = join(process.env.HOME || "/", expanded.slice(1));
    }

    const resolved = resolve(cwd, expanded);

    // If the word ends with /, list that directory
    let dirToList: string;
    let partial: string;
    if (lastWord.endsWith("/")) {
      dirToList = resolved;
      partial = "";
    } else {
      dirToList = dirname(resolved);
      partial = basename(resolved);
    }

    const entries = readdirSync(dirToList, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.name.startsWith(partial) && e.name !== partial)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (matches.length === 0) return undefined;

    const match = matches[0]!;
    const completion = match.name + (match.isDirectory() ? "/" : "");
    const prefix = input.slice(0, input.length - partial.length);
    return prefix + completion;
  } catch {
    return undefined;
  }
}

interface OutputItem {
  id: number;
  text: string;
}

interface AppProps {
  onSubmit: (text: string) => void;
  onExit: () => void;
  /** Called when Ctrl+C is pressed while the agent is processing. */
  onInterrupt?: () => void;
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
  modelName: string;
  buddy: BuddyData;
  buddyQuip: string;
  buddyQuipType: "quip" | "suggestion" | "reaction";
  items: OutputItem[];
  isProcessing: boolean;
  spinnerText: string;
  tokenStats: string;
  commands: string[];
  cwd: string;
}

export function App({
  onSubmit,
  onExit,
  onInterrupt,
  onModeSwitch,
  onUndo,
  onEffortCycle,
  onCompact,
  onClearScreen,
  onVoiceToggle,
  inputHistory,
  mode,
  modeColor,
  contextPercent,
  contextUsed,
  contextLimit,
  modelName,
  buddy,
  buddyQuip,
  buddyQuipType,
  items,
  isProcessing,
  spinnerText,
  tokenStats,
  commands,
  cwd,
}: AppProps) {
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0); // Change key to force remount (resets cursor)
  const [lastCtrlC, setLastCtrlC] = useState(0); // Track double Ctrl+C for force exit
  const [termWidth, setTermWidth] = useState(process.stdout.columns || 80);
  const { exit } = useApp();

  useEffect(() => {
    const handler = () => setTermWidth(process.stdout.columns || 80);
    process.stdout.on("resize", handler);
    return () => {
      process.stdout.off("resize", handler);
    };
  }, []);

  const slashSuggestion =
    input.startsWith("/") && input.length > 1 ? commands.find((c) => c.startsWith(input) && c !== input) : undefined;

  const fileSuggestion = useMemo(
    () => (!slashSuggestion && cwd ? getFilePathSuggestion(input, cwd) : undefined),
    [input, cwd, slashSuggestion],
  );

  const suggestion = slashSuggestion ?? fileSuggestion;

  const handleSubmit = useCallback(
    (value: string) => {
      const text = value.trim();
      setInput("");
      setInputKey((k) => k + 1); // Remount to reset cursor
      if (text) onSubmit(text);
    },
    [onSubmit],
  );

  // Accept autocomplete: set value AND force remount to reset cursor to end
  const acceptSuggestion = useCallback(() => {
    if (!suggestion) return;
    // For directory completions (ending with /), don't add trailing space
    // so the user can keep tabbing into subdirectories
    const suffix = suggestion.endsWith("/") ? "" : " ";
    setInput(suggestion + suffix);
    setInputKey((k) => k + 1); // Force TextInput remount — cursor goes to end
  }, [suggestion]);

  useInput(
    useCallback(
      (ch: string, key: any) => {
        // Map Ink key booleans to a normalized key name
        let keyName = ch;
        if (key.tab) keyName = "tab";
        else if (key.upArrow) keyName = "up";
        else if (key.downArrow) keyName = "down";
        else if (key.leftArrow) keyName = "left";
        else if (key.rightArrow) keyName = "right";
        else if (key.escape) keyName = "escape";
        else if (key.return) keyName = "return";
        else if (key.backspace) keyName = "backspace";
        else if (key.delete) keyName = "delete";

        const action = getAction(keyName, !!key.ctrl, !!key.shift, !!key.meta);

        switch (action) {
          case "exit": {
            const now = Date.now();
            if (isProcessing && onInterrupt) {
              // Double Ctrl+C within 1.5s during processing → force exit
              if (now - lastCtrlC < 1500) {
                onExit();
                exit();
              } else {
                onInterrupt(); // First Ctrl+C → interrupt agent
                setLastCtrlC(now);
              }
            } else {
              onExit();
              exit(); // Ctrl+C while idle → exit
            }
            return;
          }
          case "mode-switch":
            onModeSwitch();
            return;
          case "autocomplete":
            if (suggestion && (key.tab || (key.rightArrow && input.length > 0))) {
              acceptSuggestion();
            }
            return;
          case "history-prev":
            if (inputHistory) {
              const prev = inputHistory.prev(input);
              if (prev !== null) {
                setInput(prev);
                setInputKey((k) => k + 1);
              }
            }
            return;
          case "history-next":
            if (inputHistory) {
              const next = inputHistory.next();
              if (next !== null) {
                setInput(next);
                setInputKey((k) => k + 1);
              }
            }
            return;
          case "clear-input":
            setInput("");
            setInputKey((k) => k + 1);
            return;
          case "undo":
            onUndo?.();
            return;
          case "effort-cycle":
            onEffortCycle?.();
            return;
          case "compact":
            onCompact?.();
            return;
          case "clear-screen":
            onClearScreen?.();
            return;
          case "voice-toggle":
            onVoiceToggle?.();
            return;
        }
      },
      [
        suggestion,
        input,
        isProcessing,
        onModeSwitch,
        onExit,
        onInterrupt,
        exit,
        acceptSuggestion,
        inputHistory,
        onUndo,
        onEffortCycle,
        onCompact,
        onClearScreen,
        onVoiceToggle,
      ],
    ),
  );

  const barWidth = 10;
  const filled = Math.round((contextPercent / 100) * barWidth);
  const empty = barWidth - filled;
  const ctxColor = contextPercent < 50 ? "green" : contextPercent < 75 ? "yellow" : "red";

  return (
    <Box flexDirection="column">
      {/* Scrollable output */}
      <Static items={items}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>

      {/* Animated spinner with rotating phrases + token stats */}
      {isProcessing && <AnimatedSpinner text={spinnerText} tokenStats={tokenStats} />}

      {/* Input box — full width */}
      <Text dimColor>{"-".repeat(termWidth)}</Text>
      <Box>
        <Text color={modeColor} bold>
          ❯{" "}
        </Text>
        {isProcessing ? (
          <Text dimColor>waiting for response...</Text>
        ) : (
          <Box>
            <SlashInput
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
          <Text dimColor>
            {commands
              .filter((c) => c.startsWith(input))
              .slice(0, 5)
              .join("  ")}
          </Text>
          {suggestion && (
            <Text dimColor italic>
              {" "}
              tab ↹
            </Text>
          )}
        </Box>
      )}
      <Text dimColor>{"-".repeat(termWidth)}</Text>

      {/* Bottom: status left, buddy right */}
      <Box>
        <Box flexGrow={1}>
          <Text color={modeColor} bold>
            ❯❯{" "}
          </Text>
          <Text color={modeColor}>{mode}</Text>
          <Text dimColor> (shift+tab)</Text>
          <Text dimColor>{"  ·  "}</Text>
          <Text dimColor>{modelName}</Text>
          <Text dimColor>{"  ·  "}</Text>
          <Text color={ctxColor}>{"█".repeat(filled)}</Text>
          <Text dimColor>{"░".repeat(empty)}</Text>
          <Text> </Text>
          <Text color={ctxColor}>{contextPercent}%</Text>
          <Text dimColor>
            {" "}
            · {contextUsed}/{contextLimit}
          </Text>
        </Box>

        {/* Buddy panel — fixed height, right-aligned */}
        <Box width={42} flexShrink={0}>
          <BuddyPanel buddy={buddy} quip={buddyQuip} quipType={buddyQuipType} />
        </Box>
      </Box>
    </Box>
  );
}
