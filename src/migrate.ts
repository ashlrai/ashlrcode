/**
 * Migrate from Claude Code — one-time config copy.
 *
 * Reads ~/.claude/settings.json and copies:
 * - MCP server configurations
 * - Permission rules (converted to AshlrCode format)
 * - Custom slash commands / skills
 *
 * Does NOT copy: sessions (different format), API keys (different providers),
 * or settings that don't apply (model names, IDE extensions, etc.)
 *
 * Usage: ac --migrate
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, copyFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import { getConfigDir, loadSettings, saveSettings, type Settings } from "./config/settings.ts";

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_SETTINGS = join(CLAUDE_DIR, "settings.json");
const CLAUDE_COMMANDS_DIR = join(CLAUDE_DIR, "commands");

interface ClaudeSettings {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    // Claude Code may have additional fields we don't need
    [key: string]: unknown;
  }>;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  hooks?: {
    preToolUse?: Array<{
      matcher?: string;
      command?: string;
      [key: string]: unknown;
    }>;
  };
  [key: string]: unknown;
}

export async function runMigration(): Promise<void> {
  console.log(chalk.cyan("\n  🔄 AshlrCode Migration from Claude Code\n"));

  // Check Claude Code config exists
  if (!existsSync(CLAUDE_DIR)) {
    console.log(chalk.yellow("  ~/.claude/ directory not found."));
    console.log(chalk.dim("  Make sure Claude Code is installed and has been run at least once.\n"));
    process.exit(1);
  }

  // Load existing AshlrCode settings (or defaults)
  const acSettings = await loadSettings();
  let changesMade = false;

  // ── Step 1: Migrate MCP Servers ──────────────────────────────
  if (existsSync(CLAUDE_SETTINGS)) {
    console.log(chalk.white("  Reading ~/.claude/settings.json..."));
    try {
      const raw = await readFile(CLAUDE_SETTINGS, "utf-8");
      const claudeSettings = JSON.parse(raw) as ClaudeSettings;

      // Also check project-level settings
      const projectSettingsPath = join(CLAUDE_DIR, "settings.local.json");
      let projectSettings: ClaudeSettings = {};
      if (existsSync(projectSettingsPath)) {
        try {
          projectSettings = JSON.parse(await readFile(projectSettingsPath, "utf-8")) as ClaudeSettings;
        } catch { /* ignore */ }
      }

      // Merge MCP servers from both global and project settings
      const allMcpServers = {
        ...claudeSettings.mcpServers,
        ...projectSettings.mcpServers,
      };

      if (Object.keys(allMcpServers).length > 0) {
        acSettings.mcpServers = acSettings.mcpServers ?? {};

        let migrated = 0;
        let skipped = 0;

        for (const [name, config] of Object.entries(allMcpServers)) {
          if (acSettings.mcpServers[name]) {
            console.log(chalk.dim(`    ⊘ ${name} — already exists, skipping`));
            skipped++;
            continue;
          }

          // Convert to AshlrCode MCPServerConfig format
          // We only copy fields our config supports
          const acConfig: Record<string, unknown> = {};
          if (config.command) acConfig.command = config.command;
          if (config.args) acConfig.args = config.args;
          if (config.env) acConfig.env = config.env;
          if (config.url) acConfig.url = config.url;

          acSettings.mcpServers[name] = acConfig as any;
          console.log(chalk.green(`    ✓ ${name} — migrated (${config.command ? "stdio" : config.url ? "SSE" : "unknown transport"})`));
          migrated++;
        }

        if (migrated > 0) {
          changesMade = true;
          console.log(chalk.cyan(`\n  MCP: ${migrated} servers migrated, ${skipped} skipped\n`));
        } else {
          console.log(chalk.dim(`\n  MCP: All ${skipped} servers already exist\n`));
        }
      } else {
        console.log(chalk.dim("  No MCP servers found in Claude Code config\n"));
      }

      // ── Step 2: Migrate Permission Rules ──────────────────────
      const claudePerms = claudeSettings.permissions;
      if (claudePerms) {
        acSettings.permissionRules = acSettings.permissionRules ?? [];
        let permsMigrated = 0;

        if (claudePerms.allow) {
          for (const pattern of claudePerms.allow) {
            // Claude Code allow rules are tool name patterns
            const exists = acSettings.permissionRules.some(
              (r) => r.tool === pattern && r.action === "allow"
            );
            if (!exists) {
              acSettings.permissionRules.push({ tool: pattern, action: "allow" });
              console.log(chalk.green(`    ✓ Allow rule: ${pattern}`));
              permsMigrated++;
            }
          }
        }

        if (claudePerms.deny) {
          for (const pattern of claudePerms.deny) {
            const exists = acSettings.permissionRules.some(
              (r) => r.tool === pattern && r.action === "deny"
            );
            if (!exists) {
              acSettings.permissionRules.push({ tool: pattern, action: "deny" });
              console.log(chalk.green(`    ✓ Deny rule: ${pattern}`));
              permsMigrated++;
            }
          }
        }

        if (permsMigrated > 0) {
          changesMade = true;
          console.log(chalk.cyan(`\n  Permissions: ${permsMigrated} rules migrated\n`));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  Failed to read Claude Code settings: ${msg}\n`));
    }
  } else {
    console.log(chalk.dim("  No ~/.claude/settings.json found\n"));
  }

  // ── Step 3: Migrate Custom Commands → Skills ──────────────
  if (existsSync(CLAUDE_COMMANDS_DIR)) {
    const skillsDir = join(getConfigDir(), "skills");
    await mkdir(skillsDir, { recursive: true });

    try {
      const files = await readdir(CLAUDE_COMMANDS_DIR);
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      let skillsMigrated = 0;

      for (const file of mdFiles) {
        const destPath = join(skillsDir, file);
        if (existsSync(destPath)) {
          console.log(chalk.dim(`    ⊘ ${file} — already exists, skipping`));
          continue;
        }

        const content = await readFile(join(CLAUDE_COMMANDS_DIR, file), "utf-8");

        // Convert Claude Code command format to AshlrCode skill format
        // Claude uses $ARGUMENTS, AshlrCode uses {{args}}
        let converted = content.replace(/\$ARGUMENTS/g, "{{args}}");
        converted = converted.replace(/\$arguments/g, "{{args}}");

        // If the file has no frontmatter, add basic frontmatter
        if (!converted.startsWith("---")) {
          const name = file.replace(".md", "");
          converted = `---\nname: ${name}\ndescription: Migrated from Claude Code\ntrigger: /${name}\n---\n\n${converted}`;
        }

        await writeFile(destPath, converted, "utf-8");
        console.log(chalk.green(`    ✓ ${file} → skills/${file}`));
        skillsMigrated++;
        changesMade = true;
      }

      if (skillsMigrated > 0) {
        console.log(chalk.cyan(`\n  Skills: ${skillsMigrated} commands migrated\n`));
      } else if (mdFiles.length > 0) {
        console.log(chalk.dim(`\n  Skills: All commands already migrated\n`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.dim(`  Could not read Claude Code commands: ${msg}\n`));
    }
  }

  // ── Step 4: Save ──────────────────────────────────────────
  if (changesMade) {
    await saveSettings(acSettings);
    console.log(chalk.green("  ✓ Settings saved to ~/.ashlrcode/settings.json"));
    console.log(chalk.dim("  Restart AshlrCode for changes to take effect.\n"));
  } else {
    console.log(chalk.dim("  No changes needed — config is up to date.\n"));
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(chalk.white("  Next steps:"));
  console.log(chalk.dim("  1. Set your API key: export XAI_API_KEY=your-key"));
  console.log(chalk.dim("  2. Run: ac"));
  console.log(chalk.dim("  3. Your MCP servers and skills will be available automatically\n"));
}
