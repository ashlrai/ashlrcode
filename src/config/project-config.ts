/**
 * Project configuration — loads ASHLR.md / CLAUDE.md from project directories.
 *
 * Walks up the directory tree, merging project configs found along the way
 * (closest takes precedence, similar to .gitignore behavior).
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, dirname, resolve } from "path";
import { getConfigDir } from "./settings.ts";

const CONFIG_FILENAMES = ["ASHLR.md", "CLAUDE.md"];

export interface ProjectConfig {
  instructions: string;
  sources: string[]; // file paths where instructions were found
}

/**
 * Load project configuration by walking up from cwd.
 */
export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const discovered: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  let dir = resolve(cwd);

  // Walk up, collect configs (stop at filesystem root or after 10 levels)
  for (let i = 0; i < 10; i++) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = join(dir, filename);
      if (existsSync(configPath) && !seen.has(configPath)) {
        seen.add(configPath);
        const content = await readFile(configPath, "utf-8");
        discovered.push({ path: configPath, content: `# ${filename} (${dir})\n\n${content}` });
      }
    }
    const parentDir = dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }

  // Also check home directory for global config
  const homeConfig = join(getConfigDir(), "ASHLR.md");
  if (existsSync(homeConfig) && !seen.has(homeConfig)) {
    const content = await readFile(homeConfig, "utf-8");
    discovered.push({ path: homeConfig, content: `# Global ASHLR.md\n\n${content}` });
  }

  const homePrefix = `${getConfigDir()}/`;
  const ordered = discovered.sort((a, b) => {
    const depth = (path: string) => path.split("/").length;
    const aDepth = a.path.startsWith(homePrefix) ? -1 : depth(a.path);
    const bDepth = b.path.startsWith(homePrefix) ? -1 : depth(b.path);
    return aDepth - bDepth;
  });

  return {
    instructions: ordered.map((entry) => entry.content).join("\n\n---\n\n"),
    sources: ordered.map((entry) => entry.path),
  };
}
