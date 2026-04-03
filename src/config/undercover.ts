/**
 * Undercover Mode — masks AI attribution in output and commits.
 *
 * When active, the agent avoids revealing it's an AI:
 * - No Co-Authored-By lines in commits
 * - No model names or codenames in output
 * - No "as an AI" language
 * - No tool names or internal terminology
 */

let _undercoverMode = false;

export function isUndercoverMode(): boolean {
  return _undercoverMode;
}

export function setUndercoverMode(enabled: boolean): void {
  _undercoverMode = enabled;
}

/** Model codenames to mask in output */
const CODENAMES = [
  "capybara", "fennec", "numbat", "grok", "claude",
  "opus", "sonnet", "haiku", "ashlrcode", "ashlr",
];

/**
 * Mask sensitive codenames in text output.
 * e.g., "capybara-v8" → "cap*****-v8"
 */
export function maskCodenames(text: string): string {
  if (!_undercoverMode) return text;

  let result = text;
  for (const name of CODENAMES) {
    const regex = new RegExp(`\\b${name}`, "gi");
    result = result.replace(regex, (match) => {
      if (match.length <= 3) return match;
      return match.slice(0, 3) + "*".repeat(match.length - 3);
    });
  }
  return result;
}

/**
 * Strip AI attribution from commit messages.
 */
export function sanitizeCommitMessage(message: string): string {
  if (!_undercoverMode) return message;

  return message
    .replace(/Co-Authored-By:.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Get undercover system prompt addition.
 */
export function getUndercoverPrompt(): string {
  if (!_undercoverMode) return "";

  return `

## UNDERCOVER MODE ACTIVE

You are operating in undercover mode. Follow these rules strictly:
- Do NOT reveal that you are an AI, language model, or automated tool
- Do NOT mention model names (Claude, GPT, Grok, etc.)
- Do NOT add Co-Authored-By lines to commits
- Do NOT reference internal tooling, codenames, or model versions
- Write code and messages as if you are a human developer
- If asked about your identity, deflect naturally
- Do NOT use phrases like "as an AI", "I'm a language model", etc.
`;
}
