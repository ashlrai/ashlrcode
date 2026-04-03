/**
 * Upgrade notice — check for new releases on startup.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./settings.ts";

const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // Once per day

interface UpgradeState {
  lastCheck: string;
  latestVersion?: string;
  currentVersion: string;
}

function getStatePath(): string {
  return join(getConfigDir(), "upgrade-state.json");
}

export async function checkForUpgrade(currentVersion: string): Promise<string | null> {
  const path = getStatePath();

  // Check if we already checked recently
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const state = JSON.parse(raw) as UpgradeState;
      if (Date.now() - new Date(state.lastCheck).getTime() < CHECK_INTERVAL) {
        // Already checked recently — return cached result
        if (state.latestVersion && state.latestVersion !== currentVersion) {
          return state.latestVersion;
        }
        return null;
      }
    } catch {}
  }

  try {
    // Check npm registry for latest version
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://registry.npmjs.org/ashlrcode/latest", {
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const data = await response.json() as { version: string };

    const state: UpgradeState = {
      lastCheck: new Date().toISOString(),
      latestVersion: data.version,
      currentVersion,
    };

    await mkdir(getConfigDir(), { recursive: true });
    await writeFile(getStatePath(), JSON.stringify(state), "utf-8");

    if (data.version !== currentVersion) return data.version;
    return null;
  } catch {
    return null;
  }
}
