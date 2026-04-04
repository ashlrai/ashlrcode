/**
 * Context management — token estimation and automatic compression.
 *
 * Three-tier strategy from Claude Code:
 * 1. autoCompact — summarize older messages when approaching token limit
 * 2. snipCompact — remove stale tool results and zombie messages
 * 3. contextCollapse — restructure for efficiency (future)
 */

import type { Message, ContentBlock } from "../providers/types.ts";
import type { ProviderRouter } from "../providers/router.ts";

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

/** Provider-aware context limits (in tokens). */
const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
  xai: 2_000_000,
  anthropic: 200_000,
  openai: 128_000,
  ollama: 32_000,   // Conservative default; most local models are 4K-128K
  groq: 128_000,
  deepseek: 128_000,
};

/**
 * Get the context token limit for a given provider.
 */
export function getProviderContextLimit(providerName: string): number {
  const lower = providerName.toLowerCase();
  for (const [key, limit] of Object.entries(PROVIDER_CONTEXT_LIMITS)) {
    if (lower.includes(key)) return limit;
  }
  return DEFAULT_CONFIG.maxContextTokens;
}

/**
 * Estimate token count for messages.
 * Uses ~4 chars per token heuristic (good enough for cost tracking).
 */
export function estimateTokens(messages: Message[]): number {
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
      return 1000; // Estimate ~1000 tokens per image
    default:
      return 0;
  }
}

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
  router: ProviderRouter,
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
  const summary = await summarizeMessages(olderMessages, router);

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
  router: ProviderRouter
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
  const stream = router.stream({
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
