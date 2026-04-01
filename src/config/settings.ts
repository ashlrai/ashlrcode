/**
 * Settings — configuration management for AshlrCode.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ProviderRouterConfig } from "../providers/types.ts";

export interface Settings {
  providers: ProviderRouterConfig;
  defaultModel?: string;
  maxTokens?: number;
}

const CONFIG_DIR = join(homedir(), ".ashlrcode");
const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");

export async function loadSettings(): Promise<Settings> {
  if (existsSync(SETTINGS_PATH)) {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as Settings;
  }

  // Default settings — xAI as primary
  return getDefaultSettings();
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

function getDefaultSettings(): Settings {
  return {
    providers: {
      primary: {
        provider: "xai",
        apiKey: process.env.XAI_API_KEY ?? "",
        model: process.env.AC_MODEL ?? "grok-4-1-fast-reasoning",
        baseURL: "https://api.x.ai/v1",
      },
      fallbacks: process.env.ANTHROPIC_API_KEY
        ? [
            {
              provider: "anthropic",
              apiKey: process.env.ANTHROPIC_API_KEY,
              model: "claude-sonnet-4-6-20250514",
            },
          ]
        : [],
    },
    maxTokens: 8192,
  };
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
