/**
 * ASCII art banner for AshlrCode startup.
 * Uses gradient-style coloring for a premium feel.
 */

import chalk from "chalk";

const LOGO_LINES = [
  "   ╔═╗┌─┐┬ ┬┬  ┬─┐  ╔═╗┌─┐┌┬┐┌─┐",
  "   ╠═╣└─┐├─┤│  ├┬┘  ║  │ │ ││├┤ ",
  "   ╩ ╩└─┘┴ ┴┴─┘┴└─  ╚═╝└─┘─┴┘└─┘",
];

// Gradient from bright cyan to blue
const GRADIENT = [
  chalk.hex("#00E5FF"),  // bright cyan
  chalk.hex("#00B8D4"),  // mid cyan
  chalk.hex("#0091EA"),  // blue
];

export function printBanner(
  version: string,
  provider: string,
  model: string,
  mode?: string
): void {
  console.log("");

  // Print logo with gradient
  LOGO_LINES.forEach((line, i) => {
    const colorFn = GRADIENT[i % GRADIENT.length]!;
    console.log(colorFn(line));
  });

  // Separator
  console.log(chalk.hex("#1a1a2e")("   " + "─".repeat(34)));

  // Info line with styled segments
  const versionStr = chalk.hex("#888")(`v${version}`);
  const providerStr = chalk.hex("#00E5FF")(provider) + chalk.hex("#555")(`:${model}`);

  let modeStr = "";
  if (mode === "yolo") {
    modeStr = chalk.bgRed.white.bold(" YOLO ");
  } else if (mode === "accept-edits") {
    modeStr = chalk.bgYellow.black(" EDITS ");
  } else if (mode === "plan") {
    modeStr = chalk.bgMagenta.white(" PLAN ");
  }

  const infoParts = [`   ${versionStr}`, providerStr];
  console.log(infoParts.join(chalk.hex("#333")(" · ")) + (modeStr ? `  ${modeStr}` : ""));
  console.log("");
}
