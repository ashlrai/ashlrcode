/**
 * First-run setup wizard — interactive configuration for new users.
 *
 * Runs when no API key is configured. Walks through:
 * 1. API key entry (xAI or Anthropic)
 * 2. Model selection
 * 3. Saves to ~/.ashlrcode/settings.json
 */

import chalk from "chalk";
import { createInterface } from "readline";
import { saveSettings, type Settings } from "./config/settings.ts";
import type { ProviderRouterConfig } from "./providers/types.ts";
import {
  saveToKeychain,
  isKeychainAvailable,
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_PLACEHOLDER,
} from "./config/keychain.ts";

export async function runSetupWizard(): Promise<Settings> {
  console.log("");
  console.log(chalk.bold.cyan("  Welcome to AshlrCode"));
  console.log(chalk.dim("  Multi-provider AI coding agent CLI\n"));
  console.log(chalk.dim("  Let's get you set up. This takes about 30 seconds.\n"));

  // Step 1: Choose provider
  console.log(chalk.bold("  Step 1: Choose your AI provider\n"));
  console.log(chalk.dim("  1. ") + chalk.bold("xAI Grok") + chalk.dim(" — $0.20/$0.50 per M tokens, 2M context (recommended)"));
  console.log(chalk.dim("  2. ") + chalk.bold("Anthropic Claude") + chalk.dim(" — $3/$15 per M tokens, 200K context"));
  console.log(chalk.dim("  3. ") + chalk.bold("Both") + chalk.dim(" — xAI primary, Claude fallback"));
  console.log(chalk.dim("  4. ") + chalk.bold("Local models only") + chalk.dim(" — LM Studio / Ollama, fully free, no API keys\n"));

  const providerChoice = await prompt(chalk.cyan("  Provider [1/2/3/4]: "));
  const choice = providerChoice.trim() || "1";

  // Step 2: API key(s)
  let xaiKey = "";
  let anthropicKey = "";

  if (choice === "1" || choice === "3") {
    console.log(chalk.dim("\n  Get an xAI API key at: https://console.x.ai/\n"));
    xaiKey = await prompt(chalk.cyan("  xAI API key: "));
    xaiKey = xaiKey.trim();
  }

  if (choice === "2" || choice === "3") {
    console.log(chalk.dim("\n  Get a Claude API key at: https://console.anthropic.com/\n"));
    anthropicKey = await prompt(chalk.cyan("  Anthropic API key: "));
    anthropicKey = anthropicKey.trim();
  }

  // Local-only path — no API keys needed
  if (choice === "4") {
    console.log(chalk.dim("\n  Step 2: Choose local LLM backend\n"));
    console.log(chalk.dim("  1. ") + chalk.bold("LM Studio") + chalk.dim(" — http://localhost:1234 (recommended for coding)"));
    console.log(chalk.dim("  2. ") + chalk.bold("Ollama") + chalk.dim(" — http://localhost:11434 (simpler setup)"));
    console.log(chalk.dim("  3. ") + chalk.bold("Both") + chalk.dim(" — LM Studio primary, Ollama fallback\n"));

    const localChoice = await prompt(chalk.cyan("  Backend [1/2/3]: "));
    const lc = localChoice.trim() || "1";

    let localModel: string;
    if (lc === "2") {
      console.log(chalk.dim("\n  Which Ollama model? (default: gemma4:26b)\n"));
      const ollamaModel = await prompt(chalk.cyan("  Model name: "));
      localModel = ollamaModel.trim() || "gemma4:26b";
    } else {
      console.log(chalk.dim("\n  Which LM Studio model? (default: qwen/qwen3-coder-30b)\n"));
      const lmsModel = await prompt(chalk.cyan("  Model name: "));
      localModel = lmsModel.trim() || "qwen/qwen3-coder-30b";
    }

    const localProviders: ProviderRouterConfig = lc === "2"
      ? {
          primary: {
            provider: "ollama",
            apiKey: "local",
            model: localModel,
            baseURL: "http://localhost:11434",
          },
          fallbacks: [],
        }
      : {
          primary: {
            provider: "openai",
            apiKey: "lm-studio",
            model: localModel,
            baseURL: "http://localhost:1234/v1",
          },
          fallbacks: lc === "3"
            ? [{ provider: "ollama", apiKey: "local", model: "gemma4:26b", baseURL: "http://localhost:11434" }]
            : [],
        };

    const localSettings: Settings = { providers: localProviders, maxTokens: 8192 };
    await saveSettings(localSettings);

    console.log(chalk.green("\n  Setup complete!"));
    console.log(chalk.dim(`  Provider: local (${lc === "2" ? "Ollama" : "LM Studio"})`));
    console.log(chalk.dim(`  Model: ${localModel}`));
    console.log(chalk.dim(`  No API keys needed — fully free and private`));
    console.log(chalk.dim(`  Config saved to: ~/.ashlrcode/settings.json`));
    console.log(chalk.dim(`\n  Run ${chalk.bold("ac")} to start coding.\n`));

    return localSettings;
  }

  if (!xaiKey && !anthropicKey) {
    console.error(chalk.red("\n  At least one API key is required."));
    process.exit(1);
  }

  // Step 3: Model selection
  let model: string;
  if (xaiKey) {
    console.log(chalk.dim("\n  Step 2: Choose model\n"));
    console.log(chalk.dim("  1. ") + chalk.bold("grok-4.3") + chalk.dim(" — best value, tool-calling optimized (recommended)"));
    console.log(chalk.dim("  2. ") + chalk.bold("grok-4-0314") + chalk.dim(" — highest quality, higher cost"));
    console.log(chalk.dim("  3. ") + chalk.bold("grok-3-fast") + chalk.dim(" — older, cheapest\n"));
    const modelChoice = await prompt(chalk.cyan("  Model [1/2/3]: "));
    const mc = modelChoice.trim() || "1";
    model = mc === "2" ? "grok-4-0314" : mc === "3" ? "grok-3-fast" : "grok-4.3";
  } else {
    model = "claude-sonnet-4-6-20250514";
  }

  // Build settings
  const providers: ProviderRouterConfig = xaiKey
    ? {
        primary: {
          provider: "xai",
          apiKey: xaiKey,
          model,
          baseURL: "https://api.x.ai/v1",
        },
        fallbacks: anthropicKey
          ? [{ provider: "anthropic", apiKey: anthropicKey, model: "claude-sonnet-4-6-20250514" }]
          : [],
      }
    : {
        primary: {
          provider: "anthropic",
          apiKey: anthropicKey,
          model,
        },
        fallbacks: [],
      };

  // Attempt to store API keys in macOS Keychain for secure storage.
  // If keychain is available and save succeeds, replace the real key
  // in settings.json with a placeholder so it's never stored in plaintext.
  if (isKeychainAvailable()) {
    if (xaiKey) {
      const saved = await saveToKeychain("ashlrcode", KEYCHAIN_ACCOUNTS.xai, xaiKey);
      if (saved) {
        providers.primary.provider === "xai"
          ? (providers.primary.apiKey = KEYCHAIN_PLACEHOLDER)
          : providers.fallbacks?.forEach((fb) => {
              if (fb.provider === "xai") fb.apiKey = KEYCHAIN_PLACEHOLDER;
            });
      }
    }
    if (anthropicKey) {
      const saved = await saveToKeychain("ashlrcode", KEYCHAIN_ACCOUNTS.anthropic, anthropicKey);
      if (saved) {
        providers.primary.provider === "anthropic"
          ? (providers.primary.apiKey = KEYCHAIN_PLACEHOLDER)
          : providers.fallbacks?.forEach((fb) => {
              if (fb.provider === "anthropic") fb.apiKey = KEYCHAIN_PLACEHOLDER;
            });
      }
    }
  }

  const settings: Settings = { providers, maxTokens: 8192 };

  // Save
  await saveSettings(settings);

  console.log(chalk.green("\n  Setup complete!"));
  console.log(chalk.dim(`  Provider: ${providers.primary.provider}`));
  console.log(chalk.dim(`  Model: ${model}`));
  console.log(chalk.dim(`  Config saved to: ~/.ashlrcode/settings.json`));
  console.log(chalk.dim(`\n  Run ${chalk.bold("ac")} to start coding.\n`));

  return settings;
}

/**
 * Check if setup is needed (no API key from env or settings).
 */
/** Local provider placeholder keys that indicate a valid local-only setup. */
const LOCAL_PLACEHOLDERS = new Set(["local", "lm-studio", "ollama", "local-llm"]);

export function needsSetup(settings: { providers: ProviderRouterConfig }): boolean {
  const key = settings.providers.primary.apiKey;
  // __keychain__ is a placeholder — the real key was loaded from keychain
  // in loadSettings(). If it's still __keychain__ here, the keychain lookup
  // failed and we need setup.
  if (!key || key === KEYCHAIN_PLACEHOLDER) return true;
  // Local model placeholders are valid — no real API key needed.
  if (LOCAL_PLACEHOLDERS.has(key)) return false;
  return false;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
