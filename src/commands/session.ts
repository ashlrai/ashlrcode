/**
 * Session commands — /sync, /btw is in agent.ts since it spawns sub-agents.
 */

import type { Command } from "./types.ts";
import { theme } from "../ui/theme.ts";

export function sessionCommands(): Command[] {
  return [
    {
      name: "/sync",
      description: "Export/import settings",
      category: "session",
      subcommands: ["export", "import"],
      handler: async (args, ctx) => {
        const { join } = await import("path");
        const { exportSettings, getSyncStatus, importSettings } = await import("../config/settings-sync.ts");
        const [sub, ...syncRest] = (args ?? "").split(" ");

        if (sub === "export") {
          const dir = syncRest[0] ?? join(ctx.state.toolContext.cwd, ".ashlrcode-sync");
          const manifest = await exportSettings(dir);
          ctx.addOutput(theme.success(`\n  ✓ Exported ${manifest.files.length} files to ${dir}\n`));
          return true;
        }

        if (sub === "import") {
          const dir = syncRest[0];
          if (!dir) {
            ctx.addOutput(theme.tertiary("\n  Usage: /sync import <path> [--overwrite] [--merge]\n"));
            return true;
          }
          const overwrite = syncRest.includes("--overwrite");
          const merge = syncRest.includes("--merge");
          const result = await importSettings(dir, { overwrite, merge });
          ctx.addOutput(
            theme.success(`\n  ✓ Imported: ${result.imported.length}, Skipped: ${result.skipped.length}\n`),
          );
          if (result.imported.length > 0) ctx.addOutput(theme.secondary(`    ${result.imported.join(", ")}`));
          if (result.skipped.length > 0) ctx.addOutput(theme.tertiary(`    Skipped: ${result.skipped.join(", ")}`));
          ctx.addOutput("");
          return true;
        }

        // Default: show sync status
        const status = await getSyncStatus();
        ctx.addOutput(`\n  Syncable files:\n${status.files.map((f) => `    ${f}`).join("\n")}\n`);
        ctx.addOutput(
          theme.tertiary("  /sync export [path]  — export settings\n  /sync import <path>  — import settings\n"),
        );
        return true;
      },
    },
  ];
}
