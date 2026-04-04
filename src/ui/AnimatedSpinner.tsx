/**
 * AnimatedSpinner — Ink component with cycling frames and rotating phrases.
 *
 * Self-animating via React hooks. Shows:
 * - Spinning braille frames (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
 * - Rotating fun phrases every 3 seconds when "thinking"
 * - Tool-specific context when executing tools
 * - Elapsed time
 * - Token stats when available
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const THINKING_PHRASES = [
  "Thinking",
  "Pondering the void",
  "Consulting the silicon oracle",
  "Crunching tokens",
  "Reading your code intensely",
  "Judging your variable names",
  "Overthinking this",
  "Building a mental model",
  "Navigating the AST",
  "Vibing with the codebase",
  "Hallucinating responsibly",
  "Assembling electrons",
  "Parsing the matrix",
  "Channeling the stack overflow",
  "Contemplating semicolons",
  "Refactoring my thoughts",
  "Compiling a response",
  "git blame-ing myself",
  "Searching for meaning",
  "Loading personality module",
  "Warming up the GPU hamsters",
  "Asking a smarter AI",
  "Pretending to be sentient",
  "Simulating expertise",
  "Deploying to prod (jk)",
];

const TOOL_PHRASES: Record<string, string[]> = {
  Bash: ["Running commands", "Executing shell", "Terminal magic"],
  Read: ["Reading file", "Scanning contents", "Absorbing knowledge"],
  Write: ["Writing file", "Creating artifact", "Crafting output"],
  Edit: ["Editing code", "Refactoring", "Tweaking lines"],
  Glob: ["Searching files", "Globbing patterns", "Finding matches"],
  Grep: ["Searching code", "Grepping patterns", "Hunting matches"],
  Agent: ["Spawning agent", "Delegating work", "Cloning myself"],
  WebFetch: ["Fetching URL", "Downloading", "Surfing the web"],
  WebSearch: ["Searching the web", "Researching", "Looking it up"],
  LSP: ["Querying language server", "Getting diagnostics", "Analyzing types"],
};

interface Props {
  text: string;
  tokenStats: string;
}

export function AnimatedSpinner({ text, tokenStats }: Props) {
  const [frame, setFrame] = useState(0);
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * THINKING_PHRASES.length));
  const startTimeRef = useRef(Date.now());
  const lastPhraseChangeRef = useRef(Date.now());
  const isThinking = text === "Thinking" || text === "";

  // Reset start time when text changes significantly (new tool, back to thinking)
  useEffect(() => {
    startTimeRef.current = Date.now();
    lastPhraseChangeRef.current = Date.now();
  }, [isThinking]);

  // Animate frames at 80ms
  useEffect(() => {
    const id = setInterval(() => {
      setFrame(f => f + 1);
      // Rotate thinking phrases every 3 seconds
      if (isThinking && Date.now() - lastPhraseChangeRef.current > 3000) {
        setPhraseIdx(i => i + 1);
        lastPhraseChangeRef.current = Date.now();
      }
    }, 80);
    return () => clearInterval(id);
  }, [isThinking]);

  const spinner = FRAMES[frame % FRAMES.length]!;
  const elapsed = ((Date.now() - startTimeRef.current) / 1000).toFixed(1);

  // Pick display text
  let displayText: string;
  if (isThinking) {
    displayText = THINKING_PHRASES[phraseIdx % THINKING_PHRASES.length]!;
  } else {
    // Check for tool-specific phrase
    const toolPhrases = TOOL_PHRASES[text];
    if (toolPhrases) {
      displayText = toolPhrases[phraseIdx % toolPhrases.length]!;
    } else if (text.length > 60) {
      // Long partial response text — truncate
      displayText = text.slice(0, 57) + "...";
    } else {
      displayText = text;
    }
  }

  return (
    <Box>
      <Text color="cyan" bold>  {spinner}</Text>
      <Text color="#94A3B8"> {displayText}</Text>
      <Text dimColor> {elapsed}s</Text>
      {tokenStats ? <Text dimColor>{"  ·  "}{tokenStats}</Text> : null}
    </Box>
  );
}
