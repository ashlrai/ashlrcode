/**
 * SnipTool — aggressive conversation history trimming.
 * Removes stale messages, truncates verbose tool outputs, deduplicates.
 */

import type { Tool, ToolContext } from "./types.ts";

// Module-level reference to history (set by cli.ts)
let _getHistory: (() => import("../providers/types.ts").Message[]) | null = null;
let _setHistory: ((msgs: import("../providers/types.ts").Message[]) => void) | null = null;

export function initSnipTool(
  getHistory: () => import("../providers/types.ts").Message[],
  setHistory: (msgs: import("../providers/types.ts").Message[]) => void,
): void {
  _getHistory = getHistory;
  _setHistory = setHistory;
}

export const snipTool: Tool = {
  name: "Snip",
  prompt() {
    return `Aggressively trim conversation history to free up context window space.
Actions:
- truncate: Shorten verbose tool outputs (>2000 chars) keeping first + last portions
- dedup: Remove consecutive duplicate tool results
- stale: Remove old assistant messages with no tool calls
- all: Apply all trimming strategies`;
  },
  inputSchema() {
    return {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          enum: ["truncate", "dedup", "stale", "all"],
          description: "Trimming strategy to apply",
        },
        maxOutputLength: {
          type: "number",
          description: "Max chars per tool output (default: 2000, for truncate strategy)",
        },
      },
      required: ["strategy"],
    };
  },
  isReadOnly() { return false; },
  isDestructive() { return false; },
  isConcurrencySafe() { return false; },
  validateInput(input) {
    if (!input.strategy) return "strategy required";
    if (!_getHistory || !_setHistory) return "SnipTool not initialized";
    return null;
  },
  async call(input) {
    if (!_getHistory || !_setHistory) return "SnipTool not initialized";

    const strategy = input.strategy as string;
    const maxLen = (input.maxOutputLength as number) ?? 2000;
    let history = _getHistory();
    const beforeCount = history.length;
    const beforeTokens = estimateTokens(history);

    if (strategy === "truncate" || strategy === "all") {
      history = truncateOutputs(history, maxLen);
    }
    if (strategy === "dedup" || strategy === "all") {
      history = deduplicateResults(history);
    }
    if (strategy === "stale" || strategy === "all") {
      history = removeStaleMessages(history);
    }

    _setHistory(history);
    const afterTokens = estimateTokens(history);
    const saved = beforeTokens - afterTokens;

    return `Snipped: ${beforeCount} → ${history.length} messages, ~${saved} tokens freed`;
  },
};

function estimateTokens(messages: any[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    total += Math.ceil(content.length / 4);
  }
  return total;
}

function truncateOutputs(messages: any[], maxLen: number): any[] {
  return messages.map(m => {
    if (typeof m.content !== "object" || !Array.isArray(m.content)) return m;
    const newContent = m.content.map((block: any) => {
      if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > maxLen) {
        const half = Math.floor(maxLen / 2);
        return {
          ...block,
          content: block.content.slice(0, half) +
            `\n[...truncated ${block.content.length - maxLen} chars...]\n` +
            block.content.slice(-half),
        };
      }
      return block;
    });
    return { ...m, content: newContent };
  });
}

function deduplicateResults(messages: any[]): any[] {
  const result: any[] = [];
  let lastToolResult = "";
  for (const m of messages) {
    if (typeof m.content === "object" && Array.isArray(m.content)) {
      const toolResults = m.content.filter((b: any) => b.type === "tool_result");
      if (toolResults.length > 0) {
        const key = toolResults.map((b: any) => String(b.content).slice(0, 100)).join("|");
        if (key === lastToolResult) continue; // Skip duplicate
        lastToolResult = key;
      }
    }
    result.push(m);
  }
  return result;
}

function removeStaleMessages(messages: any[]): any[] {
  // Keep last 10 messages always, remove old short assistant messages without tool calls
  if (messages.length <= 10) return messages;
  const keep = messages.slice(-10);
  const candidates = messages.slice(0, -10);

  const filtered = candidates.filter(m => {
    if (m.role !== "assistant") return true;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    // Keep if it contains tool_use blocks or is substantial
    if (content.includes("tool_use")) return true;
    if (content.length > 100) return true;
    return false; // Remove short assistant messages
  });

  return [...filtered, ...keep];
}
