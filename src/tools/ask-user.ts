/**
 * AskUserQuestion tool — interactive question with structured options.
 *
 * This is the core UX component of plan mode. The model asks strategic
 * questions with labeled options, and the user picks one or provides
 * a custom answer.
 */

import { createInterface } from "readline";
import chalk from "chalk";
import type { Tool, ToolContext } from "./types.ts";

export interface QuestionOption {
  label: string;
  description: string;
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
    return true; // Questions don't modify anything
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false; // Only one question at a time
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

    // Display the question
    console.log("");
    console.log(chalk.bold.cyan("  ? ") + chalk.bold(question));
    console.log("");

    // Display options
    options.forEach((opt, i) => {
      const num = chalk.cyan(`  ${i + 1}.`);
      const label = chalk.bold(opt.label);
      const desc = chalk.dim(` — ${opt.description}`);
      console.log(`${num} ${label}${desc}`);
    });

    console.log(
      chalk.dim(`  ${options.length + 1}. Other (type your own answer)`)
    );
    console.log("");

    // Get user input
    const answer = await promptUser(
      chalk.cyan("  Choice: ")
    );

    const choiceNum = parseInt(answer.trim(), 10);

    if (choiceNum >= 1 && choiceNum <= options.length) {
      const selected = options[choiceNum - 1]!;
      console.log(chalk.dim(`  → ${selected.label}`));
      return `User selected: "${selected.label}" — ${selected.description}`;
    }

    if (choiceNum === options.length + 1 || isNaN(choiceNum)) {
      // Custom answer
      const customAnswer = isNaN(choiceNum)
        ? answer.trim()
        : await promptUser(chalk.cyan("  Your answer: "));
      console.log(chalk.dim(`  → Custom: ${customAnswer}`));
      return `User's custom answer: "${customAnswer}"`;
    }

    return `User selected option ${answer.trim()}`;
  },
};

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
