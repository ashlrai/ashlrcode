/**
 * Skill validator — validates skill definitions before registration.
 *
 * Checks frontmatter schema, trigger conflicts, template variables,
 * and prompt size limits.
 */

import type { SkillDefinition } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a skill definition.
 */
export function validateSkill(skill: Partial<SkillDefinition>, existingTriggers?: Set<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!skill.name || typeof skill.name !== "string") {
    errors.push("name is required and must be a string");
  } else if (!/^[a-z0-9-]+$/.test(skill.name)) {
    errors.push("name must be lowercase alphanumeric with hyphens (e.g., 'my-skill')");
  }

  if (!skill.trigger || typeof skill.trigger !== "string") {
    errors.push("trigger is required and must be a string");
  } else if (!skill.trigger.startsWith("/")) {
    errors.push("trigger must start with / (e.g., '/my-skill')");
  }

  if (!skill.prompt || typeof skill.prompt !== "string") {
    errors.push("prompt is required (the markdown body after frontmatter)");
  }

  // Trigger conflicts
  if (skill.trigger && existingTriggers?.has(skill.trigger)) {
    warnings.push(`trigger "${skill.trigger}" conflicts with an existing skill — it will override it`);
  }

  // Template variable validation
  if (skill.prompt) {
    const templateVars = skill.prompt.match(/\{\{(\w+)\}\}/g) ?? [];
    const unknownVars = templateVars.filter((v) => v !== "{{args}}");
    if (unknownVars.length > 0) {
      warnings.push(`unknown template variables: ${unknownVars.join(", ")} (only {{args}} is supported)`);
    }
  }

  // Size limits
  if (skill.prompt && skill.prompt.length > 50_000) {
    errors.push(`prompt is too large (${skill.prompt.length} chars, max 50,000)`);
  } else if (skill.prompt && skill.prompt.length > 10_000) {
    warnings.push(`prompt is large (${skill.prompt.length} chars) — consider breaking it into sub-skills`);
  }

  // Description
  if (!skill.description) {
    warnings.push("description is missing — it helps users discover this skill");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a raw .md file before parsing.
 */
export function validateSkillFile(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check frontmatter exists
  if (!content.startsWith("---\n")) {
    errors.push("skill file must start with YAML frontmatter (---\\n...\\n---)");
    return { valid: false, errors, warnings };
  }

  const endMarker = content.indexOf("\n---\n", 4);
  if (endMarker === -1) {
    errors.push("frontmatter is not closed (missing closing ---)");
    return { valid: false, errors, warnings };
  }

  const frontmatter = content.slice(4, endMarker);
  const body = content.slice(endMarker + 5).trim();

  // Check required frontmatter fields
  if (!/^name:\s*.+$/m.test(frontmatter)) {
    errors.push("frontmatter must include 'name: <skill-name>'");
  }
  if (!/^trigger:\s*.+$/m.test(frontmatter)) {
    errors.push("frontmatter must include 'trigger: /<command>'");
  }

  if (!body) {
    errors.push("skill has no prompt body (empty after frontmatter)");
  }

  if (!/^description:\s*.+$/m.test(frontmatter)) {
    warnings.push("frontmatter should include 'description: <what it does>'");
  }

  return { valid: errors.length === 0, errors, warnings };
}
