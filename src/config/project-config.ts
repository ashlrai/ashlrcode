/**
 * Project configuration — loads ASHLR.md / CLAUDE.md from project directories.
 *
 * Walks up the directory tree, merging project configs found along the way
 * (closest takes precedence, similar to .gitignore behavior).
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, dirname, resolve } from "path";

const CONFIG_FILENAMES = ["ASHLR.md", "CLAUDE.md"];

export interface ProjectConfig {
  instructions: string;
  sources: string[]; // file paths where instructions were found
}

/**
 * Load project configuration by walking up from cwd.
 */
export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const instructions: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();

  let dir = resolve(cwd);
  const root = dirname(dir);

  // Walk up, collect configs (stop at filesystem root or after 10 levels)
  for (let i = 0; i < 10 && dir !== root; i++) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = join(dir, filename);
      if (existsSync(configPath) && !seen.has(configPath)) {
        seen.add(configPath);
        const content = await readFile(configPath, "utf-8");
        instructions.push(`# ${filename} (${dir})\n\n${content}`);
        sources.push(configPath);
      }
    }
    dir = dirname(dir);
  }

  // Also check home directory for global config
  const homeConfig = join(process.env.HOME ?? "", ".ashlrcode", "ASHLR.md");
  if (existsSync(homeConfig) && !seen.has(homeConfig)) {
    const content = await readFile(homeConfig, "utf-8");
    instructions.push(`# Global ASHLR.md\n\n${content}`);
    sources.push(homeConfig);
  }

  return {
    instructions: instructions.join("\n\n---\n\n"),
    sources,
  };
}
