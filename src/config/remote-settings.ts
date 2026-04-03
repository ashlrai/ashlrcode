/**
 * Remote Managed Settings — poll a server for configuration overrides.
 * Supports killswitches, model overrides, and feature flag updates.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "./settings.ts";
import { setFeature } from "./features.ts";

export interface RemoteSettings {
  version: number;
  features?: Record<string, boolean>;
  modelOverride?: string;
  effortOverride?: "low" | "normal" | "high";
  killswitches?: {
    bypassPermissions?: boolean;
    voiceMode?: boolean;
    kairosMode?: boolean;
    teamMode?: boolean;
  };
  message?: string; // Display to user on next startup
  fetchedAt: string;
}

const DEFAULT_POLL_INTERVAL = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT = 10_000; // 10s

let _remoteUrl: string | null = null;
let _apiKey: string | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _currentSettings: RemoteSettings | null = null;
let _onSettingsUpdate: ((settings: RemoteSettings) => void) | null = null;

function getCachePath(): string {
  return join(getConfigDir(), "remote-settings.json");
}

/** Initialize remote settings with endpoint and API key */
export function initRemoteSettings(
  url: string,
  apiKey: string,
  onUpdate?: (settings: RemoteSettings) => void,
): void {
  _remoteUrl = url;
  _apiKey = apiKey;
  _onSettingsUpdate = onUpdate ?? null;
}

/** Start polling for remote settings */
export function startPolling(
  intervalMs: number = DEFAULT_POLL_INTERVAL,
): void {
  if (_pollTimer || !_remoteUrl) return;

  // Fetch immediately, then poll
  fetchRemoteSettings().catch(() => {});

  _pollTimer = setInterval(() => {
    fetchRemoteSettings().catch(() => {});
  }, intervalMs);
}

/** Stop polling */
export function stopPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/** Fetch remote settings from server */
async function fetchRemoteSettings(): Promise<void> {
  if (!_remoteUrl || !_apiKey) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(_remoteUrl, {
      headers: {
        Authorization: `Bearer ${_apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return;

    const data = (await response.json()) as Omit<RemoteSettings, "fetchedAt">;
    const settings: RemoteSettings = {
      ...data,
      fetchedAt: new Date().toISOString(),
    };

    await applySettings(settings);
    await cacheSettings(settings);
    _currentSettings = settings;
    _onSettingsUpdate?.(settings);
  } catch {
    // Never crash on remote settings failure — this is best-effort
  }
}

/** Apply remote settings to the running instance */
async function applySettings(settings: RemoteSettings): Promise<void> {
  // Apply feature flags
  if (settings.features) {
    for (const [flag, enabled] of Object.entries(settings.features)) {
      setFeature(flag, enabled);
    }
  }

  // Apply killswitches (these override local settings — false means killed)
  if (settings.killswitches) {
    if (settings.killswitches.voiceMode === false)
      setFeature("VOICE_MODE", false);
    if (settings.killswitches.kairosMode === false)
      setFeature("KAIROS", false);
    if (settings.killswitches.teamMode === false)
      setFeature("TEAM_MODE", false);
  }
}

/** Cache settings to disk for offline use */
async function cacheSettings(settings: RemoteSettings): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(
    getCachePath(),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

/** Load cached settings (for offline startup) */
export async function loadCachedSettings(): Promise<RemoteSettings | null> {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = await readFile(cachePath, "utf-8");
    const settings = JSON.parse(raw) as RemoteSettings;
    _currentSettings = settings;
    await applySettings(settings);
    return settings;
  } catch {
    return null;
  }
}

/** Get current remote settings */
export function getRemoteSettings(): RemoteSettings | null {
  return _currentSettings;
}

/** Check if a specific killswitch is active (i.e. the feature is killed) */
export function isKillswitchActive(
  name: keyof NonNullable<RemoteSettings["killswitches"]>,
): boolean {
  return _currentSettings?.killswitches?.[name] === false;
}
