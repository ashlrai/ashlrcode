/**
 * SlashInput — TextInput with slash command coloring.
 * Fork of ink-text-input that renders / commands in accent blue.
 */

import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";

const SLASH_COLOR = "#38BDF8"; // sky-400

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
  const colorChar = (ch: string) => isSlash ? chalk.hex(SLASH_COLOR)(ch) : ch;

  let rendered = "";
  if (value.length === 0) {
    if (focus) {
      rendered = chalk.inverse(" ") + chalk.grey(placeholder.slice(1));
    } else {
      rendered = chalk.grey(placeholder);
    }
  } else {
    for (let i = 0; i < value.length; i++) {
      const ch = colorChar(value[i]!);
      rendered += (i === cursorOffset) ? chalk.inverse(ch) : ch;
    }
    if (cursorOffset === value.length && focus) {
      rendered += chalk.inverse(" ");
    }
  }

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || (key.ctrl && input === "c") || key.tab || (key.shift && key.tab)) return;
    if (key.return) { onSubmit(value); return; }

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
  }, { isActive: focus });

  return <Text>{rendered}</Text>;
}
