/**
 * Token estimation — single source of truth.
 *
 * Previously duplicated in src/agent/context.ts, src/agent/system-prompt.ts,
 * and src/genome/manifest.ts. Consolidated here as part of the Phase-A prep
 * refactors for the @ashlr/core-efficiency extraction.
 *
 * Uses a chars/4 heuristic. Good enough for budgeting and cost estimation;
 * the real token count comes back from the provider in usage events.
 */

import type { ContentBlock, Message } from "../providers/types.ts";

/** Estimate tokens in a plain string. */
export function estimateTokensFromString(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens across a list of provider Messages (handles content blocks). */
export function estimateTokensFromMessages(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        chars += blockCharCount(block);
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Unified entry point — dispatches by input shape. */
export function estimateTokens(input: string | Message[]): number {
  return typeof input === "string"
    ? estimateTokensFromString(input)
    : estimateTokensFromMessages(input);
}

function blockCharCount(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length;
    case "tool_use":
      return block.name.length + JSON.stringify(block.input).length;
    case "tool_result":
      return block.content.length;
    case "image_url":
      return 1000; // ~1000 tokens per image
    default:
      return 0;
  }
}
