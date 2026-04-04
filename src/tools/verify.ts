/**
 * Verify tool — manually trigger the verification agent.
 * Also auto-triggers after multi-file edit sequences.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  runVerification,
  formatVerificationReport,
  getModifiedFiles,
  type VerificationConfig,
} from "../agent/verification.ts";

let _router: ProviderRouter | null = null;
let _registry: ToolRegistry | null = null;
let _systemPrompt: string = "";

export function initVerifyTool(
  router: ProviderRouter,
  registry: ToolRegistry,
  systemPrompt: string,
): void {
  _router = router;
  _registry = registry;
  _systemPrompt = systemPrompt;
}

export const verifyTool: Tool = {
  name: "Verify",

  prompt() {
    return "Run a verification agent to check recent code changes for bugs, syntax errors, and logic issues. Spawns a read-only sub-agent that reviews git diff and modified files. Use after making non-trivial changes to validate correctness.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "What the changes were supposed to accomplish (helps the verifier check intent)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Specific files to verify (defaults to all recently modified files)",
        },
      },
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return false; },

  validateInput(_input) {
    if (!_router || !_registry) {
      return "Verify tool not initialized — call initVerifyTool() first";
    }
    return null;
  },

  async call(input, context) {
    if (!_router || !_registry) {
      return "Verify tool not initialized";
    }

    const config: VerificationConfig = {
      router: _router,
      toolRegistry: _registry,
      toolContext: context,
      systemPrompt: _systemPrompt,
    };

    const files = input.files as string[] | undefined;
    const intent = input.intent as string | undefined;

    const modifiedFiles = files ?? getModifiedFiles();
    if (modifiedFiles.length === 0) {
      return "No modified files to verify. Make some changes first, or specify files explicitly.";
    }

    const result = await runVerification(config, { intent, files: modifiedFiles });
    return formatVerificationReport(result);
  },
};
