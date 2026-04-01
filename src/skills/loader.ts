/**
 * Skill loader — reads skill definitions from .md files.
 *
 * Loads from:
 * 1. Built-in skills: prompts/skills/*.md (shipped with AshlrCode)
 * 2. User skills: ~/.ashlrcode/skills/*.md
 * 3. Project skills: .ashlrcode/skills/*.md (per-project)
 */

import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join, resolve } from "path";
import { getConfigDir } from "../config/settings.ts";
import type { SkillDefinition } from "./types.ts";

const BUILT_IN_DIR = resolve(import.meta.dir, "../../prompts/skills");
const USER_DIR = join(getConfigDir(), "skills");

export async function loadSkills(cwd: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();

  // Load from all sources (project overrides user overrides built-in)
  const dirs = [
    BUILT_IN_DIR,
    USER_DIR,
    join(cwd, ".ashlrcode", "skills"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const content = await readFile(join(dir, file), "utf-8");
      const skill = parseSkillFile(content);
      if (skill) {
        // Later sources override earlier ones
        if (seen.has(skill.name)) {
          const idx = skills.findIndex((s) => s.name === skill.name);
          if (idx >= 0) skills[idx] = skill;
        } else {
          seen.add(skill.name);
          skills.push(skill);
        }
      }
    }
  }

  return skills;
}

function parseSkillFile(content: string): SkillDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const prompt = match[2]!.trim();

  const name = extractField(frontmatter, "name");
  const description = extractField(frontmatter, "description");
  const trigger = extractField(frontmatter, "trigger");

  if (!name || !trigger) return null;

  return {
    name,
    description: description ?? name,
    trigger,
    prompt,
  };
}

function extractField(frontmatter: string, field: string): string | null {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}
