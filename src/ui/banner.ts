/**
 * ASCII art banner for AshlrCode startup.
 */

import chalk from "chalk";

const LOGO = [
  "   ╔═╗┌─┐┬ ┬┬  ┬─┐╔═╗┌─┐┌┬┐┌─┐",
  "   ╠═╣└─┐├─┤│  ├┬┘║  │ │ ││├┤ ",
  "   ╩ ╩└─┘┴ ┴┴─┘┴└─╚═╝└─┘─┴┘└─┘",
];

export function printBanner(
  version: string,
  provider: string,
  model: string,
  mode?: string
): void {
  console.log("");

  // Print logo in cyan
  for (const line of LOGO) {
    console.log(chalk.cyan(line));
  }

  // Info line
  const parts: string[] = [
    chalk.dim(`v${version}`),
    chalk.dim(`${provider}:${model}`),
  ];

  if (mode === "yolo") {
    parts.push(chalk.red.bold("YOLO"));
  } else if (mode === "accept-edits") {
    parts.push(chalk.yellow("auto-edits"));
  } else if (mode === "plan") {
    parts.push(chalk.magenta("plan"));
  }

  console.log(chalk.dim("   ") + parts.join(chalk.dim(" | ")));
  console.log("");
}
