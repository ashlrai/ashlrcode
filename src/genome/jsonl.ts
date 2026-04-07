/**
 * Shared JSONL file utilities for genome persistence.
 *
 * Append-only JSONL files are used for audit trails (mutations, proposals, strategies).
 * All reads are crash-safe: partial/corrupt lines are silently skipped.
 */

import { existsSync } from "fs";
import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname } from "path";

/**
 * Append a JSON record as a single line to a JSONL file.
 * Creates parent directories if they don't exist.
 */
export async function appendJsonl(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(path, JSON.stringify(data) + "\n", "utf-8");
}

/**
 * Read all records from a JSONL file.
 * Skips corrupt/partial lines (crash-safe).
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  const results: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // Skip corrupt JSONL lines — partial writes from crashes
    }
  }
  return results;
}
