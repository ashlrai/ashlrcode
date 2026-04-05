/**
 * AskUserQuestion tool — beautifully formatted interactive questions.
 *
 * Supports two input modes:
 *   1. readline (classic CLI) — used when Ink is not active
 *   2. pending-question callback (Ink mode) — question is displayed via
 *      console output; the next user submission in repl.tsx resolves
 *      the pending promise via `answerPendingQuestion()`.
 */

import chalk from "chalk";
import { createInterface } from "readline";
import { isBypassMode } from "../config/permissions.ts";
import { theme } from "../ui/theme.ts";
import type { Tool, ToolContext } from "./types.ts";

export interface QuestionOption {
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Ink-mode pending-question mechanism
// ---------------------------------------------------------------------------

/** Resolver for the currently pending question (null when idle). */
let pendingQuestionResolve: ((answer: string) => void) | null = null;

/** Options for the currently pending question. */
let pendingOptions: QuestionOption[] = [];

/** Callback to render output through the REPL's addOutput (set by repl.tsx). */
let _outputFn: ((text: string) => void) | null = null;

/** Callback to toggle isProcessing in the REPL (set by repl.tsx). */
let _processingHook: ((processing: boolean) => void) | null = null;

/**
 * Wire AskUser to the REPL's output and processing state.
 * Called from repl.tsx after addOutput is available.
 */
export function setAskUserCallbacks(
  output: (text: string) => void,
  processingHook: (processing: boolean) => void,
): void {
  _outputFn = output;
  _processingHook = processingHook;
}

/** Check if there is a pending question awaiting an answer. */
export function hasPendingQuestion(): boolean {
  return pendingQuestionResolve !== null;
}

/** Answer a pending question (called from repl.tsx when the user submits input). */
export function answerPendingQuestion(answer: string): boolean {
  if (!pendingQuestionResolve) return false;
  // Restore processing state before resolving (agent loop resumes)
  _processingHook?.(true);
  pendingQuestionResolve(answer);
  pendingQuestionResolve = null;
  pendingOptions = [];
  return true;
}

/** Return the options for the currently pending question. */
export function getPendingOptions(): QuestionOption[] {
  return pendingOptions;
}

export const askUserTool: Tool = {
  name: "AskUser",

  prompt() {
    return `Ask the user a question with structured options. Use this when you need to:
1. Clarify requirements or direction
2. Present design choices with tradeoffs
3. Get user input before proceeding with a task

Each question should have 2-4 options with clear labels and descriptions.
Questions should be specific and emerge from actual analysis, not generic.
The user can always type a custom answer beyond the provided options.`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user. Should be clear and specific.",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "Short label for this option (1-5 words)",
              },
              description: {
                type: "string",
                description: "Explanation of what this option means and its tradeoffs",
              },
            },
            required: ["label", "description"],
          },
          description: "2-4 options for the user to choose from",
        },
      },
      required: ["question", "options"],
    };
  },

  isReadOnly() {
    return true;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    if (!input.question || typeof input.question !== "string") {
      return "question is required";
    }
    if (!Array.isArray(input.options) || input.options.length < 2) {
      return "At least 2 options are required";
    }
    return null;
  },

  async call(input, _context) {
    const question = input.question as string;
    const options = input.options as QuestionOption[];

    if (isBypassMode()) {
      // Auto-accept first option in bypass/automated mode
      return `Auto-selected: ${options[0]?.label ?? "yes"} (bypass mode)`;
    }

    // Use Ink-mode rendering if pendingQuestionResolve is wired (REPL active),
    // otherwise fall back to CLI readline prompt
    return await askInInkMode(question, options);
  },
};

// ---------------------------------------------------------------------------
// Ink-mode implementation (bypass / Ink active)
// ---------------------------------------------------------------------------

async function askInInkMode(question: string, options: QuestionOption[]): Promise<string> {
  const cols = Math.min(process.stdout.columns || 80, Math.max(80, (process.stdout.columns || 80) - 10));
  const BORDER = chalk.hex("#A78BFA"); // violet-400 for questions
  const BORDER_BOLD = chalk.hex("#A78BFA").bold;
  const innerWidth = cols - 4; // 2 for borders, 2 for padding

  const emptyLine = BORDER("│") + " ".repeat(cols - 2) + BORDER("│");

  /** Wrap text to fit within the box, returning multiple padded lines. */
  function wrapText(text: string, maxWidth: number): string[] {
    if (text.length <= maxWidth) return [text];
    const words = text.split(" ");
    const wrapped: string[] = [];
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += " " + word;
      } else {
        wrapped.push(current);
        current = word;
      }
    }
    if (current) wrapped.push(current);
    return wrapped;
  }

  function padLine(content: string, rawLen: number): string {
    const pad = Math.max(0, cols - 2 - 2 - rawLen);
    return BORDER("│") + "  " + content + " ".repeat(pad) + BORDER("│");
  }

  const titleText = " ✦ Question ";
  const topBar =
    BORDER("┌─") + BORDER_BOLD(titleText) + BORDER("─".repeat(Math.max(0, cols - 2 - titleText.length - 2)) + "┐");
  const bottom = BORDER("└" + "─".repeat(cols - 2) + "┘");

  // Build lines
  const lines: string[] = ["", topBar, emptyLine];

  // Wrap question text within box width
  const questionLines = wrapText(question, innerWidth);
  for (const qLine of questionLines) {
    lines.push(padLine(chalk.hex("#F1F5F9").bold(qLine), qLine.length));
  }
  lines.push(emptyLine);

  // Options
  options.forEach((opt, i) => {
    const numStr = `${i + 1}`;
    const labelPrefix = `${numStr} → `;
    const labelText = opt.label;
    const optLine = chalk.hex("#A78BFA").bold(labelPrefix) + chalk.hex("#F1F5F9")(labelText);
    lines.push(padLine(optLine, labelPrefix.length + labelText.length));
    // Wrap description within box width (5 chars indent)
    const descIndent = "     ";
    const descLines = wrapText(opt.description, innerWidth - descIndent.length);
    for (const dLine of descLines) {
      lines.push(padLine(chalk.hex("#94A3B8")(descIndent + dLine), descIndent.length + dLine.length));
    }
    if (i < options.length - 1) lines.push(emptyLine);
  });

  lines.push(emptyLine);
  const otherStr = `${options.length + 1} → Other (type your own answer)`;
  lines.push(padLine(chalk.hex("#64748B")(otherStr), otherStr.length));
  lines.push(emptyLine);
  const hintStr = "Press 1-" + options.length + " to select instantly";
  lines.push(padLine(chalk.hex("#475569")(hintStr), hintStr.length));
  lines.push(emptyLine);
  lines.push(bottom, "");

  // Output through the REPL's addOutput (Ink-safe) instead of console.log
  const output = _outputFn ?? console.log;
  output(lines.join("\n"));

  // Set up pending state FIRST, then trigger update.
  // _processingHook(false) calls update() which checks hasPendingQuestion().
  // pendingQuestionResolve MUST be set before that update() runs.
  pendingOptions = options;
  const answer = await new Promise<string>((resolve) => {
    pendingQuestionResolve = resolve;
    // NOW trigger update — question state is fully set, selection UI will render
    _processingHook?.(false);
  });

  const choiceNum = parseInt(answer.trim(), 10);
  if (choiceNum >= 1 && choiceNum <= options.length) {
    const selected = options[choiceNum - 1]!;
    output(chalk.hex("#34D399")(`  ✓ ${selected.label}`) + chalk.hex("#94A3B8")(` — ${selected.description}`));
    return `User selected: "${selected.label}" — ${selected.description}`;
  }
  if (!isNaN(choiceNum) && choiceNum === options.length + 1) {
    output(chalk.hex("#94A3B8")(`  ✎ Custom answer requested`));
  }
  return `User's custom answer: "${answer.trim()}"`;
}

// ---------------------------------------------------------------------------
// CLI-mode implementation (readline, no Ink)
// ---------------------------------------------------------------------------

async function askInCliMode(question: string, options: QuestionOption[]): Promise<string> {
  const w = process.stdout.columns || 80;

  console.log("");
  console.log(theme.border("─".repeat(w)));
  console.log("");

  console.log(theme.accentBold("  ✦  ") + theme.primary(question));
  console.log("");

  options.forEach((opt, i) => {
    const num = theme.accent(`  ${i + 1} `);
    const dot = theme.accent("→");
    const label = theme.accentBold(` ${opt.label}`);
    console.log(`${num}${dot}${label}`);
    console.log(theme.secondary(`       ${opt.description}`));
    if (i < options.length - 1) console.log("");
  });

  console.log("");
  console.log(theme.muted(`  ${options.length + 1} → Other (type your own answer)`));

  console.log("");
  console.log(theme.border("─".repeat(w)));

  const answer = await promptUser(theme.accent("  Choice: "));

  const choiceNum = parseInt(answer.trim(), 10);

  if (choiceNum >= 1 && choiceNum <= options.length) {
    const selected = options[choiceNum - 1]!;
    console.log(theme.success(`  ✓ ${selected.label}`));
    console.log("");
    return `User selected: "${selected.label}" — ${selected.description}`;
  }

  if (choiceNum === options.length + 1 || isNaN(choiceNum)) {
    const customAnswer = isNaN(choiceNum) ? answer.trim() : await promptUser(theme.accent("  Your answer: "));
    console.log(theme.success(`  ✓ ${customAnswer}`));
    console.log("");
    return `User's custom answer: "${customAnswer}"`;
  }

  return `User selected option ${answer.trim()}`;
}

function promptUser(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
