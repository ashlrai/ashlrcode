/**
 * SlashInput — TextInput with slash command coloring and multi-line support.
 * Fork of ink-text-input that renders / commands in accent blue.
 *
 * Multi-line: Ctrl+J inserts a newline. Enter submits.
 * Line count indicator shown when multi-line.
 */

import chalk from "chalk";
import { Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

const SLASH_COLOR = "#38BDF8"; // sky-400
const NEWLINE_INDICATOR = chalk.grey("↵");

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

export function SlashInput({ value, onChange, onSubmit, placeholder = "", focus = true }: Props) {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    if (cursorOffset > value.length) {
      setCursorOffset(value.length);
    }
  }, [value]);

  const isSlash = value.startsWith("/");
  // Only color the slash command name (first word), not arguments after the space
  const slashCommandEnd = isSlash ? (value.indexOf(" ") === -1 ? value.length : value.indexOf(" ")) : 0;
  const colorChar = (ch: string, idx: number) => (isSlash && idx < slashCommandEnd ? chalk.hex(SLASH_COLOR)(ch) : ch);

  const CONTINUATION_PREFIX = chalk.dim("│ ");
  const hintText = focus && value.length === 0 ? chalk.dim("  Ctrl+J newline · Enter send") : "";

  let rendered = "";
  if (value.length === 0) {
    if (focus) {
      rendered = chalk.inverse(" ") + chalk.grey(placeholder.slice(1));
    } else {
      rendered = chalk.grey(placeholder);
    }
  } else {
    // Render each character, showing newlines with continuation prefix
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!;
      if (ch === "\n") {
        rendered +=
          i === cursorOffset
            ? chalk.inverse(NEWLINE_INDICATOR) + "\n" + CONTINUATION_PREFIX
            : NEWLINE_INDICATOR + "\n" + CONTINUATION_PREFIX;
      } else {
        const colored = colorChar(ch, i);
        rendered += i === cursorOffset ? chalk.inverse(colored) : colored;
      }
    }
    if (cursorOffset === value.length && focus) {
      rendered += chalk.inverse(" ");
    }
  }

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || (key.ctrl && input === "c") || key.tab || (key.shift && key.tab) || key.escape) return;

      // Ctrl+J inserts a newline (standard terminal newline keybind)
      if (key.ctrl && input === "j") {
        const next = value.slice(0, cursorOffset) + "\n" + value.slice(cursorOffset);
        setCursorOffset(cursorOffset + 1);
        onChange(next);
        return;
      }

      if (key.return) {
        onSubmit(value);
        return;
      }

      let next = value;
      let nextOffset = cursorOffset;

      if (key.leftArrow) {
        nextOffset = Math.max(0, cursorOffset - 1);
      } else if (key.rightArrow) {
        nextOffset = Math.min(value.length, cursorOffset + 1);
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          next = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          nextOffset = cursorOffset - 1;
        }
      } else if (input) {
        next = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        nextOffset = cursorOffset + input.length;
      }

      setCursorOffset(nextOffset);
      if (next !== value) onChange(next);
    },
    { isActive: focus },
  );

  return (
    <Text>
      {rendered}
      {hintText}
    </Text>
  );
}
