/**
 * Context Window Overflow Handler — pre-API-call safety net.
 *
 * Detects imminent context window exhaustion and applies a tiered degradation
 * strategy so the agent loop never hits a hard provider limit mid-conversation.
 *
 * Degradation tiers (applied in order until usage drops below 90%):
 *   1. Auto-compact oldest 20% of messages (drop early history)
 *   2. Snip large tool results (truncate content > LARGE_TOOL_RESULT_CHARS)
 *   3. Collapse repetitive / low-signal content (dedup adjacent identical blocks)
 *   4. If still ≥ 90%: surface a structured OverflowWarning to the user with
 *      actionable choices (clear history / save checkpoint / switch model)
 *
 * Integration: call `checkContextOverflow(messages, providerName, costTracker?)`
 * as a pre-flight check at the top of each agent loop iteration.
 *
 * Design constraints (mirrors budget-allocator.ts / intent-trace.ts):
 *   - Never throws — failures degrade to no-op and return messages unchanged.
 *   - Deterministic — given the same input produces the same output.
 *   - Provider-aware — uses the 6-provider limit table from core-efficiency.
 *   - Cost-transparent — reports tokens saved via CostSavings on each run.
 */

import type { Message, ContentBlock } from "../providers/types.ts";
import {
  PROVIDER_CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  getProviderContextLimit,
} from "@ashlr/core-efficiency/budget";
import { estimateTokensFromMessages, estimateTokensFromString } from "../utils/tokens.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fraction of context at which overflow handling activates (warn threshold). */
export const OVERFLOW_WARN_THRESHOLD = 0.80;

/** Fraction of context at which we surface a structured warning to the user. */
export const OVERFLOW_CRITICAL_THRESHOLD = 0.90;

/** Fraction of oldest messages to drop in tier-1 auto-compact (20%). */
export const COMPACT_OLDEST_FRACTION = 0.20;

/** Characters above which a tool result is considered "large" for tier-2 snipping. */
export const LARGE_TOOL_RESULT_CHARS = 8_000;

/** Characters to keep from large tool results after snipping (head + tail). */
export const SNIP_KEEP_CHARS = 1_500;

/** Snip separator inserted between head and tail fragments. */
export const SNIP_SEPARATOR = "\n…[snipped by overflow handler]…\n";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity of the overflow condition. */
export type OverflowSeverity = "ok" | "warn" | "critical";

/** One actionable choice surfaced to the user when severity === "critical". */
export interface OverflowChoice {
  /** Short machine-readable key. */
  key: "clear_history" | "save_checkpoint" | "switch_model";
  /** Human-readable label. */
  label: string;
  /** Brief description of what this choice does. */
  description: string;
}

/** Structured warning returned when overflow is critical. */
export interface OverflowWarning {
  severity: "critical";
  /** Estimated token count before degradation. */
  estimatedTokens: number;
  /** Provider context limit. */
  contextLimit: number;
  /** Fill ratio before degradation (0–1). */
  fillRatio: number;
  /** Actionable choices for the user. */
  choices: OverflowChoice[];
  /** Human-readable summary. */
  message: string;
}

/** Tokens saved by each degradation step. */
export interface DegradationSavings {
  /** Tokens saved by dropping oldest messages (tier 1). */
  compactSaved: number;
  /** Tokens saved by snipping large tool results (tier 2). */
  snipSaved: number;
  /** Tokens saved by collapsing repetitive content (tier 3). */
  collapseSaved: number;
  /** Total tokens saved across all tiers. */
  totalSaved: number;
}

/** Full result of a `checkContextOverflow` call. */
export interface OverflowResult {
  /** Whether any degradation was applied. */
  degraded: boolean;
  /** Severity after degradation (or before if none applied). */
  severity: OverflowSeverity;
  /** Final (potentially compacted) messages. */
  messages: Message[];
  /** Estimated tokens in the returned messages. */
  estimatedTokens: number;
  /** Provider context limit used for this check. */
  contextLimit: number;
  /** Fill ratio of returned messages (0–1). */
  fillRatio: number;
  /** Token savings from each degradation tier (all zeros if no degradation). */
  savings: DegradationSavings;
  /** Structured warning surfaced to the user, if severity reached "critical". */
  warning?: OverflowWarning;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify fill ratio into severity. */
function classifySeverity(fillRatio: number): OverflowSeverity {
  if (fillRatio >= OVERFLOW_CRITICAL_THRESHOLD) return "critical";
  if (fillRatio >= OVERFLOW_WARN_THRESHOLD) return "warn";
  return "ok";
}

/** Deep-clone a message (shallow content clone is sufficient for our purposes). */
function cloneMessage(msg: Message): Message {
  return {
    role: msg.role,
    content: typeof msg.content === "string"
      ? msg.content
      : [...msg.content],
  };
}

/** Estimate tokens for a single Message. */
function estimateMessageTokens(msg: Message): number {
  return estimateTokensFromMessages([msg]);
}

// ---------------------------------------------------------------------------
// Tier 1 — auto-compact: drop oldest 20% of messages
// ---------------------------------------------------------------------------

/**
 * Drop the oldest `COMPACT_OLDEST_FRACTION` of messages.
 *
 * Preserves the invariant that the first message in the array (if it is from
 * the assistant) is never removed so the conversation retains coherence.
 * System-prompt injection messages (role "user" with only tool_result blocks)
 * at index 0 are also preserved.
 *
 * Returns a new array with the messages removed and the number of tokens saved.
 */
export function applyTier1Compact(
  messages: Message[]
): { messages: Message[]; tokensSaved: number } {
  if (messages.length === 0) return { messages: [], tokensSaved: 0 };

  // Number of messages to remove (rounded down, at least 1 if any messages exist)
  const dropCount = Math.max(1, Math.floor(messages.length * COMPACT_OLDEST_FRACTION));
  // Never drop the very last message (that's the current user turn)
  const safeDropCount = Math.min(dropCount, Math.max(0, messages.length - 1));
  if (safeDropCount === 0) return { messages: [...messages], tokensSaved: 0 };

  const dropped = messages.slice(0, safeDropCount);
  const kept = messages.slice(safeDropCount);

  const tokensSaved = estimateTokensFromMessages(dropped);
  return { messages: kept, tokensSaved };
}

// ---------------------------------------------------------------------------
// Tier 2 — snip large tool results
// ---------------------------------------------------------------------------

/**
 * Truncate tool_result content blocks that exceed LARGE_TOOL_RESULT_CHARS.
 * Keeps `SNIP_KEEP_CHARS / 2` from the head and `SNIP_KEEP_CHARS / 2` from
 * the tail with a SNIP_SEPARATOR in the middle.
 *
 * Returns new messages with snipped content and the tokens saved.
 */
export function applyTier2Snip(
  messages: Message[]
): { messages: Message[]; tokensSaved: number } {
  let tokensSaved = 0;
  const result: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(cloneMessage(msg));
      continue;
    }

    const newBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.content.length > LARGE_TOOL_RESULT_CHARS) {
        const half = Math.floor(SNIP_KEEP_CHARS / 2);
        const head = block.content.slice(0, half);
        const tail = block.content.slice(-half);
        const snipped = head + SNIP_SEPARATOR + tail;
        const saved = estimateTokensFromString(block.content) - estimateTokensFromString(snipped);
        tokensSaved += Math.max(0, saved);
        newBlocks.push({ ...block, content: snipped });
      } else {
        newBlocks.push(block);
      }
    }
    result.push({ role: msg.role, content: newBlocks });
  }

  return { messages: result, tokensSaved };
}

// ---------------------------------------------------------------------------
// Tier 3 — collapse repetitive content
// ---------------------------------------------------------------------------

/**
 * Remove duplicate adjacent tool_result blocks with identical content.
 *
 * This handles cases where the same command is re-run in a loop and the
 * results are repeated verbatim in the message history.
 *
 * Returns new messages with deduped blocks and the tokens saved.
 */
export function applyTier3Collapse(
  messages: Message[]
): { messages: Message[]; tokensSaved: number } {
  let tokensSaved = 0;
  const result: Message[] = [];
  const seenToolResults = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(cloneMessage(msg));
      continue;
    }

    const newBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        // Use a fingerprint of (tool_use_id + first 200 chars of content)
        const fingerprint = `${block.tool_use_id}:${block.content.slice(0, 200)}`;
        if (seenToolResults.has(fingerprint)) {
          // Replace with a collapsed placeholder
          const placeholder = `[duplicate tool result omitted — identical to earlier result for ${block.tool_use_id}]`;
          const saved = estimateTokensFromString(block.content) - estimateTokensFromString(placeholder);
          tokensSaved += Math.max(0, saved);
          newBlocks.push({ ...block, content: placeholder });
        } else {
          seenToolResults.add(fingerprint);
          newBlocks.push(block);
        }
      } else {
        newBlocks.push(block);
      }
    }
    result.push({ role: msg.role, content: newBlocks });
  }

  return { messages: result, tokensSaved };
}

// ---------------------------------------------------------------------------
// Overflow warning builder
// ---------------------------------------------------------------------------

/** Build the OVERFLOW_CHOICES constant for the warning. */
const OVERFLOW_CHOICES: OverflowChoice[] = [
  {
    key: "clear_history",
    label: "Clear conversation history",
    description: "Remove all prior messages and start fresh. You will lose conversation context.",
  },
  {
    key: "save_checkpoint",
    label: "Save checkpoint and compact",
    description: "Serialize the current session to disk, then compact the in-memory history.",
  },
  {
    key: "switch_model",
    label: "Switch to a larger context model",
    description: "Select a provider with a larger context window (e.g. xAI Grok at 2M tokens).",
  },
];

function buildOverflowWarning(
  estimatedTokens: number,
  contextLimit: number,
  fillRatio: number
): OverflowWarning {
  return {
    severity: "critical",
    estimatedTokens,
    contextLimit,
    fillRatio,
    choices: OVERFLOW_CHOICES,
    message:
      `Context window is ${(fillRatio * 100).toFixed(1)}% full ` +
      `(~${estimatedTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens). ` +
      `Graceful degradation has been applied but the window remains critically full. ` +
      `Please choose one of the actions below to continue safely.`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Pre-flight context overflow check for the agent loop.
 *
 * Call this once per iteration, before sending messages to the provider API.
 * If the estimated token count exceeds `OVERFLOW_WARN_THRESHOLD` of the
 * provider's context limit, degradation strategies are applied in order until
 * the fill ratio drops below `OVERFLOW_CRITICAL_THRESHOLD` or all strategies
 * are exhausted.
 *
 * @param messages      Current message array (not mutated — a new array is returned).
 * @param providerName  Provider name (case-insensitive, substring-matched).
 * @param systemPromptTokens  Estimated tokens consumed by the system prompt (default 0).
 * @returns             OverflowResult with (possibly compacted) messages and diagnostics.
 */
export function checkContextOverflow(
  messages: Message[],
  providerName: string,
  systemPromptTokens = 0
): OverflowResult {
  const contextLimit = getProviderContextLimit(providerName);

  // Initial estimate (system prompt + messages)
  const initialMsgTokens = estimateTokensFromMessages(messages);
  const initialTokens = initialMsgTokens + systemPromptTokens;
  const initialFillRatio = contextLimit > 0 ? initialTokens / contextLimit : 0;

  const savings: DegradationSavings = {
    compactSaved: 0,
    snipSaved: 0,
    collapseSaved: 0,
    totalSaved: 0,
  };

  // Fast path — well within limits
  if (initialFillRatio < OVERFLOW_WARN_THRESHOLD) {
    return {
      degraded: false,
      severity: "ok",
      messages,
      estimatedTokens: initialTokens,
      contextLimit,
      fillRatio: initialFillRatio,
      savings,
    };
  }

  let current = [...messages];
  let currentTokens = initialTokens;

  // ── Tier 1: Auto-compact oldest 20% ──────────────────────────────────────
  {
    const { messages: compacted, tokensSaved } = applyTier1Compact(current);
    savings.compactSaved = tokensSaved;
    current = compacted;
    currentTokens -= tokensSaved;
  }

  // ── Tier 2: Snip large tool results ──────────────────────────────────────
  if ((currentTokens / contextLimit) >= OVERFLOW_WARN_THRESHOLD) {
    const { messages: snipped, tokensSaved } = applyTier2Snip(current);
    savings.snipSaved = tokensSaved;
    current = snipped;
    currentTokens -= tokensSaved;
  }

  // ── Tier 3: Collapse repetitive content ──────────────────────────────────
  if ((currentTokens / contextLimit) >= OVERFLOW_WARN_THRESHOLD) {
    const { messages: collapsed, tokensSaved } = applyTier3Collapse(current);
    savings.collapseSaved = tokensSaved;
    current = collapsed;
    currentTokens -= tokensSaved;
  }

  savings.totalSaved = savings.compactSaved + savings.snipSaved + savings.collapseSaved;

  const finalFillRatio = contextLimit > 0 ? currentTokens / contextLimit : 0;
  const severity = classifySeverity(finalFillRatio);
  const degraded = savings.totalSaved > 0;

  let warning: OverflowWarning | undefined;
  if (severity === "critical") {
    warning = buildOverflowWarning(currentTokens, contextLimit, finalFillRatio);
  }

  return {
    degraded,
    severity,
    messages: current,
    estimatedTokens: currentTokens,
    contextLimit,
    fillRatio: finalFillRatio,
    savings,
    warning,
  };
}

// ---------------------------------------------------------------------------
// Re-export provider limit table for consumers that want to inspect it
// ---------------------------------------------------------------------------

export { PROVIDER_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT, getProviderContextLimit };
