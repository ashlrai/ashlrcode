/**
 * Git & file commands — /git, /diff, /undo, /restore, /plan.
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";

export function gitCommands(deps: {
  getFileHistory: () => {
    undoCount: number;
    undoLast: () => Promise<{ filePath: string } | null>;
    getHistory: () => Array<{ timestamp: number; tool: string; content: string; filePath: string }>;
  } | null;
}): Command[] {
  return [
    {
      name: "/diff",
      description: "Show git diff",
      category: "files",
      handler: async (_args, ctx) => {
        const proc = Bun.spawn(["git", "diff", "--stat"], {
          cwd: ctx.state.toolContext.cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        ctx.addOutput(output ? `\n${output}\n` : theme.tertiary("\n  No changes.\n"));
        return true;
      },
    },
    {
      name: "/git",
      description: "Git status summary",
      category: "files",
      handler: async (_args, ctx) => {
        const proc = Bun.spawn(["git", "log", "--oneline", "-10"], {
          cwd: ctx.state.toolContext.cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        ctx.addOutput(output ? `\n${output}\n` : theme.tertiary("\n  Not a git repo.\n"));
        return true;
      },
    },
    {
      name: "/undo",
      description: "Undo last file change",
      category: "files",
      handler: async (_args, ctx) => {
        const fh = deps.getFileHistory();
        if (!fh || fh.undoCount === 0) {
          ctx.addOutput(theme.tertiary("\n  Nothing to undo.\n"));
          return true;
        }
        const result = await fh.undoLast();
        if (result) {
          ctx.addOutput(theme.success(`\n  Restored: ${result.filePath}\n`));
          ctx.addOutput(theme.tertiary(`  ${fh.undoCount} more undo(s) available\n`));
        }
        return true;
      },
    },
    {
      name: "/restore",
      description: "Restore file from history",
      category: "files",
      handler: async (_args, ctx) => {
        const fh = deps.getFileHistory();
        if (!fh || fh.undoCount === 0) {
          ctx.addOutput(theme.tertiary("\n  Nothing to restore.\n"));
          return true;
        }
        ctx.addOutput(`\n  ${fh.undoCount} snapshots available. Use /undo to restore.\n`);
        return true;
      },
    },
    {
      name: "/history",
      description: "View file change history",
      category: "files",
      handler: async (_args, ctx) => {
        const fh = deps.getFileHistory();
        if (!fh || fh.undoCount === 0) {
          ctx.addOutput(theme.tertiary("\n  No file history.\n"));
          return true;
        }
        const snaps = fh.getHistory();
        ctx.addOutput(theme.secondary("\n  File History (newest first):\n"));
        for (const snap of snaps.slice(0, 20)) {
          const time = new Date(snap.timestamp).toLocaleTimeString();
          const label = snap.content === "" ? "(new file)" : "(modified)";
          ctx.addOutput(`  ${theme.tertiary(time)} ${snap.tool.padEnd(6)} ${label} ${snap.filePath}\n`);
        }
        if (snaps.length > 20) {
          ctx.addOutput(theme.tertiary(`  ... and ${snaps.length - 20} more\n`));
        }
        ctx.addOutput(theme.tertiary(`\n  ${fh.undoCount} undo(s) available. Use /undo to restore.\n`));
        return true;
      },
    },
    {
      name: "/plan",
      description: "Enter plan mode (read-only exploration)",
      category: "workflow",
      handler: async (_args, ctx) => {
        const { cycleMode } = await import("../ui/mode.ts");
        cycleMode();
        ctx.update();
        return true;
      },
    },
  ];
}
