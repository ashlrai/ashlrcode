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

// Color gradient — bright cyan to deep blue
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
};

export function printBanner(
  version: string,
  provider: string,
  model: string,
  mode?: string,
  buddyArt?: string
): void {
  console.log("");

  // Print logo with gradient
  const colors = [c.bright, c.mid, c.deep, c.dim];
  LOGO.forEach((line, i) => {
    const colorFn = colors[i % colors.length]!;
    console.log(colorFn(line));
  });

  // Separator line
  printSeparator();

  // Info line
  const parts = [
    c.version(`v${version}`),
    c.provider(provider) + c.model(`:${model}`),
  ];

  let modeStr = "";
  if (mode === "yolo") modeStr = chalk.bgHex("#D32F2F").white.bold(" YOLO ");
  else if (mode === "accept-edits") modeStr = chalk.bgHex("#F9A825").black(" EDITS ");
  else if (mode === "plan") modeStr = chalk.bgHex("#7B1FA2").white(" PLAN ");

  console.log("   " + parts.join(c.muted(" · ")) + (modeStr ? `  ${modeStr}` : ""));

  // Show buddy if provided
  if (buddyArt) {
    console.log(buddyArt);
  }

  console.log("");
}

/**
 * Print a styled horizontal separator line.
 * Use between conversation turns for visual clarity.
 */
export function printSeparator(width?: number): void {
  const w = width ?? Math.min(process.stdout.columns || 80, 70);
  console.log(c.separator("   " + "─".repeat(w - 3)));
}

/**
 * Print a thin separator between user/assistant turns.
 */
export function printTurnSeparator(): void {
  const w = Math.min(process.stdout.columns || 80, 60);
  console.log(c.muted("\n  " + "·".repeat(w - 2)));
}
