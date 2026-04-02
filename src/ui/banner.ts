/**
 * ASCII art banner with Ashlr "A" mark for startup.
 * Gradient coloring, branded, premium feel.
 */

import chalk from "chalk";

// Ashlr "A" mark + AshlrCode text
const LOGO = [
  "      ╱╲",
  "     ╱  ╲      ┌─┐┌─┐┬ ┬┬  ┬─┐  ┌─┐┌─┐┌┬┐┌─┐",
  "    ╱────╲     ├─┤└─┐├─┤│  ├┬┘  │  │ │ ││├┤ ",
  "   ╱      ╲    ┴ ┴└─┘┴ ┴┴─┘┴└─  └─┘└─┘─┴┘└─┘",
];

const c = {
  bright: chalk.hex("#7DD3FC"),   // sky-300
  mid: chalk.hex("#38BDF8"),      // sky-400
  deep: chalk.hex("#0EA5E9"),     // sky-500
  dim: chalk.hex("#0284C7"),      // sky-600
  separator: chalk.hex("#334155"), // slate-700
  version: chalk.hex("#94A3B8"),  // slate-400
  provider: chalk.hex("#38BDF8"), // sky-400
  model: chalk.hex("#64748B"),    // slate-500
  muted: chalk.hex("#475569"),    // slate-600
  green: chalk.hex("#34D399"),    // emerald-400
  yellow: chalk.hex("#FBBF24"),   // amber-400
  red: chalk.hex("#FB7185"),      // rose-400
  magenta: chalk.hex("#E879F9"),  // fuchsia-400
};

export function printBanner(
  version: string,
  provider: string,
  model: string,
  mode?: string,
  buddyArt?: string
): void {
  console.log("");
  const colors = [c.bright, c.mid, c.deep, c.dim];
  LOGO.forEach((line, i) => {
    console.log(colors[i % colors.length]!(line));
  });
  printSeparator();

  const parts = [
    c.version(`v${version}`),
    c.provider(provider) + c.model(`:${model}`),
  ];
  let modeStr = "";
  if (mode === "yolo") modeStr = chalk.bgHex("#E11D48").hex("#FFF").bold(" YOLO ");
  else if (mode === "accept-edits") modeStr = chalk.bgHex("#D97706").hex("#FFF").bold(" EDITS ");
  else if (mode === "plan") modeStr = chalk.bgHex("#C026D3").hex("#FFF").bold(" PLAN ");

  console.log("   " + parts.join(c.muted(" · ")) + (modeStr ? `  ${modeStr}` : ""));
  if (buddyArt) console.log(buddyArt);
  console.log("");
}

export function printSeparator(width?: number): void {
  const w = width ?? Math.min(process.stdout.columns || 80, 70);
  console.log(c.separator("   " + "─".repeat(w - 3)));
}

/**
 * Print a clean horizontal line for the input box.
 */
export function printInputLine(): void {
  const w = process.stdout.columns || 80;
  console.log(c.separator("─".repeat(w)));
}

/**
 * Print the status line below input box.
 * Mode on left, colored context bar on right, buddy quip at end.
 *
 * Layout: ❯❯ yolo mode (shift+tab)          ████░░░░ 12% · 240K/2M
 */
export function printStatusLine(
  mode: string,
  contextPercent?: number,
  contextUsed?: string,
  contextLimit?: string,
  buddyName?: string,
  buddyMood?: string
): void {
  // Left: mode
  let modeLabel = "";
  switch (mode) {
    case "yolo":
      modeLabel = c.red("❯❯") + " " + c.red("yolo mode");
      break;
    case "plan":
      modeLabel = c.magenta("❯❯") + " " + c.magenta("plan mode");
      break;
    case "accept-edits":
      modeLabel = c.yellow("❯❯") + " " + c.yellow("auto-edits");
      break;
    default:
      modeLabel = c.muted("❯❯") + " " + c.muted("normal mode");
  }
  modeLabel += " " + c.muted("(shift+tab to cycle)");

  // Right: context bar
  let ctxDisplay = "";
  if (contextPercent !== undefined && contextPercent >= 0) {
    const barWidth = 10;
    const filled = Math.round((contextPercent / 100) * barWidth);
    const empty = barWidth - filled;
    const barColor = contextPercent < 50 ? c.green : contextPercent < 75 ? c.yellow : c.red;
    const pctColor = contextPercent < 50 ? c.green : contextPercent < 75 ? c.yellow : c.red;

    ctxDisplay =
      barColor("█".repeat(filled)) +
      c.muted("░".repeat(empty)) +
      " " +
      pctColor(`${contextPercent}%`) +
      c.muted(` · ${contextUsed ?? "0"}/${contextLimit ?? "?"}`);
  }

  // Buddy quip — funny rotating commentary
  let buddyQuip = "";
  if (buddyName) {
    const quip = getBuddyQuip(buddyMood ?? "sleepy");
    buddyQuip = c.muted(` · ${buddyName}: `) + c.dim(`"${quip}"`);
  }

  console.log(modeLabel + "          " + ctxDisplay + buddyQuip);
  console.log(""); // Extra breathing room at bottom
}

// Funny, edgy, satirical buddy quips that rotate
const BUDDY_QUIPS: Record<string, string[]> = {
  happy: [
    "ship it, yolo",
    "lgtm, didn't read a damn thing",
    "tests are for people with trust issues",
    "git push --force and pray",
    "code review? I am the code review",
    "the real bugs were the friends we made",
    "stack overflow told me to do this",
    "technically it compiles",
    "this is either genius or insanity",
    "my therapist says I should stop enabling devs",
    "clean code is for nerds",
    "it works on my machine, deploy it",
    "we move fast and break stuff here",
    "have you tried turning it off and never back on",
    "that code is mid but whatever",
  ],
  thinking: [
    "hold on, downloading more brain...",
    "pretending to understand your code",
    "asking chatgpt for help (jk... unless?)",
    "my last brain cell is working overtime",
    "I've seen worse... actually no I haven't",
    "trying not to hallucinate here",
    "one sec, arguing with myself",
    "consulting my imaginary friend",
    "calculating the meaning of your spaghetti code",
    "processing... or napping, hard to tell",
  ],
  sleepy: [
    "*yawns in binary*",
    "do we HAVE to code right now?",
    "loading enthusiasm... 404 not found",
    "five more minutes...",
    "my motivation called in sick today",
    "I'm not lazy, I'm energy efficient",
    "can we just deploy yesterday's code again?",
    "I was having a great dream about typescript",
  ],
};

const quipIndexes: Record<string, number> = {};

function getBuddyQuip(mood: string): string {
  const quips = BUDDY_QUIPS[mood] ?? BUDDY_QUIPS.sleepy!;
  quipIndexes[mood] = ((quipIndexes[mood] ?? Math.floor(Math.random() * quips.length)) + 1) % quips.length;
  return quips[quipIndexes[mood]!]!;
}

/**
 * Print a rich separator between turns with session context.
 */
export function printTurnSeparator(info?: {
  turnNumber?: number;
  cost?: string;
  buddyName?: string;
  buddyMood?: string;
}): void {
  const w = Math.min(process.stdout.columns || 80, 65);

  if (!info) {
    console.log(c.muted("\n  " + "─".repeat(w - 2)));
    return;
  }

  const parts: string[] = [];
  if (info.turnNumber) parts.push(`turn ${info.turnNumber}`);
  if (info.cost) parts.push(info.cost);
  if (info.buddyName) {
    parts.push(info.buddyName);
  }

  const label = parts.length > 0 ? ` ${parts.join(" · ")} ` : "";
  const lineLen = Math.max(0, w - label.length - 4);
  const leftLen = Math.floor(lineLen / 2);
  const rightLen = lineLen - leftLen;

  console.log(
    "\n" +
    c.muted("  " + "─".repeat(leftLen)) +
    c.separator(label) +
    c.muted("─".repeat(rightLen))
  );
}
