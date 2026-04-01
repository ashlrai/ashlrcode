/**
 * Terminal spinner — shows thinking indicator while waiting for API response.
 */

import chalk from "chalk";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private text: string;
  private startTime: number = 0;

  constructor(text = "Thinking") {
    this.text = text;
  }

  start(text?: string): void {
    if (text) this.text = text;
    this.startTime = Date.now();
    this.frameIndex = 0;

    this.interval = setInterval(() => {
      const frame = FRAMES[this.frameIndex % FRAMES.length]!;
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      process.stderr.write(
        `\r${chalk.cyan(frame)} ${chalk.dim(this.text)}${chalk.dim(` (${elapsed}s)`)}`
      );
      this.frameIndex++;
    }, 80);
  }

  update(text: string): void {
    this.text = text;
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      // Clear the spinner line
      process.stderr.write("\r\x1b[K");
    }
  }
}
