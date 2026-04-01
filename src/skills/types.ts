/**
 * Skill types — slash commands that expand into full prompts.
 */

export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string; // e.g. "/commit"
  prompt: string; // The full prompt template
  args?: string; // Optional args passed by user
}
