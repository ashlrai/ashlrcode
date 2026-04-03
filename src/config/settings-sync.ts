/**
 * Settings Sync — cross-device configuration synchronization.
 *
 * Two modes:
 * 1. Export/Import — manual file-based sync
 * 2. Git-based — auto-sync settings to a git repo
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, copyFile, stat } from "fs/promises";
import { join, dirname } from "path";
import { hostname } from "os";
import { getConfigDir } from "./settings.ts";

interface SyncManifest {
  version: number;
  exportedAt: string;
  hostname: string;
  platform: string;
  files: string[];
}

const SYNCABLE_FILES = [
  "settings.json",
  "permissions.json",
  "keybindings.json",
  "buddy.json",
];

const SYNCABLE_DIRS = [
  "memory",
  "workflows",
  "triggers",
  "teams",
];

/**
 * Export settings to a sync bundle directory.
 */
export async function exportSettings(targetDir: string): Promise<SyncManifest> {
  const configDir = getConfigDir();
  await mkdir(targetDir, { recursive: true });

  const files: string[] = [];

  // Copy individual files
  for (const file of SYNCABLE_FILES) {
    const src = join(configDir, file);
    if (existsSync(src)) {
      await copyFile(src, join(targetDir, file));
      files.push(file);
    }
  }

  // Copy directories
  for (const dir of SYNCABLE_DIRS) {
    const srcDir = join(configDir, dir);
    if (!existsSync(srcDir)) continue;

    const destDir = join(targetDir, dir);
    await mkdir(destDir, { recursive: true });

    const dirFiles = await readdir(srcDir);
    for (const f of dirFiles) {
      if (f.startsWith(".")) continue;
      await copyFile(join(srcDir, f), join(destDir, f));
      files.push(`${dir}/${f}`);
    }
  }

  const manifest: SyncManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    hostname: hostname(),
    platform: process.platform,
    files,
  };

  await writeFile(join(targetDir, "sync-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

/**
 * Import settings from a sync bundle directory.
 */
export async function importSettings(
  sourceDir: string,
  options: { overwrite?: boolean; merge?: boolean } = {},
): Promise<{ imported: string[]; skipped: string[] }> {
  const configDir = getConfigDir();
  const manifestPath = join(sourceDir, "sync-manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error("No sync-manifest.json found in source directory");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as SyncManifest;
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const file of manifest.files) {
    const src = join(sourceDir, file);
    const dest = join(configDir, file);

    if (!existsSync(src)) {
      skipped.push(file);
      continue;
    }

    // Create parent directory if needed
    await mkdir(dirname(dest), { recursive: true });

    if (existsSync(dest) && !options.overwrite) {
      if (options.merge && file.endsWith(".json")) {
        // Merge JSON files — incoming values override existing
        try {
          const existing = JSON.parse(await readFile(dest, "utf-8"));
          const incoming = JSON.parse(await readFile(src, "utf-8"));
          const merged = { ...existing, ...incoming };
          await writeFile(dest, JSON.stringify(merged, null, 2), "utf-8");
          imported.push(`${file} (merged)`);
          continue;
        } catch {
          // Fall through to skip if merge fails
        }
      }
      skipped.push(`${file} (exists)`);
      continue;
    }

    await copyFile(src, dest);
    imported.push(file);
  }

  return { imported, skipped };
}

/**
 * Get sync status — what would be synced.
 */
export async function getSyncStatus(): Promise<{ files: string[]; totalSize: number }> {
  const configDir = getConfigDir();
  const files: string[] = [];
  let totalSize = 0;

  for (const file of SYNCABLE_FILES) {
    const path = join(configDir, file);
    if (existsSync(path)) {
      const s = await stat(path);
      files.push(`${file} (${formatSize(s.size)})`);
      totalSize += s.size;
    }
  }

  for (const dir of SYNCABLE_DIRS) {
    const dirPath = join(configDir, dir);
    if (!existsSync(dirPath)) continue;
    const dirFiles = await readdir(dirPath);
    const count = dirFiles.filter((f) => !f.startsWith(".")).length;
    if (count > 0) files.push(`${dir}/ (${count} files)`);
  }

  return { files, totalSize };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
