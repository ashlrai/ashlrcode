/**
 * Memory system — cross-session persistent context.
 *
 * Per-project memory stored at ~/.ashlrcode/memory/<project-hash>/
 * Memory types: user, feedback, project, reference (same as Claude Code).
 */

import { existsSync } from "fs";
import { readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { getConfigDir } from "../config/settings.ts";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  filePath: string;
}

function getProjectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function getMemoryDir(cwd: string): string {
  return join(getConfigDir(), "memory", getProjectHash(cwd));
}

/**
 * Load all memory entries for the current project.
 */
export async function loadMemories(cwd: string): Promise<MemoryEntry[]> {
  const memDir = getMemoryDir(cwd);
  if (!existsSync(memDir)) return [];

  const files = await readdir(memDir);
  const memories: MemoryEntry[] = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(memDir, file);
    const content = await readFile(filePath, "utf-8");
    const parsed = parseMemoryFile(content, filePath);
    if (parsed) memories.push(parsed);
  }

  return memories;
}

/**
 * Save a memory entry.
 */
export async function saveMemory(
  cwd: string,
  entry: Omit<MemoryEntry, "filePath">
): Promise<string> {
  const memDir = getMemoryDir(cwd);
  await mkdir(memDir, { recursive: true });

  const slug = entry.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 50);
  const filePath = join(memDir, `${slug}.md`);

  const fileContent = `---
name: ${entry.name}
description: ${entry.description}
type: ${entry.type}
---

${entry.content}
`;

  await writeFile(filePath, fileContent, "utf-8");
  return filePath;
}

/**
 * Delete a memory by name.
 */
export async function deleteMemory(cwd: string, name: string): Promise<boolean> {
  const memories = await loadMemories(cwd);
  const match = memories.find(
    (m) => m.name.toLowerCase() === name.toLowerCase()
  );
  if (!match) return false;

  await unlink(match.filePath);
  return true;
}

/**
 * Format memories for inclusion in the system prompt.
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";

  const sections = memories.map(
    (m) => `### ${m.name} (${m.type})\n${m.content}`
  );

  return `\n\n# Project Memory\n\n${sections.join("\n\n")}`;
}

function parseMemoryFile(
  content: string,
  filePath: string
): MemoryEntry | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1]!;
  const body = frontmatterMatch[2]!.trim();

  const name = extractField(frontmatter, "name");
  const description = extractField(frontmatter, "description");
  const type = extractField(frontmatter, "type") as MemoryEntry["type"];

  if (!name || !type) return null;

  return { name, description: description ?? "", type, content: body, filePath };
}

function extractField(frontmatter: string, field: string): string | null {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}
