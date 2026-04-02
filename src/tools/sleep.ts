/**
 * SleepTool — pause the agent for a specified duration.
 * Useful for polling, rate limit backoff, or waiting for external processes.
 */

import type { Tool, ToolContext } from "./types.ts";

export const sleepTool: Tool = {
  name: "Sleep",

  prompt() {
    return "Pause execution for a specified number of seconds. Use when waiting for a process to complete, implementing polling, or backing off from rate limits. Maximum 60 seconds.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: "Number of seconds to sleep (1-60)",
        },
        reason: {
          type: "string",
          description: "Why the agent is sleeping (displayed to user)",
        },
      },
      required: ["seconds"],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    const seconds = input.seconds as number;
    if (!seconds || seconds < 1 || seconds > 60) {
      return "seconds must be between 1 and 60";
    }
    return null;
  },

  async call(input, _context) {
    const seconds = input.seconds as number;
    const reason = (input.reason as string) ?? "";
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return `Slept for ${seconds}s${reason ? ` (${reason})` : ""}`;
  },
};
