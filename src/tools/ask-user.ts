/**
 * AskUserQuestion tool — beautifully formatted interactive questions.
 */

import { createInterface } from "readline";
import { theme } from "../ui/theme.ts";
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
    const w = process.stdout.columns || 80;

    // Top separator
    console.log("");
    console.log(theme.border("─".repeat(w)));
    console.log("");

    // Question with styled icon
    console.log(theme.accentBold("  ✦  ") + theme.primary(question));
    console.log("");

    // Options — each on its own block with spacing
    options.forEach((opt, i) => {
      const num = theme.accent(`  ${i + 1} `);
      const dot = theme.accent("→");
      const label = theme.accentBold(` ${opt.label}`);
      console.log(`${num}${dot}${label}`);
      console.log(theme.secondary(`       ${opt.description}`));
      if (i < options.length - 1) console.log(""); // spacing between options
    });

    console.log("");
    console.log(theme.muted(`  ${options.length + 1} → Other (type your own answer)`));

    // Bottom separator
    console.log("");
    console.log(theme.border("─".repeat(w)));

    // Input prompt
    const answer = await promptUser(theme.accent("  Choice: "));

    const choiceNum = parseInt(answer.trim(), 10);

    if (choiceNum >= 1 && choiceNum <= options.length) {
      const selected = options[choiceNum - 1]!;
      console.log(theme.success(`  ✓ ${selected.label}`));
      console.log("");
      return `User selected: "${selected.label}" — ${selected.description}`;
    }

    if (choiceNum === options.length + 1 || isNaN(choiceNum)) {
      const customAnswer = isNaN(choiceNum)
        ? answer.trim()
        : await promptUser(theme.accent("  Your answer: "));
      console.log(theme.success(`  ✓ ${customAnswer}`));
      console.log("");
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
