/**
 * Command registry — centralized lookup and dispatch for slash commands.
 *
 * Replaces the 1600-line switch statement in repl.tsx with a clean
 * register → lookup → dispatch pattern.
 */

import type { Command, CommandCategory, CommandContext } from "./types.ts";
import { theme } from "../ui/theme.ts";

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.commands.set(alias, command);
    }
  }

  registerAll(commands: Command[]): void {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  /** Try to dispatch a slash command. Returns true if handled. */
  async dispatch(input: string, ctx: CommandContext): Promise<boolean> {
    const [cmd, ...rest] = input.split(" ");
    if (!cmd) return false;

    const command = this.commands.get(cmd);
    if (!command) {
      if (cmd.startsWith("/")) {
        ctx.addOutput(theme.tertiary(`\n  Unknown command: ${cmd}\n`));
        return true;
      }
      return false;
    }

    const args = rest.join(" ").trim();
    return command.handler(args, ctx);
  }

  /** Generate autocomplete list for the input component. */
  getAutocompleteList(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const [trigger, cmd] of this.commands) {
      // Skip aliases to avoid duplicates — only include primary name + aliases explicitly
      if (seen.has(cmd.name)) {
        // Still include alias triggers for autocomplete
        if (!seen.has(trigger)) {
          seen.add(trigger);
          result.push(trigger);
        }
        continue;
      }
      seen.add(cmd.name);
      seen.add(trigger);
      result.push(cmd.name);

      // Add sub-command completions
      for (const sub of cmd.subcommands ?? []) {
        const full = `${cmd.name} ${sub}`;
        if (!seen.has(full)) {
          seen.add(full);
          result.push(full);
        }
      }
    }

    return result.sort();
  }

  /** Get all unique commands grouped by category. */
  getByCategory(): Map<CommandCategory, Command[]> {
    const groups = new Map<CommandCategory, Command[]>();
    const seen = new Set<string>();

    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);

      const list = groups.get(cmd.category) ?? [];
      list.push(cmd);
      groups.set(cmd.category, list);
    }

    return groups;
  }

  /** Generate formatted help text. */
  formatHelp(): string {
    const categoryLabels: Record<CommandCategory, string> = {
      agent: "Agent Intelligence",
      workflow: "Workflow",
      session: "Session",
      tools: "Tools & Config",
      files: "Files & Git",
      other: "Other",
    };
    const categoryOrder: CommandCategory[] = ["agent", "workflow", "session", "tools", "files", "other"];
    const groups = this.getByCategory();

    const lines: string[] = [""];
    for (const cat of categoryOrder) {
      const cmds = groups.get(cat);
      if (!cmds || cmds.length === 0) continue;

      lines.push(theme.accentBold(`  ${categoryLabels[cat]}`));
      for (const cmd of cmds) {
        const name = cmd.name.padEnd(22);
        const dots = ".".repeat(Math.max(1, 22 - cmd.name.length));
        lines.push(`    ${cmd.name} ${theme.muted(dots)} ${cmd.description}`);
      }
      lines.push("");
    }

    lines.push(theme.muted("  Tip: Type any slash command name for more info. Custom skills: ~/.ashlrcode/skills/"));
    lines.push("");
    return lines.join("\n");
  }
}
