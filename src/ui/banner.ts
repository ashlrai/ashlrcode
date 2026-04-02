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
  bright: chalk.hex("#00E5FF"),
  mid: chalk.hex("#00ACC1"),
  deep: chalk.hex("#0077B6"),
  dim: chalk.hex("#004E7C"),
  separator: chalk.hex("#1E3A5F"),
  version: chalk.hex("#78909C"),
  provider: chalk.hex("#00E5FF"),
  model: chalk.hex("#546E7A"),
  muted: chalk.hex("#37474F"),
  green: chalk.hex("#00E676"),
  yellow: chalk.hex("#FFD600"),
  red: chalk.hex("#FF1744"),
  magenta: chalk.hex("#E040FB"),
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
  if (mode === "yolo") modeStr = chalk.bgHex("#D32F2F").white.bold(" YOLO ");
  else if (mode === "accept-edits") modeStr = chalk.bgHex("#F9A825").black(" EDITS ");
  else if (mode === "plan") modeStr = chalk.bgHex("#7B1FA2").white(" PLAN ");

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
  const w = Math.min(process.stdout.columns || 80, 70);
  console.log(c.muted("─".repeat(w)));
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
    "ship it, no tests needed",
    "we're basically 10x engineers now",
    "I'd approve this PR",
    "this code sparks joy",
    "lgtm, didn't read",
    "it works on my machine™",
    "fewer bugs than yesterday probably",
    "the code reviews itself",
    "trust the process",
    "production ready (citation needed)",
    "chef's kiss",
    "this is fine 🔥",
    "the AI will fix it later",
    "moved fast, broke nothing (hopefully)",
    "refactoring is for quitters",
  ],
  thinking: [
    "hold my tokens...",
    "crunching very important numbers",
    "consulting the void",
    "downloading more RAM",
    "asking a smarter AI",
    "pretending to understand your code",
    "this might take a while",
    "compiling thoughts...",
    "negotiating with the API gods",
    "thinking harder than a CS exam",
  ],
  sleepy: [
    "just got here, need coffee",
    "*yawns in binary*",
    "still waking up...",
    "loading personality module",
    "rebooting enthusiasm",
    "can we do this later?",
    "my tokens are still cold",
    "give me a sec...",
  ],
};

let lastQuipIndex = Math.floor(Math.random() * 100);

function getBuddyQuip(mood: string): string {
  const quips = BUDDY_QUIPS[mood] ?? BUDDY_QUIPS.sleepy!;
  lastQuipIndex = (lastQuipIndex + 1) % quips.length;
  return quips[lastQuipIndex]!;
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
