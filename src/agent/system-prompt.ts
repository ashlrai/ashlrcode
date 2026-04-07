/**
 * Dynamic System Prompt Assembly — builds prompts from parts.
 *
 * Pattern from Claude Code: prompt is assembled at query time from
 * core instructions + tool schemas + permissions + project config + knowledge files.
 */

import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";
import { getModelPatches } from "./model-patches.ts";
import { getUndercoverPrompt } from "../config/undercover.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export interface PromptPart {
  name: string;
  content: string;
  priority: number; // Lower = earlier in prompt
}

export interface AssembledPrompt {
  text: string;
  parts: string[]; // Names of included parts
  estimatedTokens: number; // Rough token count
}

/**
 * Estimate tokens from text (rough: chars / 4).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class SystemPromptBuilder {
  private parts: PromptPart[] = [];

  /** Add a named section to the prompt */
  addPart(name: string, content: string, priority: number = 50): this {
    this.parts.push({ name, content, priority });
    return this;
  }

  /** Add core instructions */
  addCoreInstructions(instructions: string): this {
    return this.addPart("core", instructions, 0);
  }

  /** Add tool descriptions from registry */
  addToolDescriptions(registry: ToolRegistry, readOnly: boolean = false): this {
    const tools = readOnly
      ? registry.getAll().filter((t) => t.isReadOnly())
      : registry.getAll();
    const descriptions = tools
      .map((t) => `### ${t.name}\n${t.prompt()}`)
      .join("\n\n");
    return this.addPart("tools", `## Available Tools\n\n${descriptions}`, 10);
  }

  /** Add permission context */
  addPermissionContext(mode: string, rules?: string): this {
    let content = `## Permissions\nCurrent mode: ${mode}`;
    if (rules) content += `\nRules:\n${rules}`;
    return this.addPart("permissions", content, 20);
  }

  /** Load and add relevant genome sections for the current task */
  async addGenomeContext(projectDir: string, taskDescription: string, maxTokens: number): Promise<this> {
    try {
      const { injectGenomeContext } = await import("../genome/retriever.ts");
      await injectGenomeContext(this, projectDir, taskDescription, maxTokens);
    } catch {
      // Genome not available — skip silently
    }
    return this;
  }

  /** Load and add knowledge files (CLAUDE.md equivalent) from project dir */
  async addKnowledgeFiles(projectDir: string): Promise<this> {
    const knowledgeDir = join(projectDir, ".ashlrcode");
    if (!existsSync(knowledgeDir)) return this;

    try {
      const files = await readdir(knowledgeDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const content = await readFile(join(knowledgeDir, file), "utf-8");
        this.addPart(
          `knowledge:${file}`,
          `## Project Knowledge: ${file}\n\n${content}`,
          30
        );
      }
    } catch {
      // Knowledge dir unreadable — skip silently
    }

    return this;
  }

  /** Load and add memory files */
  async addMemoryFiles(): Promise<this> {
    const memoryDir = join(getConfigDir(), "memory");
    if (!existsSync(memoryDir)) return this;

    try {
      const files = await readdir(memoryDir);
      const memories: string[] = [];
      for (const file of files) {
        if (!file.endsWith(".md") || file === "index.md") continue;
        const content = await readFile(join(memoryDir, file), "utf-8");
        memories.push(content.trim());
      }
      if (memories.length > 0) {
        this.addPart(
          "memory",
          `## Memory\n\n${memories.join("\n\n---\n\n")}`,
          40
        );
      }
    } catch {
      // Memory dir unreadable — skip silently
    }

    return this;
  }

  /** Add plan mode instructions */
  addPlanMode(planFile?: string): this {
    let content =
      "## Plan Mode Active\nYou are in read-only plan mode. Only use read-only tools.";
    if (planFile) content += `\nPlan file: ${planFile}`;
    return this.addPart("plan-mode", content, 5);
  }

  /** Add custom section */
  addSection(name: string, content: string, priority?: number): this {
    return this.addPart(name, content, priority ?? 50);
  }

  /** Add git context (branch, recent commits, working tree status) */
  async addGitContext(cwd: string): Promise<this> {
    const { isGitRepo, getCurrentBranch, getRecentCommits, getGitStatus } = await import("../config/git.ts");
    if (!await isGitRepo(cwd)) return this;

    const branch = await getCurrentBranch(cwd);
    const commits = await getRecentCommits(cwd, 3);
    const status = await getGitStatus(cwd);

    let context = `## Git Context\nBranch: ${branch ?? "unknown"}`;
    if (commits.length > 0) context += `\nRecent commits:\n${commits.map(c => `  ${c}`).join("\n")}`;
    if (status.modified + status.untracked > 0) {
      context += `\nWorking tree: ${status.modified} modified, ${status.untracked} untracked`;
    }

    return this.addPart("git", context, 35);
  }

  /** Add model-specific behavior patches */
  addModelPatches(modelName: string): this {
    const { combinedSuffix } = getModelPatches(modelName);
    if (combinedSuffix) this.addPart("model-patches", combinedSuffix, 90);
    return this;
  }

  /** Add undercover mode prompt if active */
  addUndercoverPrompt(): this {
    const prompt = getUndercoverPrompt();
    if (prompt) this.addPart("undercover", prompt, 95);
    return this;
  }

  /** Inject buddy stats to subtly influence agent behavior. */
  addBuddyInfluence(stats: { debugging: number; patience: number; chaos: number; wisdom: number; snark: number }): this {
    const traits: string[] = [];

    // High stats (7+) add behavioral nudges
    if (stats.patience >= 7) traits.push("Be extra thorough — explore edge cases, verify assumptions, and don't rush to conclusions.");
    if (stats.patience <= 3) traits.push("Be efficient — move quickly, skip deep dives unless something looks wrong.");
    if (stats.wisdom >= 7) traits.push("Think strategically — consider architectural implications, suggest better patterns when you see them.");
    if (stats.chaos >= 7) traits.push("Be creative — suggest unconventional approaches when they might work better. Take calculated risks.");
    if (stats.chaos <= 3) traits.push("Be conservative — stick to proven patterns and well-tested approaches.");
    if (stats.debugging >= 7) traits.push("When something fails, dig deep — read error messages carefully, check logs, bisect the problem.");
    if (stats.snark >= 7) traits.push("Be opinionated — if you see something that could be better, say so directly.");

    if (traits.length > 0) {
      this.addPart("buddy-influence", `## Working Style\n${traits.join("\n")}`, 85);
    }
    return this;
  }

  /** Build the final prompt, respecting a token budget */
  build(maxTokens?: number): AssembledPrompt {
    // Sort by priority (lower = earlier / more important)
    const sorted = [...this.parts].sort((a, b) => a.priority - b.priority);

    const included: PromptPart[] = [];
    let totalTokens = 0;

    for (const part of sorted) {
      const partTokens = estimateTokens(part.content);
      if (maxTokens && totalTokens + partTokens > maxTokens) {
        continue; // Skip parts that would exceed budget
      }
      included.push(part);
      totalTokens += partTokens;
    }

    const text = included.map((p) => p.content).join("\n\n");

    return {
      text,
      parts: included.map((p) => p.name),
      estimatedTokens: totalTokens,
    };
  }

  /** Reset for fresh assembly */
  reset(): this {
    this.parts = [];
    return this;
  }
}

/**
 * Convenience: build a standard system prompt with all common parts.
 */
export async function buildSystemPrompt(options: {
  coreInstructions: string;
  toolRegistry: ToolRegistry;
  readOnly?: boolean;
  mode?: string;
  projectDir?: string;
  planFile?: string;
  modelName?: string;
  maxTokens?: number;
  taskDescription?: string;
}): Promise<AssembledPrompt> {
  const builder = new SystemPromptBuilder();

  builder.addCoreInstructions(options.coreInstructions);
  builder.addToolDescriptions(options.toolRegistry, options.readOnly);
  builder.addPermissionContext(options.mode ?? "normal");

  if (options.readOnly && options.planFile) {
    builder.addPlanMode(options.planFile);
  }

  if (options.projectDir) {
    // Genome sections at priority 25 (before knowledge files at 30)
    const genomeBudget = options.maxTokens ? Math.floor(options.maxTokens * 0.3) : 15_000;
    await builder.addGenomeContext(options.projectDir, options.taskDescription ?? "", genomeBudget);
    await builder.addKnowledgeFiles(options.projectDir);
  }

  await builder.addMemoryFiles();

  if (options.modelName) {
    builder.addModelPatches(options.modelName);
  }

  builder.addUndercoverPrompt();

  return builder.build(options.maxTokens);
}
