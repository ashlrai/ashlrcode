/**
 * Main Ink REPL — clean layout.
 *
 * Output scrolls above. Buddy + bubble right-aligned above input.
 * Full-width input box. Status line below.
 */

import chalk from "chalk";
import { readdirSync } from "fs";
import { Box, Static, Text, useApp, useInput } from "ink";
import { basename, dirname, join, resolve } from "path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    lastWord.includes("/") || lastWord.startsWith("./") || lastWord.startsWith("../") || lastWord.startsWith("~");
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
  /** Number of options in the currently pending AskUser question (0 = no pending question). */
  pendingQuestionOptionCount?: number;
  /** Labels for the pending question options (for arrow-key selection UI). */
  pendingQuestionLabels?: string[];
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
  pendingQuestionOptionCount = 0,
  pendingQuestionLabels = [],
}: AppProps) {
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0); // Change key to force remount (resets cursor)
  const [lastCtrlC, setLastCtrlC] = useState(0); // Track double Ctrl+C for force exit
  const [selectedOption, setSelectedOption] = useState(0);
  const selectedRef = useRef(0); // Ref avoids stale closure in useInput
  const [otherMode, setOtherMode] = useState(false); // True when "Other" is selected and user types
  const [termWidth, setTermWidth] = useState(process.stdout.columns || 80);
  const { exit } = useApp();

  useEffect(() => {
    const handler = () => setTermWidth(process.stdout.columns || 80);
    process.stdout.on("resize", handler);
    return () => {
      process.stdout.off("resize", handler);
    };
  }, []);

  // Autocomplete slash commands — works at start of input OR after a space (mid-message)
  const lastWord = input.split(" ").pop() ?? "";
  const slashSuggestion =
    lastWord.startsWith("/") && lastWord.length > 1
      ? commands.find((c) => c.startsWith(lastWord) && c !== lastWord)
      : undefined;

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
    const suffix = suggestion.endsWith("/") ? "" : " ";
    // Replace only the last word with the suggestion, preserving text before it
    const words = input.split(" ");
    words[words.length - 1] = suggestion + suffix;
    setInput(words.join(" "));
    setInputKey((k) => k + 1);
  }, [suggestion, input]);

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

        // When AskUser question is pending, handle arrow-key selection and number keys
        if (pendingQuestionOptionCount > 0) {
          // "Other" mode — show text input, Enter submits typed text
          if (otherMode) {
            if (key.escape) {
              setOtherMode(false);
              return;
            }
            // Let normal text input handle everything in other mode
            return;
          }

          const totalOpts = pendingQuestionOptionCount + 1; // +1 for "Other"
          if (key.upArrow) {
            setSelectedOption((s) => {
              const next = (s - 1 + totalOpts) % totalOpts;
              selectedRef.current = next;
              return next;
            });
            return;
          }
          if (key.downArrow) {
            setSelectedOption((s) => {
              const next = (s + 1) % totalOpts;
              selectedRef.current = next;
              return next;
            });
            return;
          }
          if (key.return) {
            const sel = selectedRef.current;
            // Last option = "Other" → switch to text input mode
            if (sel === pendingQuestionOptionCount) {
              setOtherMode(true);
              return;
            }
            onSubmit(String(sel + 1));
            setSelectedOption(0);
            selectedRef.current = 0;
            return;
          }
          // Number keys for instant selection
          if (!key.ctrl && !key.shift && !key.meta) {
            const num = parseInt(ch, 10);
            if (num >= 1 && num <= pendingQuestionOptionCount) {
              onSubmit(String(num));
              setSelectedOption(0);
              selectedRef.current = 0;
              return;
            }
          }
          return; // Swallow all other keys when question is pending
        }

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
        pendingQuestionOptionCount,
        otherMode,
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
      <Text dimColor>{"─".repeat(termWidth)}</Text>
      {pendingQuestionOptionCount > 0 ? (
        /* Question selection UI — replaces input when a question is pending */
        otherMode ? (
          /* "Other" text input mode */
          <Box>
            <Text color="cyan" bold>✎ </Text>
            <SlashInput
              key={inputKey + 9000}
              value={input}
              onChange={setInput}
              onSubmit={(val: string) => {
                const text = val.trim();
                if (text) {
                  onSubmit(text);
                  setInput("");
                  setInputKey((k) => k + 1);
                  setOtherMode(false);
                  setSelectedOption(0);
                  selectedRef.current = 0;
                }
              }}
              placeholder="Type your answer... (Esc to go back)"
            />
          </Box>
        ) : (
          /* Arrow-key selection mode */
          <Box flexDirection="column">
            <Text dimColor>  ↑↓ select · Enter confirm · 1-{pendingQuestionOptionCount} instant</Text>
            {pendingQuestionLabels.map((label, i) => (
              <Text key={i}>
                {i === selectedOption
                  ? `  ${chalk.cyan.bold("❯")} ${chalk.cyan.bold(`${i + 1}`)} ${chalk.cyan.bold(label)}`
                  : `    ${chalk.dim(`${i + 1}`)} ${label}`}
              </Text>
            ))}
            <Text>
              {pendingQuestionOptionCount === selectedOption
                ? `  ${chalk.cyan.bold("❯")} ${chalk.cyan.bold(`${pendingQuestionOptionCount + 1}`)} ${chalk.cyan.bold("Other (type your own)")}`
                : `    ${chalk.dim(`${pendingQuestionOptionCount + 1}`)} ${chalk.dim("Other (type your own)")}`}
            </Text>
          </Box>
        )
      ) : (
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
              {suggestion && <Text dimColor>{suggestion.slice(lastWord.length)}</Text>}
            </Box>
          )}
        </Box>
      )}
      {/* Autocomplete hints — only shown when typing a slash command and no question pending */}
      {!pendingQuestionOptionCount && lastWord.startsWith("/") && lastWord.length > 1 && !isProcessing && (
        <Box marginLeft={2}>
          <Text dimColor>
            {commands
              .filter((c) => c.startsWith(lastWord))
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
      <Text dimColor>{"─".repeat(termWidth)}</Text>

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
