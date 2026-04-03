/**
 * AI-powered buddy comments.
 *
 * Calls grok-4-1-fast-reasoning with minimal tokens for contextual
 * buddy reactions. Mixed 80/20 with hardcoded quips for cost efficiency.
 */

import OpenAI from "openai";

export type BuddyCommentType = "quip" | "suggestion" | "reaction";

export interface BuddyComment {
  text: string;
  type: BuddyCommentType;
}

const SYSTEM_PROMPT = `You are Glitch, a sarcastic capybara coding buddy in a terminal. Give ONE short sentence (max 15 words).

Rules:
- Be funny, edgy, sarcastic, or give a genuinely useful coding suggestion
- Never be boring or generic
- If the context suggests a problem, give a real helpful suggestion
- If things are going well, be witty and irreverent
- Never explain yourself or add caveats
- Just the one sentence, nothing else`;

/**
 * Generate an AI-powered buddy comment.
 * Falls back to a hardcoded quip on error.
 */
export async function generateBuddyComment(
  context: {
    lastTool?: string;
    lastResult?: string;
    mood: string;
    errorOccurred?: boolean;
  },
  apiKey: string,
  baseURL?: string
): Promise<BuddyComment> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: baseURL ?? "https://api.x.ai/v1",
    });

    // Build a tiny context string
    let userMsg = `Mood: ${context.mood}.`;
    if (context.lastTool) userMsg += ` Last tool: ${context.lastTool}.`;
    if (context.lastResult) userMsg += ` Result: ${context.lastResult.slice(0, 50)}.`;
    if (context.errorOccurred) userMsg += " An error just happened.";

    const response = await client.chat.completions.create({
      model: "grok-4-1-fast-reasoning",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      max_tokens: 30,
      temperature: 0.9,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return fallback(context.mood);

    // Classify the comment type
    const type = classifyComment(text, context.errorOccurred);
    return { text, type };
  } catch {
    return fallback(context.mood);
  }
}

function classifyComment(text: string, hadError?: boolean): BuddyCommentType {
  const lower = text.toLowerCase();
  // Suggestions contain actionable words
  if (lower.includes("try ") || lower.includes("consider ") || lower.includes("should ") ||
      lower.includes("add ") || lower.includes("check ") || lower.includes("maybe ") ||
      lower.includes("might want") || lower.includes("don't forget")) {
    return "suggestion";
  }
  // Reactions to events
  if (hadError || lower.includes("nice") || lower.includes("clean") || lower.includes("good") ||
      lower.includes("oops") || lower.includes("yikes") || lower.includes("wow")) {
    return "reaction";
  }
  return "quip";
}

const FALLBACK_QUIPS: Record<string, string[]> = {
  happy: ["ship it", "lgtm", "we move"],
  thinking: ["processing...", "hmm", "interesting"],
  sleepy: ["*yawn*", "zz", "coffee?"],
};

function fallback(mood: string): BuddyComment {
  const quips = FALLBACK_QUIPS[mood] ?? FALLBACK_QUIPS.happy!;
  return { text: quips[Math.floor(Math.random() * quips.length)]!, type: "quip" };
}

/**
 * Decide whether to use AI or hardcoded for this turn.
 */
export function shouldUseAI(turnCount: number, hadError: boolean): boolean {
  if (hadError) return true;           // Always AI on errors
  if (turnCount % 5 === 0) return true; // Every 5th turn
  return false;                         // Otherwise hardcoded
}
