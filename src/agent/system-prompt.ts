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
  maxTokens?: number;
}): Promise<AssembledPrompt> {
  const builder = new SystemPromptBuilder();

  builder.addCoreInstructions(options.coreInstructions);
  builder.addToolDescriptions(options.toolRegistry, options.readOnly);
  builder.addPermissionContext(options.mode ?? "normal");

  if (options.readOnly && options.planFile) {
    builder.addPlanMode(options.planFile);
  }

  if (options.projectDir) {
    await builder.addKnowledgeFiles(options.projectDir);
  }

  await builder.addMemoryFiles();

  return builder.build(options.maxTokens);
}
