/**
 * Skill registry — lookup and expansion of slash commands.
 */

import type { SkillDefinition } from "./types.ts";

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.trigger, skill);
    // Also register by name for convenience
    if (!skill.trigger.startsWith("/")) {
      this.skills.set(`/${skill.name}`, skill);
    }
  }

  registerAll(skills: SkillDefinition[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /**
   * Look up a skill by trigger (e.g. "/commit").
   */
  get(trigger: string): SkillDefinition | undefined {
    return this.skills.get(trigger);
  }

  /**
   * Check if a string is a skill trigger.
   */
  isSkill(input: string): boolean {
    const trigger = input.split(" ")[0]!;
    return this.skills.has(trigger);
  }

  /**
   * Expand a skill invocation into its full prompt.
   * Supports {{args}} template variable.
   */
  expand(input: string): string | null {
    const parts = input.split(" ");
    const trigger = parts[0]!;
    const args = parts.slice(1).join(" ").trim();

    const skill = this.skills.get(trigger);
    if (!skill) return null;

    let prompt = skill.prompt;
    if (args) {
      prompt = prompt.replace(/\{\{args\}\}/g, args);
      // Also append args if no template variable
      if (!skill.prompt.includes("{{args}}")) {
        prompt += `\n\nAdditional context: ${args}`;
      }
    }

    return prompt;
  }

  /**
   * List all registered skills.
   */
  getAll(): SkillDefinition[] {
    // Deduplicate (same skill registered under trigger and /name)
    const seen = new Set<string>();
    const skills: SkillDefinition[] = [];
    for (const [, skill] of this.skills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
    return skills;
  }

  /**
   * Search skills by name or description.
   */
  search(query: string): SkillDefinition[] {
    const q = query.toLowerCase();
    return this.getAll().filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.trigger.toLowerCase().includes(q),
    );
  }

  /**
   * Get a skill's detailed info including source and version.
   */
  getInfo(nameOrTrigger: string): SkillDefinition | undefined {
    return this.skills.get(nameOrTrigger) ?? this.skills.get(`/${nameOrTrigger}`);
  }
}
