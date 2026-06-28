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

  // ── Autonomous safety guards (default off) ────────────────────────────────

  /**
   * Route autonomous bash calls through `phantom exec -- <cmd>` so real
   * credentials are injected at the network edge rather than appearing in
   * prompts or transcripts. Requires `phantom` on PATH and an initialized
   * Phantom vault in the project. Degrades gracefully when unavailable.
   * Default: false.
   */
  phantomSealed?: boolean;

  /**
   * Scan dependency-install commands (npm/bun/pnpm/yarn/pip install) via
   * binshield before execution. Blocks on critical/high verdict; allows
   * otherwise. Degrades gracefully (fail-open) when binshield is unreachable.
   * Default: false.
   */
  binshieldGate?: boolean;

  /** Base URL for the binshield scan API. Default: https://api.binshield.dev */
  binshieldUrl?: string;

  /** Optional API key for authenticated binshield requests. */
  binshieldKey?: string;

  /**
   * Record a replayable, branchable timeline of every agent step (tool name,
   * args, result, and a cheap working-tree marker) to
   * `~/.ashlrcode/timelines/<sessionId>.jsonl`. Enables scrubbing backward,
   * forking from any step, and re-running. Never throws; bounded per session.
   * Default: false.
   */
  timeTravel?: boolean;

  /**
   * Live GenAI-OTel HUD: stream a span per LLM call and per tool call from the
   * autonomous loop to ashlr-pulse, plus a compact in-TUI cost/token summary.
   * Telemetry is best-effort and never blocks the agent. Default: false.
   */
  pulseHud?: boolean;

  /**
   * ashlr-pulse OTLP endpoint. Accepts a base Pulse URL (the
   * `/api/otlp/v1/traces` path is appended automatically) or the full traces
   * URL. Falls back to the `PULSE_OTLP_URL` env var when unset.
   */
  pulseOtlpUrl?: string;

  /** Optional bearer token for the Pulse OTLP endpoint (or PULSE_OTLP_API_KEY). */
  pulseOtlpApiKey?: string;
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

  // Fallback providers — only attempt keychain for known providers
  const accountMap: Record<string, string> = {
    xai: KEYCHAIN_ACCOUNTS.xai,
    anthropic: KEYCHAIN_ACCOUNTS.anthropic,
  };

  if (settings.providers.fallbacks) {
    for (const fb of settings.providers.fallbacks) {
      if (!fb.apiKey || fb.apiKey === KEYCHAIN_PLACEHOLDER) {
        const account = accountMap[fb.provider];
        if (!account) continue; // Skip providers without keychain support
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
        model: process.env.AC_MODEL ?? "grok-4.3",
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
