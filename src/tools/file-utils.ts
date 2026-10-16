/**
 * Shared utilities for file tools (Read / Write / Edit).
 *
 * Centralises path validation, resolution, existence checks, sensitive-path
 * guards, and snapshot capture so each tool stays focused on its own logic.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { getFileHistory } from "../state/file-history.ts";

// ── Path validation ──────────────────────────────────────────────

/**
 * Validate that `input.file_path` is a non-empty string.
 * Returns an error string on failure, null on success.
 */
export function validateFilePath(input: Record<string, unknown>): string | null {
  if (!input.file_path || typeof input.file_path !== "string") {
    return "file_path is required and must be a string";
  }
  return null;
}

// ── Path resolution ──────────────────────────────────────────────

/**
 * Resolve `filePath` against `cwd` (mirrors `resolve(cwd, filePath)`).
 */
export function resolveFilePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

// ── Existence check ──────────────────────────────────────────────

/**
 * Return an error string if `filePath` does not exist on disk, null otherwise.
 * Used by Read and Edit before attempting to read.
 */
export function checkFileExists(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return `File not found: ${filePath}`;
  }
  return null;
}

// ── Sensitive-path guard ─────────────────────────────────────────

/** Paths that must never be written to. */
export const SENSITIVE_PATHS = ["/etc/", "/usr/bin/", "/sbin/", "/.ssh/"];

/**
 * Return an error string if `resolvedPath` falls under a sensitive prefix,
 * null otherwise.  Used by Write's checkPermissions.
 */
export function checkSensitivePath(resolvedPath: string): string | null {
  for (const s of SENSITIVE_PATHS) {
    if (resolvedPath.includes(s)) {
      return `Cannot write to sensitive path: ${s}`;
    }
  }
  return null;
}

// ── Snapshot capture ─────────────────────────────────────────────

/**
 * Capture a file snapshot via the active FileHistoryStore, if one is
 * registered.  No-ops gracefully when no store is initialised.
 */
export async function captureSnapshot(
  filePath: string,
  tool: string,
  turnNumber: number,
): Promise<void> {
  const history = getFileHistory();
  if (history) {
    await history.capture(filePath, tool, turnNumber);
  }
}
