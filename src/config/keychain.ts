/**
 * Keychain — secure credential storage using macOS Keychain.
 *
 * On macOS, API keys are stored in the system keychain via the `security` CLI.
 * On other platforms, all functions gracefully fall back (load returns null,
 * save/delete return false), preserving the existing plaintext settings flow.
 */

import { platform } from "os";

const SERVICE_NAME = "ashlrcode";

/** Account name constants for known API keys. */
export const KEYCHAIN_ACCOUNTS = {
  xai: "xai-api-key",
  anthropic: "anthropic-api-key",
} as const;

/** Placeholder value stored in settings.json when the real key is in keychain. */
export const KEYCHAIN_PLACEHOLDER = "__keychain__";

/**
 * Returns true on macOS where the `security` command is available.
 */
export function isKeychainAvailable(): boolean {
  return platform() === "darwin";
}

/**
 * Save a credential to the macOS Keychain.
 * Uses `-U` to update if the entry already exists.
 */
export async function saveToKeychain(
  service: string,
  account: string,
  password: string,
): Promise<boolean> {
  if (!isKeychainAvailable()) return false;

  try {
    const proc = Bun.spawn(
      ["security", "add-generic-password", "-a", account, "-s", service, "-w", password, "-U"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      // Log but don't throw — caller should fall back to plaintext
      console.error(`Keychain save failed: ${stderr.trim()}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a credential from the macOS Keychain.
 * Returns null if not found, not on macOS, or on any error.
 */
export async function loadFromKeychain(
  service: string,
  account: string,
): Promise<string | null> {
  if (!isKeychainAvailable()) return null;

  try {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdoutPromise = new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }
    const password = (await stdoutPromise).trim();
    return password || null;
  } catch {
    return null;
  }
}

/**
 * Delete a credential from the macOS Keychain.
 */
export async function deleteFromKeychain(
  service: string,
  account: string,
): Promise<boolean> {
  if (!isKeychainAvailable()) return false;

  try {
    const proc = Bun.spawn(
      ["security", "delete-generic-password", "-a", account, "-s", service],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
