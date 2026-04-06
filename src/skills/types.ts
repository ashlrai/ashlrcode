/**
 * Skill types — slash commands that expand into full prompts.
 */

export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string; // e.g. "/commit"
  prompt: string; // The full prompt template
  args?: string; // Optional args passed by user
  /** Version string (from marketplace packages) */
  version?: string;
  /** Author name or email */
  author?: string;
  /** Where this skill was loaded from */
  source?: "built-in" | "user" | "project" | "marketplace";
}

/**
 * A skill package — a directory containing one or more skills.
 * Used by the marketplace for versioned distribution.
 */
export interface SkillPackage {
  name: string;
  version: string;
  description: string;
  author?: { name: string; email?: string; url?: string };
  skills: string[]; // .md filenames in the package
  homepage?: string;
  repository?: string;
}

