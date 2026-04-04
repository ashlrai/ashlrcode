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
import {
  loadFromKeychain,
  KEYCHAIN_ACCOUNTS,
  KEYCHAIN_PLACEHOLDER,
} from "./keychain.ts";

export interface ToolHookRule {
  /** Glob pattern for tool name (e.g. "Bash", "File*") */
  tool?: string;
  /** Regex to match against JSON-serialized input */
  inputPattern?: string;
  /** Shell command to run (gets TOOL_NAME, TOOL_INPUT env vars) */
  command?: string;
  /** Direct action without running a command */
  action?: "allow" | "deny";
}

export interface PostToolHookRule {
  /** Glob pattern for tool name */
  tool?: string;
  /** Shell command to run (gets TOOL_NAME, TOOL_INPUT, TOOL_RESULT env vars) */
  command?: string;
}

export interface Settings {
  providers: ProviderRouterConfig;
  defaultModel?: string;
  maxTokens?: number;
  hooks?: HooksConfig;
  toolHooks?: {
    preToolUse?: ToolHookRule[];
    postToolUse?: PostToolHookRule[];
  };
  mcpServers?: Record<string, MCPServerConfig>;
  permissionRules?: Array<{ tool: string; inputPattern?: string; action: "allow" | "deny" | "ask" }>;
  remoteSettingsUrl?: string;

  // ── Configurable limits (all optional, sensible defaults) ───
  /** Max agent loop iterations per turn (default: 25) */
  maxIterations?: number;
  /** Stream inactivity timeout in ms (default: 300000 = 5 min) */
  streamTimeoutMs?: number;
  /** Tool execution timeout in ms (default: 120000 = 2 min) */
  toolTimeoutMs?: number;
  /** System prompt token budget cap (default: 50000) */
  systemPromptBudget?: number;
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

  let settings: Settings;

  if (existsSync(settingsPath)) {
    const raw = await readFile(settingsPath, "utf-8");
    const fileSettings = JSON.parse(raw) as Partial<Settings>;

    // Merge file settings with defaults — file settings override but
    // providers always come from env vars / defaults if not in file
    settings = {
      ...defaults,
      ...fileSettings,
      providers: fileSettings.providers ?? defaults.providers,
      hooks: fileSettings.hooks ?? defaults.hooks,
      toolHooks: fileSettings.toolHooks ?? defaults.toolHooks,
      mcpServers: fileSettings.mcpServers ?? defaults.mcpServers,
    };
  } else {
    settings = defaults;
  }

  // Overlay keychain credentials — if the key is a placeholder or missing,
  // attempt to load the real key from macOS Keychain.
  await overlayKeychainKeys(settings);

  return settings;
}

/**
 * Check macOS Keychain for API keys and overlay them onto settings.
 * Keychain keys override file-based keys when the file value is the
 * placeholder `__keychain__` or empty.
 */
async function overlayKeychainKeys(settings: Settings): Promise<void> {
  const SERVICE = "ashlrcode";

  // Primary provider
  const primaryKey = settings.providers.primary.apiKey;
  if (!primaryKey || primaryKey === KEYCHAIN_PLACEHOLDER) {
    const account =
      settings.providers.primary.provider === "anthropic"
        ? KEYCHAIN_ACCOUNTS.anthropic
        : KEYCHAIN_ACCOUNTS.xai;
    const keychainKey = await loadFromKeychain(SERVICE, account);
    if (keychainKey) {
      settings.providers.primary.apiKey = keychainKey;
    }
  }

  // Fallback providers
  if (settings.providers.fallbacks) {
    for (const fb of settings.providers.fallbacks) {
      if (!fb.apiKey || fb.apiKey === KEYCHAIN_PLACEHOLDER) {
        const account =
          fb.provider === "xai"
            ? KEYCHAIN_ACCOUNTS.xai
            : KEYCHAIN_ACCOUNTS.anthropic;
        const keychainKey = await loadFromKeychain(SERVICE, account);
        if (keychainKey) {
          fb.apiKey = keychainKey;
        }
      }
    }
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });
  await writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

function getDefaultSettings(): Settings {
  // Filter out empty strings from env vars — treat "" as unset
  const xaiKey = process.env.XAI_API_KEY?.trim() || "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || "";

  return {
    providers: {
      primary: {
        provider: "xai",
        apiKey: xaiKey,
        model: process.env.AC_MODEL ?? "grok-4-1-fast-reasoning",
        baseURL: "https://api.x.ai/v1",
      },
      fallbacks: anthropicKey
        ? [
            {
              provider: "anthropic",
              apiKey: anthropicKey,
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
