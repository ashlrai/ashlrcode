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

/** Check if there is a pending question awaiting an answer. */
export function hasPendingQuestion(): boolean {
  return pendingQuestionResolve !== null;
}

/** Answer a pending question (called from repl.tsx when the user submits input). */
export function answerPendingQuestion(answer: string): boolean {
  if (!pendingQuestionResolve) return false;
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
  const cols = Math.min(process.stdout.columns || 80, 72);
  const BORDER = chalk.hex("#A78BFA"); // violet-400 for questions
  const BORDER_BOLD = chalk.hex("#A78BFA").bold;

  const emptyLine = BORDER("│") + " ".repeat(cols - 2) + BORDER("│");

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

  // Wrap question text
  const qText = chalk.hex("#F1F5F9").bold(question);
  lines.push(padLine(qText, question.length));
  lines.push(emptyLine);

  // Options
  options.forEach((opt, i) => {
    const numStr = `${i + 1}`;
    const optLine = chalk.hex("#A78BFA").bold(`${numStr} → `) + chalk.hex("#F1F5F9")(opt.label);
    lines.push(padLine(optLine, numStr.length + 3 + opt.label.length));
    const descLine = chalk.hex("#94A3B8")("     " + opt.description);
    lines.push(padLine(descLine, 5 + opt.description.length));
    if (i < options.length - 1) lines.push(emptyLine);
  });

  lines.push(emptyLine);
  const otherStr = `${options.length + 1} → Other (type your own answer)`;
  lines.push(padLine(chalk.hex("#64748B")(otherStr), otherStr.length));
  lines.push(emptyLine);
  lines.push(bottom, "");

  console.log(lines.join("\n"));

  // Wait for user to submit input via the repl
  pendingOptions = options;
  const answer = await new Promise<string>((resolve) => {
    pendingQuestionResolve = resolve;
  });

  const choiceNum = parseInt(answer.trim(), 10);
  if (choiceNum >= 1 && choiceNum <= options.length) {
    const selected = options[choiceNum - 1]!;
    return `User selected: "${selected.label}" — ${selected.description}`;
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
