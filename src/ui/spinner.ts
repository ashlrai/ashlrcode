/**
 * Terminal spinner with fun, rotating loading phrases.
 */

import { theme } from "./theme.ts";

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
  Bash: ["Running commands", "Executing", "Shell magic"],
  Read: ["Reading", "Scanning", "Absorbing"],
  Write: ["Writing", "Creating", "Crafting"],
  Edit: ["Editing", "Refactoring", "Tweaking"],
  Glob: ["Searching files", "Globbing", "Finding"],
  Grep: ["Searching code", "Grepping", "Hunting"],
  Agent: ["Spawning agent", "Delegating", "Cloning myself"],
  WebFetch: ["Fetching", "Downloading", "Surfing"],
  WebSearch: ["Searching the web", "Googling", "Researching"],
};

export class Spinner {
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private text: string;
  private startTime: number = 0;
  private phraseIndex: number = 0;
  private isThinking: boolean = true;

  constructor(text = "Thinking") {
    this.text = text;
    this.phraseIndex = Math.floor(Math.random() * THINKING_PHRASES.length);
  }

  start(text?: string): void {
    this.isThinking = !text; // If no text given, use thinking phrases
    if (text) {
      this.text = text;
    } else {
      this.text = THINKING_PHRASES[this.phraseIndex % THINKING_PHRASES.length]!;
    }
    this.startTime = Date.now();
    this.frameIndex = 0;

    let lastPhraseChange = Date.now();

    this.interval = setInterval(() => {
      const frame = FRAMES[this.frameIndex % FRAMES.length]!;
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

      // Rotate thinking phrases every 3 seconds
      if (this.isThinking && Date.now() - lastPhraseChange > 3000) {
        this.phraseIndex++;
        this.text = THINKING_PHRASES[this.phraseIndex % THINKING_PHRASES.length]!;
        lastPhraseChange = Date.now();
      }

      // Gradient the spinner frame
      const coloredFrame = theme.accent(frame);
      const coloredText = theme.secondary(this.text);
      const coloredTime = theme.muted(`${elapsed}s`);

      process.stderr.write(`\r${coloredFrame} ${coloredText} ${coloredTime}`);
      this.frameIndex++;
    }, 80);
  }

  update(text: string): void {
    this.text = text;
    this.isThinking = false;
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stderr.write("\r\x1b[K");
    }
  }
}

/**
 * Get a fun phrase for a specific tool.
 */
export function getToolPhrase(toolName: string): string {
  const phrases = TOOL_PHRASES[toolName];
  if (!phrases) return toolName;
  return phrases[Math.floor(Math.random() * phrases.length)]!;
}
