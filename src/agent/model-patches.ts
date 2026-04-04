/**
 * Model behavior patches — provider/model-specific prompt adjustments.
 *
 * Different models have known issues. These patches add targeted
 * instructions to mitigate them.
 */

export interface ModelPatch {
  pattern: string;        // Regex to match model name
  name: string;           // Human-readable patch name
  promptSuffix: string;   // Added to system prompt
}

const PATCHES: ModelPatch[] = [
  {
    pattern: "^grok(?!-4-1-fast)",
    name: "Grok verbosity control",
    promptSuffix: "\n\nIMPORTANT: Be concise. Avoid unnecessary preamble. Lead with the answer or action, not reasoning. If you can say it in one sentence, don't use three.",
  },
  {
    pattern: "^grok-4-1-fast",
    name: "Grok fast mode",
    promptSuffix: "\n\nYou are running in fast mode. Prioritize speed. Use fewer tool calls. Give direct answers.",
  },
  {
    pattern: "^claude.*sonnet",
    name: "Sonnet conciseness",
    promptSuffix: "\n\nBe extremely concise. Skip filler words and preamble. No trailing summaries.",
  },
  {
    pattern: "^claude.*opus",
    name: "Opus thoroughness",
    promptSuffix: "\n\nBe thorough and precise. Verify your work. Check edge cases.",
  },
  {
    pattern: "^o1(-mini)?$",
    name: "OpenAI reasoning",
    promptSuffix: "\n\nYou have reasoning capabilities. Use them for complex problems. Think step by step when the problem requires it.",
  },
  {
    pattern: "^deepseek",
    name: "DeepSeek format control",
    promptSuffix: "\n\nAvoid over-commenting code. Keep code changes minimal and focused. Don't add docstrings unless asked.",
  },
  {
    pattern: "^llama3",
    name: "Llama 3 optimization",
    promptSuffix: "\n\nKeep tool calls simple. You have limited context — be efficient with tokens. Prefer single-file operations over multi-file. Always format JSON tool inputs carefully with proper quoting.",
  },
  {
    pattern: "^codellama|^code-llama",
    name: "CodeLlama specialization",
    promptSuffix: "\n\nYou excel at code generation and analysis. Focus tool usage on file reads and edits. Keep explanations brief — let the code speak. Be precise with file paths and line numbers.",
  },
  {
    pattern: "^mistral|^mixtral",
    name: "Mistral optimization",
    promptSuffix: "\n\nBe concise. Avoid unnecessary tool calls. You have limited context — prioritize the most relevant files. When editing, make minimal targeted changes.",
  },
  {
    pattern: "^deepseek-coder",
    name: "DeepSeek Coder optimization",
    promptSuffix: "\n\nYou are specialized for code. Use Grep and Glob to find code patterns efficiently. Make targeted edits. Avoid over-commenting — the code should be self-explanatory.",
  },
  {
    pattern: "^qwen|^qwen2",
    name: "Qwen optimization",
    promptSuffix: "\n\nBe efficient with context. Keep tool calls simple and direct. Avoid multi-step reasoning chains — break complex tasks into single steps.",
  },
  {
    pattern: "^(phi|local|tinyllama|gemma)",
    name: "Small model constraints",
    promptSuffix: "\n\nYou have very limited context. Keep tool calls simple. Only read files you need. Make one change at a time. Avoid complex JSON structures in tool inputs.",
  },
];

/**
 * Get applicable patches for the current model.
 */
export function getModelPatches(modelName: string): { names: string[]; combinedSuffix: string } {
  const applicable = PATCHES.filter(p => new RegExp(p.pattern, "i").test(modelName));
  return {
    names: applicable.map(p => p.name),
    combinedSuffix: applicable.map(p => p.promptSuffix).join(""),
  };
}

/**
 * List all available patches (for /patches command).
 */
export function listPatches(): ModelPatch[] {
  return [...PATCHES];
}
