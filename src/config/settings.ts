/**
 * Settings — configuration management for AshlrCode.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ProviderRouterConfig } from "../providers/types.ts";
import type { HooksConfig } from "./hooks.ts";
import type { MCPServerConfig } from "../mcp/types.ts";

export interface Settings {
  providers: ProviderRouterConfig;
  defaultModel?: string;
  maxTokens?: number;
  hooks?: HooksConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  permissionRules?: Array<{ tool: string; inputPattern?: string; action: "allow" | "deny" | "ask" }>;
}

let configDirOverride: string | null = null;

function getDefaultConfigDir(): string {
  return process.env.ASHLRCODE_CONFIG_DIR ?? join(homedir(), ".ashlrcode");
}

function getSettingsPath(): string {
  return join(getConfigDir(), "settings.json");
}

export async function loadSettings(): Promise<Settings> {
  const defaults = getDefaultSettings();
  const settingsPath = getSettingsPath();

  if (existsSync(settingsPath)) {
    const raw = await readFile(settingsPath, "utf-8");
    const fileSettings = JSON.parse(raw) as Partial<Settings>;

    // Merge file settings with defaults — file settings override but
    // providers always come from env vars / defaults if not in file
    return {
      ...defaults,
      ...fileSettings,
      providers: fileSettings.providers ?? defaults.providers,
      hooks: fileSettings.hooks ?? defaults.hooks,
      mcpServers: fileSettings.mcpServers ?? defaults.mcpServers,
    };
  }

  return defaults;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  await writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
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
  return configDirOverride ?? getDefaultConfigDir();
}

export function setConfigDirForTests(configDir: string | null): void {
  configDirOverride = configDir;
}
