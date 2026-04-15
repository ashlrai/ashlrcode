/**
 * Context management — token estimation and automatic compression.
 *
 * Three-tier strategy from Claude Code:
 * 1. autoCompact — summarize older messages when approaching token limit
 * 2. snipCompact — remove stale tool results and zombie messages
 * 3. contextCollapse — restructure for efficiency (future)
 */

import type { LLMSummarizer, Message } from "../providers/types.ts";
import { estimateTokensFromMessages } from "../utils/tokens.ts";
import {
  DEFAULT_CONTEXT_LIMIT,
  PROVIDER_CONTEXT_LIMITS as CORE_PROVIDER_CONTEXT_LIMITS,
  getProviderContextLimit as coreGetProviderContextLimit,
} from "@ashlr/core-efficiency/budget";

/** @deprecated Use estimateTokensFromMessages from ../utils/tokens.ts */
export const estimateTokens = estimateTokensFromMessages;

export interface ContextConfig {
  /** Max tokens before triggering compaction (default: 100000) */
  maxContextTokens: number;
  /** Tokens to reserve for the response (default: 8192) */
  reserveTokens: number;
  /** Number of recent messages to keep at full fidelity (default: 10) */
  recentMessageCount: number;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxContextTokens: 100_000,
  reserveTokens: 8192,
  recentMessageCount: 10,
};

/** Provider-aware context limits — re-exported from @ashlr/core-efficiency. */
const PROVIDER_CONTEXT_LIMITS = CORE_PROVIDER_CONTEXT_LIMITS;

/**
 * Get the context token limit for a given provider.
 * Delegates to @ashlr/core-efficiency; preserved here so existing imports
 * from ashlrcode/src/agent/context.ts keep working unchanged.
 */
export const getProviderContextLimit = coreGetProviderContextLimit;

// Silence unused-warnings — both are re-exported above.
void PROVIDER_CONTEXT_LIMITS;
void DEFAULT_CONTEXT_LIMIT;

/**
 * Tier 3: contextCollapse — remove redundant messages from older history.
 * - Remove short assistant messages (< 10 chars)
 * - Deduplicate consecutive tool results with similar content
 * - Keep last 5 messages at full fidelity
 */
export function contextCollapse(messages: Message[]): Message[] {
  if (messages.length <= 5) return messages;

  const keepRecent = 5;
  const older = messages.slice(0, -keepRecent);
  const recent = messages.slice(-keepRecent);

  const collapsed: Message[] = [];
  let lastToolResultHash = "";

  let skipNext = false;
  for (const msg of older) {
    if (skipNext) { skipNext = false; continue; } // Skip tool result after removed assistant

    // Remove very short assistant messages (and their following tool results)
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim().length < 10) {
      skipNext = true; // Also skip the next user/tool_result to maintain alternation
      continue;
    }

    // Deduplicate similar consecutive tool results
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(b => b.type === "tool_result");
      if (toolResults.length > 0) {
        const hash = toolResults.map(b => b.type === "tool_result" ? b.content.slice(0, 200) : "").join("|");
        if (hash === lastToolResultHash) continue; // skip duplicate
        lastToolResultHash = hash;
      }
    }

    collapsed.push(msg);
  }

  return [...collapsed, ...recent];
}

/**
 * Check if context needs compaction.
 *
 * @param actualTokensUsed - If provided, uses the real token count from the
 *   last API response instead of the chars/4 estimate.
 */
export function needsCompaction(
  messages: Message[],
  systemPromptTokens: number,
  config: Partial<ContextConfig> = {},
  actualTokensUsed?: number
): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const messageTokens = actualTokensUsed ?? estimateTokens(messages);
  return messageTokens + systemPromptTokens > cfg.maxContextTokens - cfg.reserveTokens;
}

/**
 * Tier 1: autoCompact — summarize older messages.
 * Sends the older portion to the model for summarization,
 * then replaces them with a compact summary.
 */
export async function autoCompact(
  messages: Message[],
  summarizer: LLMSummarizer,
  config: Partial<ContextConfig> = {}
): Promise<Message[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (messages.length <= cfg.recentMessageCount) {
    return messages; // Nothing to compact
  }

  // Split: older messages to summarize, recent messages to keep
  const splitIndex = messages.length - cfg.recentMessageCount;
  const olderMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  // Summarize older messages
  const summary = await summarizeMessages(olderMessages, summarizer);

  // Return: summary + recent messages
  return [
    {
      role: "user",
      content: `[Context Summary — earlier conversation was compacted to save tokens]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from our earlier conversation. Let me continue from where we left off.",
    },
    ...recentMessages,
  ];
}

/**
 * Tier 2: snipCompact — remove verbose tool results and stale messages.
 */
export function snipCompact(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;

    const trimmedBlocks = msg.content.map((block) => {
      if (block.type === "tool_result" && block.content.length > 2000) {
        // Truncate long tool results, keeping first and last portions
        const truncated =
          block.content.slice(0, 800) +
          "\n\n[... truncated ...]\n\n" +
          block.content.slice(-800);
        return { ...block, content: truncated };
      }
      return block;
    });

    return { ...msg, content: trimmedBlocks };
  });
}

/**
 * Summarize a set of messages using the model.
 */
async function summarizeMessages(
  messages: Message[],
  summarizer: LLMSummarizer
): Promise<string> {
  const conversationText = messages
    .map((msg) => {
      const role = msg.role;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((b) => {
                if (b.type === "text") return b.text;
                if (b.type === "tool_use")
                  return `[Tool: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})]`;
                if (b.type === "tool_result")
                  return `[Result: ${b.content.slice(0, 300)}]`;
                return "";
              })
              .join("\n");
      return `${role}: ${content}`;
    })
    .join("\n\n");

  let summary = "";
  const stream = summarizer.stream({
    systemPrompt:
      "Summarize the following conversation concisely. Preserve key decisions, file paths mentioned, code changes made, and important context. Be thorough but compact. Output only the summary, no preamble.",
    messages: [
      {
        role: "user",
        content: `Summarize this conversation:\n\n${conversationText.slice(0, 50000)}`,
      },
    ],
    tools: [],
  });

  for await (const event of stream) {
    if (event.type === "text_delta" && event.text) {
      summary += event.text;
    }
  }

  return summary || "[Unable to generate summary]";
}
