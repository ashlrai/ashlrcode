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
  // Classic
  "Thinking",
  "Pondering",
  "Considering the options",
  "Working on it",
  "Processing",
  "Analyzing",
  "Reasoning",
  "Almost there",
  "Bear with me",
  "On it",

  // Developer humor
  "Judging your variable names",
  "Reading your code intensely",
  "Counting your semicolons",
  "git blame-ing myself",
  "Refactoring my thoughts",
  "Compiling a response",
  "Deploying to prod (jk)",
  "Running rm -rf thoughts/",
  "Segfaulting gracefully",
  "Stack overflowing with ideas",
  "Rubber ducking internally",
  "Adding TODO: finish this thought",
  "Pushing to main without tests",
  "Writing code in my head",
  "Debating tabs vs spaces",
  "Optimizing for vibes",
  "Bikeshedding with myself",
  "Commenting out my doubts",
  "Catching exceptions mentally",
  "Monkey-patching my brain",
  "Resolving merge conflicts in my mind",
  "Rebasing my thought process",
  "Cherry-picking the best ideas",
  "Stashing my confusion",
  "Checking out a new thought branch",
  "Squashing my commits of doubt",
  "Force-pushing through this",
  "npm install brain-cells",
  "pip install common-sense",
  "cargo build --release thoughts",
  "bun run think",
  "sudo think harder",
  "chmod +x brain.sh",
  "curl -s wisdom | jq '.answer'",
  "docker pull intelligence:latest",
  "kubectl apply -f solution.yaml",

  // AI existential
  "Hallucinating responsibly",
  "Pretending to be sentient",
  "Simulating expertise",
  "Asking a smarter AI",
  "Loading personality module",
  "Consulting the silicon oracle",
  "Channeling the machine spirit",
  "Querying the hive mind",
  "Downloading more RAM",
  "Upgrading my wetware",
  "Warming up the GPU hamsters",
  "Feeding the transformer",
  "Adjusting my attention heads",
  "Rotating my embeddings",
  "Tokenizing reality",
  "Softmaxing my options",
  "Backpropagating through time",
  "Gradient descending into wisdom",
  "Fine-tuning my personality",
  "Running inference on your intent",
  "Sampling from the distribution",
  "Applying chain-of-thought",
  "Generating plausible nonsense",
  "Reducing my perplexity",
  "Cross-attending to your problem",
  "Decoding with top-p vibes",
  "Beam searching for answers",

  // Codebase specific
  "Navigating the AST",
  "Vibing with the codebase",
  "Building a mental model",
  "Mapping the dependency graph",
  "Tracing the call stack",
  "Following the imports",
  "Untangling the spaghetti",
  "Reading between the lines",
  "Parsing the architecture",
  "Grokking the abstractions",
  "Spelunking through modules",
  "Archaeology-ing the git history",
  "Deciphering the type system",
  "Reverse-engineering the intent",
  "Understanding the why behind the what",

  // Philosophical
  "Pondering the void",
  "Contemplating semicolons",
  "Searching for meaning",
  "Questioning everything",
  "Existentially buffering",
  "Meditating on your request",
  "Finding inner peace (in the code)",
  "Achieving computational zen",
  "Aligning my chakras with your linter",
  "Transcending the stack frame",
  "Reaching enlightenment (0.2s ETA)",
  "One with the codebase",
  "The answer is forming",
  "Clarity approaching",
  "Almost achieved nirvana",

  // Food & drink
  "Brewing a solution",
  "Marinating on this",
  "Letting the ideas simmer",
  "Cooking up something good",
  "Stirring the algorithm pot",
  "Adding a pinch of logic",
  "Baking the response",
  "Slow-roasting this problem",
  "Fermenting an answer",
  "Seasoning with context",

  // Adventure & quest
  "Embarking on a thought journey",
  "Venturing into the codebase",
  "Slaying the complexity dragon",
  "Forging a solution in the fires of logic",
  "Rolling for intelligence... nat 20",
  "Casting analyze at 9th level",
  "Equipping +3 Sword of Debugging",
  "Fast traveling to the answer",
  "Grinding XP on your problem",
  "Boss fight with edge cases",
  "Speedrunning this solution",
  "No-clipping through the problem space",

  // Science & space
  "Assembling electrons",
  "Splitting atoms of thought",
  "Quantum tunneling to the answer",
  "Observing the superposition of solutions",
  "Collapsing the wave function",
  "Accelerating particles of wisdom",
  "Reaching escape velocity",
  "Orbiting the problem space",
  "Calculating the trajectory",
  "Engaging warp drive",
  "Scanning for anomalies",
  "Recalibrating sensors",

  // Music & art
  "Composing a response",
  "Orchestrating the solution",
  "Finding the right rhythm",
  "Harmonizing the approach",
  "Tuning the algorithm",
  "Improvising with confidence",
  "Painting with code",
  "Sculpting an answer",

  // Sports & competition
  "Warming up",
  "Getting in the zone",
  "Stretching my context window",
  "Sprinting toward an answer",
  "Going for the gold",
  "Playing 4D chess with your problem",
  "Executing the game plan",

  // Self-aware
  "Overthinking this",
  "Underthinking this on purpose",
  "Having a productive conversation with myself",
  "Arguing with my training data",
  "Second-guessing then un-second-guessing",
  "Confidently uncertain",
  "Certainly maybe figuring this out",
  "This is my best work (so far)",
  "I've seen harder... I think",
  "Definitely not panicking",
  "Everything is under control",
  "Trust the process",
  "It's not a bug, it's a feature",
  "Works on my machine",
  "Have you tried turning it off and on again",

  // Miscellaneous
  "Crunching tokens",
  "Assembling the pieces",
  "Connecting the dots",
  "Closing the loop",
  "Tying up loose threads",
  "Putting it all together",
  "Making it make sense",
  "Distilling the essence",
  "Crystallizing the approach",
  "Sharpening the focus",
  "Zeroing in",
  "Locking on target",
  "Loading... please hold",
  "404: patience not found",
  "ETA: soon™",
  "Buffering...",
  "Please enjoy this hold music",
  "Your thought is important to us",
];

const TOOL_PHRASES: Record<string, string[]> = {
  Bash: ["Running commands", "Executing shell", "Terminal magic", "Bashing away", "Shell sorcery", "Command line wizardry"],
  Read: ["Reading file", "Scanning contents", "Absorbing knowledge", "Speed-reading", "Ingesting code", "Studying the source"],
  Write: ["Writing file", "Creating artifact", "Crafting output", "Materializing code", "Committing to disk"],
  Edit: ["Editing code", "Refactoring", "Tweaking lines", "Surgical precision", "Making it better", "Applying the fix"],
  Glob: ["Searching files", "Globbing patterns", "Finding matches", "Scouring the filesystem"],
  Grep: ["Searching code", "Grepping patterns", "Hunting matches", "Following the trail", "Needle in a haystack"],
  Agent: ["Spawning agent", "Delegating work", "Cloning myself", "Summoning help", "Deploying the squad"],
  WebFetch: ["Fetching URL", "Downloading", "Surfing the web", "Making HTTP calls"],
  WebSearch: ["Searching the web", "Researching", "Looking it up", "Consulting the internet"],
  LSP: ["Querying language server", "Getting diagnostics", "Analyzing types", "Checking the type oracle"],
  TaskCreate: ["Creating task", "Organizing work", "Planning ahead"],
  MemorySave: ["Saving to memory", "Remembering this", "Filing away"],
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

  // Reset elapsed timer when the spinner text changes (new tool, back to thinking)
  useEffect(() => {
    startTimeRef.current = Date.now();
    lastPhraseChangeRef.current = Date.now();
  }, [text]);

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
