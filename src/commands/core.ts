/**
 * Core commands — help, quit, clear, version, status, cost, effort, model,
 * compact, expand, buddy, tools, skills, memory, permissions, keybindings,
 * features, patches, voice, telemetry, search, transcript, undercover,
 * remote, bridge, bug.
 */

import type { Command, CommandContext } from "./types.ts";
import { theme } from "../ui/theme.ts";

export function coreCommands(deps: {
  registry: { formatHelp: () => string };
  saveBuddy: (b: unknown) => Promise<void>;
  speculationCache: { getStats: () => { size: number; hits: number; misses: number } };
  VERSION: string;
}): Command[] {
  return [
    {
      name: "/help",
      aliases: ["/h", "/?"],
      description: "Show all commands",
      category: "other",
      handler: async (_args, ctx) => {
        ctx.addOutput(deps.registry.formatHelp());
        return true;
      },
    },
    {
      name: "/cost",
      description: "Show token usage and costs",
      category: "session",
      handler: async (_args, ctx) => {
        ctx.addOutput("\n" + ctx.state.router.getCostSummary() + "\n");
        return true;
      },
    },
    {
      name: "/stats",
      description: "Tool metrics + speculation cache stats",
      category: "session",
      handler: async (_args, ctx) => {
        const { formatToolMetrics } = await import("../agent/tool-executor.ts");
        const specStats = deps.speculationCache.getStats();
        const specTotal = specStats.hits + specStats.misses;
        const specRate = specTotal > 0 ? Math.round((specStats.hits / specTotal) * 100) : 0;
        ctx.addOutput(
          [
            "",
            formatToolMetrics(),
            "",
            `Speculation Cache: ${specStats.size} entries, ${specStats.hits} hits / ${specStats.misses} misses (${specRate}% hit rate)`,
            "",
          ].join("\n"),
        );
        return true;
      },
    },
    {
      name: "/clear",
      description: "Clear conversation",
      category: "other",
      handler: async (_args, ctx) => {
        ctx.state.history.length = 0;
        ctx.addOutput(theme.secondary("\n  Conversation cleared.\n"));
        return true;
      },
    },
    {
      name: "/quit",
      aliases: ["/exit", "/q"],
      description: "Exit AshlrCode",
      category: "other",
      handler: async (_args, ctx) => {
        ctx.addOutput("\n" + ctx.state.router.getCostSummary());
        deps.saveBuddy(ctx.state.buddy).then(() => process.exit(0));
        return true;
      },
    },
    {
      name: "/bug",
      description: "Report a bug",
      category: "other",
      handler: async (_args, ctx) => {
        ctx.addOutput(theme.accent("\n  Report issues: https://github.com/ashlrai/ashlrcode/issues\n"));
        return true;
      },
    },
    {
      name: "/buddy",
      description: "View/customize companion",
      category: "other",
      handler: async (_args, ctx) => {
        const b = ctx.state.buddy;
        const shinyStr = b.shiny ? " ✨ SHINY" : "";
        ctx.addOutput(`\n  ${b.name} the ${b.species}${shinyStr}`);
        ctx.addOutput(`  Rarity: ${b.rarity.toUpperCase()} · Level ${b.level} · Hat: ${b.hat}`);
        ctx.addOutput(
          `  Stats: 🐛${b.stats.debugging} 🧘${b.stats.patience} 🌀${b.stats.chaos} 🦉${b.stats.wisdom} 😏${b.stats.snark}`,
        );
        ctx.addOutput(`  Sessions: ${b.totalSessions} · Tool calls: ${b.toolCalls}\n`);
        return true;
      },
    },
    {
      name: "/tools",
      description: "List all registered tools",
      category: "tools",
      handler: async (_args, ctx) => {
        const tools = ctx.state.registry.getAll();
        ctx.addOutput(`\n  ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);
        return true;
      },
    },
    {
      name: "/skills",
      description: "List available slash commands",
      category: "tools",
      subcommands: ["install", "update", "remove", "search", "info"],
      handler: async (args, ctx) => {
        const sub = args?.split(" ")[0];
        const subArg = args?.split(" ").slice(1).join(" ").trim();

        if (sub === "install") {
          if (!subArg) {
            ctx.addOutput(theme.tertiary("\n  Usage: /skills install <name-or-url>\n"));
            return true;
          }
          ctx.addOutput(theme.accent(`\n  📦 Installing ${subArg}...\n`));
          try {
            const { installSkill } = await import("../skills/marketplace.ts");
            const result = await installSkill(subArg);
            ctx.addOutput(theme.success(`  ✓ Installed ${result.package.name} v${result.package.version} (${result.skills.length} skills)\n`));
            for (const w of result.warnings) ctx.addOutput(theme.warning(`  ⚠ ${w}`));
            ctx.addOutput(theme.tertiary("  Restart to load new skills.\n"));
          } catch (err: any) {
            ctx.addOutput(theme.error(`  ✗ ${err.message}\n`));
          }
          return true;
        }

        if (sub === "update") {
          const { updateSkill, listInstalled } = await import("../skills/marketplace.ts");
          if (subArg) {
            ctx.addOutput(theme.accent(`\n  📦 Updating ${subArg}...\n`));
            const result = await updateSkill(subArg);
            if (result) {
              ctx.addOutput(theme.success(`  ✓ Updated to v${result.package.version}\n`));
            } else {
              ctx.addOutput(theme.error(`  Package "${subArg}" not installed.\n`));
            }
          } else {
            const installed = await listInstalled();
            if (installed.length === 0) {
              ctx.addOutput(theme.tertiary("\n  No marketplace packages installed.\n"));
              return true;
            }
            ctx.addOutput(theme.accent(`\n  📦 Updating ${installed.length} packages...\n`));
            for (const pkg of installed) {
              const result = await updateSkill(pkg.name);
              ctx.addOutput(result ? theme.success(`  ✓ ${pkg.name}`) : theme.error(`  ✗ ${pkg.name}`));
            }
            ctx.addOutput("");
          }
          return true;
        }

        if (sub === "remove") {
          if (!subArg) {
            ctx.addOutput(theme.tertiary("\n  Usage: /skills remove <name>\n"));
            return true;
          }
          const { removeSkill } = await import("../skills/marketplace.ts");
          const removed = await removeSkill(subArg);
          ctx.addOutput(removed
            ? theme.success(`\n  ✓ Removed ${subArg}\n`)
            : theme.error(`\n  Package "${subArg}" not installed.\n`));
          return true;
        }

        if (sub === "search") {
          if (!subArg) {
            ctx.addOutput(theme.tertiary("\n  Usage: /skills search <query>\n"));
            return true;
          }
          const { searchSkills } = await import("../skills/marketplace.ts");
          const results = await searchSkills(subArg);
          if (results.length === 0) {
            ctx.addOutput(theme.tertiary(`\n  No packages matching "${subArg}"\n`));
          } else {
            ctx.addOutput(theme.accent(`\n  📦 ${results.length} packages matching "${subArg}":\n`));
            for (const r of results) {
              ctx.addOutput(`  ${theme.accent(r.name)} v${r.version} — ${r.description} (${r.skillCount} skills)`);
            }
            ctx.addOutput(theme.tertiary("\n  /skills install <name> to install\n"));
          }
          return true;
        }

        if (sub === "info") {
          if (!subArg) {
            ctx.addOutput(theme.tertiary("\n  Usage: /skills info <name>\n"));
            return true;
          }
          const skill = ctx.state.skillRegistry.getInfo(subArg);
          if (skill) {
            ctx.addOutput(`\n  ${theme.accentBold(skill.name)}`);
            ctx.addOutput(`  Trigger: ${skill.trigger}`);
            ctx.addOutput(`  Description: ${skill.description}`);
            if (skill.version) ctx.addOutput(`  Version: ${skill.version}`);
            if (skill.author) ctx.addOutput(`  Author: ${skill.author}`);
            if (skill.source) ctx.addOutput(`  Source: ${skill.source}`);
            ctx.addOutput(`  Prompt: ${skill.prompt.length} chars\n`);
          } else {
            ctx.addOutput(theme.error(`\n  Skill "${subArg}" not found.\n`));
          }
          return true;
        }

        // Default: list all skills (existing behavior)
        const skills = ctx.state.skillRegistry.getAll();
        if (skills.length === 0) {
          ctx.addOutput(theme.tertiary("\n  No skills loaded.\n"));
          return true;
        }
        ctx.addOutput(theme.accent(`\n  ${skills.length} skills:\n`));
        for (const s of skills) {
          const source = s.source ? theme.muted(` (${s.source})`) : "";
          ctx.addOutput(`  ${theme.accent(s.trigger)} — ${s.description}${source}`);
        }
        ctx.addOutput(theme.tertiary("\n  /skills install <name> | /skills search <query> | /skills info <name>\n"));
        return true;
      },
    },
    {
      name: "/model",
      description: "Switch provider/model",
      category: "tools",
      handler: async (args, ctx) => {
        if (args) {
          const aliases: Record<string, string> = {
            "grok-fast": "grok-4-1-fast-reasoning",
            "grok-4": "grok-4-0314",
            "grok-3": "grok-3-fast",
            sonnet: "claude-sonnet-4-6-20250514",
            opus: "claude-opus-4-6-20250514",
            llama: "llama3.2",
            local: "llama3.2",
          };
          ctx.state.router.currentProvider.config.model = aliases[args] ?? args;
          ctx.addOutput(theme.success(`\n  Model: ${ctx.state.router.currentProvider.config.model}\n`));
        } else {
          ctx.addOutput(
            `\n  ${ctx.state.router.currentProvider.name}:${ctx.state.router.currentProvider.config.model}\n`,
          );
        }
        return true;
      },
    },
    {
      name: "/effort",
      description: "Set model effort level",
      category: "tools",
      handler: async (args, ctx) => {
        const { cycleEffort, getEffort, getEffortConfig, getEffortEmoji, setEffort } = await import(
          "../ui/effort.ts"
        );
        const effortAliases: Record<string, string> = {
          fast: "low",
          low: "low",
          normal: "normal",
          balanced: "normal",
          high: "high",
          thorough: "high",
        };
        if (args && effortAliases[args]) {
          setEffort(effortAliases[args] as any);
        } else {
          cycleEffort();
        }
        const effortCfg = getEffortConfig();
        ctx.state.router.currentProvider.config.maxTokens = effortCfg.maxTokens;
        ctx.state.router.currentProvider.config.temperature = effortCfg.temperature;
        const tempInfo = effortCfg.temperature !== undefined ? `, temp ${effortCfg.temperature}` : "";
        ctx.addOutput(
          theme.success(`\n  ${getEffortEmoji()} Effort: ${getEffort()} (${effortCfg.maxTokens} tokens${tempInfo})\n`),
        );
        return true;
      },
    },
    {
      name: "/status",
      description: "Current session info",
      category: "session",
      handler: async (_args, ctx) => {
        const { estimateTokens, getProviderContextLimit } = await import("../agent/context.ts");
        const ctxLimit = getProviderContextLimit(ctx.state.router.currentProvider.name);
        const ctxUsed = estimateTokens(ctx.state.history);
        ctx.addOutput(
          `\n  Provider: ${ctx.state.router.currentProvider.name}:${ctx.state.router.currentProvider.config.model}`,
        );
        ctx.addOutput(`  Context: ${ctxUsed}/${ctxLimit} tokens (${Math.round((ctxUsed / ctxLimit) * 100)}%)`);
        ctx.addOutput(`  Session: ${ctx.state.session.id}`);
        ctx.addOutput(`  History: ${ctx.state.history.length} messages\n`);
        return true;
      },
    },
    {
      name: "/memory",
      description: "View saved project memories",
      category: "session",
      handler: async (_args, ctx) => {
        const { loadMemories } = await import("../persistence/memory.ts");
        const memories = await loadMemories(ctx.state.toolContext.cwd);
        if (memories.length === 0) {
          ctx.addOutput(theme.tertiary("\n  No memory files.\n"));
          return true;
        }
        for (const m of memories) {
          ctx.addOutput(`  [${m.type}] ${m.name} — ${m.description ?? m.filePath}`);
        }
        ctx.addOutput("");
        return true;
      },
    },
    {
      name: "/sessions",
      description: "List past sessions",
      category: "session",
      handler: async (_args, ctx) => {
        const { listSessions } = await import("../persistence/session.ts");
        const sessions = await listSessions(10);
        if (sessions.length === 0) {
          ctx.addOutput(theme.tertiary("\n  No sessions found.\n"));
          return true;
        }
        ctx.addOutput("");
        for (const s of sessions) {
          const ago = ctx.formatTimeAgo(new Date(s.updatedAt));
          const modelShort = s.model?.split("-").slice(0, 2).join("-") ?? "?";
          const isCurrent = s.id === ctx.state.session.id;
          const marker = isCurrent ? theme.success("●") : theme.muted("○");
          const title = s.title ?? "(untitled)";
          ctx.addOutput(
            `  ${marker} ${theme.accent(s.id.slice(0, 8))} ${title.slice(0, 30).padEnd(30)} ${theme.muted(modelShort.padEnd(12))} ${s.messageCount} msgs  ${theme.muted(ago)}`,
          );
        }
        ctx.addOutput(theme.muted("\n  Resume with: ac --resume <id>\n"));
        return true;
      },
    },
    {
      name: "/compact",
      description: "Force context compression",
      category: "session",
      handler: async (_args, ctx) => {
        const { autoCompact, contextCollapse, snipCompact } = await import("../agent/context.ts");
        ctx.addOutput(theme.tertiary("  [compacting context...]"));
        ctx.state.history = contextCollapse(ctx.state.history);
        ctx.state.history = snipCompact(ctx.state.history);
        ctx.state.history = await autoCompact(ctx.state.history, ctx.state.router);
        await ctx.state.session.insertCompactBoundary(ctx.buildCompactSummary(), ctx.state.history.length).catch(() => {});
        ctx.addOutput(theme.success(`\n  ✓ Compacted to ${ctx.state.history.length} messages\n`));
        return true;
      },
    },
    {
      name: "/expand",
      description: "View full untruncated last tool output",
      category: "session",
      handler: async (_args, ctx) => {
        const output = ctx.getLastFullToolOutput();
        if (output) {
          ctx.addOutput("\n" + output + "\n");
        } else {
          ctx.addOutput(
            theme.tertiary(
              "\n  No truncated output to expand. The last tool result will be stored after truncation.\n",
            ),
          );
        }
        return true;
      },
    },
    {
      name: "/permissions",
      description: "View allowed/denied tool permissions",
      category: "tools",
      handler: async (_args, ctx) => {
        const { getPermissionState } = await import("../config/permissions.ts");
        const perms = getPermissionState();
        ctx.addOutput("");
        ctx.addOutput(theme.accentBold("  Permission State"));
        if (perms.alwaysAllow.size > 0) {
          ctx.addOutput(theme.success("  Always Allow:"));
          for (const t of perms.alwaysAllow) ctx.addOutput(`    ✓ ${t}`);
        }
        if (perms.alwaysDeny.size > 0) {
          ctx.addOutput(theme.error("  Always Deny:"));
          for (const t of perms.alwaysDeny) ctx.addOutput(`    ✗ ${t}`);
        }
        if (perms.sessionAllow.size > 0) {
          ctx.addOutput(theme.tertiary("  Session Allow (not persisted):"));
          for (const t of perms.sessionAllow) ctx.addOutput(`    ~ ${t}`);
        }
        if (perms.alwaysAllow.size === 0 && perms.alwaysDeny.size === 0 && perms.sessionAllow.size === 0) {
          ctx.addOutput(theme.tertiary("  No permission decisions recorded yet."));
        }
        ctx.addOutput(theme.muted("\n  Reset with: edit ~/.ashlrcode/permissions.json\n"));
        return true;
      },
    },
    {
      name: "/keybindings",
      description: "View/edit keyboard shortcuts",
      category: "tools",
      handler: async (_args, ctx) => {
        const { getBindings } = await import("../ui/keybindings.ts");
        const binds = getBindings();
        const kbLines = binds.map((b) => `  ${b.key.padEnd(18)} ${b.action.padEnd(16)} ${b.description ?? ""}`);
        ctx.addOutput(`\n  Keybindings:\n${kbLines.join("\n")}\n`);
        ctx.addOutput(theme.tertiary("  Customize: ~/.ashlrcode/keybindings.json\n"));
        return true;
      },
    },
    {
      name: "/features",
      description: "Toggle feature flags",
      category: "tools",
      handler: async (_args, ctx) => {
        const { listFeatures } = await import("../config/features.ts");
        const flags = listFeatures();
        const lines = Object.entries(flags).map(([k, v]) => `  ${v ? theme.success("✓") : theme.error("✗")} ${k}`);
        ctx.addOutput(`\n  Feature Flags:\n${lines.join("\n")}\n`);
        return true;
      },
    },
    {
      name: "/patches",
      description: "View active model patches",
      category: "tools",
      handler: async (_args, ctx) => {
        const { listPatches, getModelPatches } = await import("../agent/model-patches.ts");
        const currentModel = ctx.state.router.currentProvider.config.model;
        const { names } = getModelPatches(currentModel);
        const allPatches = listPatches();
        const patchLines = allPatches.map((p) => {
          const active = names.includes(p.name);
          return `  ${active ? theme.success("●") : theme.tertiary("○")} ${p.name} ${theme.tertiary(`(${p.pattern})`)}`;
        });
        ctx.addOutput(`\n  Model Patches (${currentModel}):\n${patchLines.join("\n")}\n`);
        return true;
      },
    },
    {
      name: "/undercover",
      description: "Toggle undercover mode",
      category: "other",
      handler: async (_args, ctx) => {
        const { isUndercoverMode, setUndercoverMode } = await import("../config/undercover.ts");
        setUndercoverMode(!isUndercoverMode());
        ctx.addOutput(
          isUndercoverMode()
            ? theme.warning("\n  🕶 Undercover mode ON\n")
            : theme.success("\n  Undercover mode OFF\n"),
        );
        return true;
      },
    },
    {
      name: "/remote",
      description: "Show remote settings",
      category: "tools",
      handler: async (_args, ctx) => {
        const { getRemoteSettings } = await import("../config/remote-settings.ts");
        const rs = getRemoteSettings();
        if (!rs) {
          ctx.addOutput(
            theme.tertiary(
              "\n  No remote settings configured.\n  Set AC_REMOTE_SETTINGS_URL env var or remoteSettingsUrl in settings.json.\n",
            ),
          );
          return true;
        }
        ctx.addOutput(`\n  Remote Settings (fetched ${new Date(rs.fetchedAt).toLocaleString()}):`);
        if (rs.features) ctx.addOutput(`  Features: ${JSON.stringify(rs.features)}`);
        if (rs.modelOverride) ctx.addOutput(`  Model override: ${rs.modelOverride}`);
        if (rs.effortOverride) ctx.addOutput(`  Effort override: ${rs.effortOverride}`);
        if (rs.killswitches) ctx.addOutput(`  Killswitches: ${JSON.stringify(rs.killswitches)}`);
        if (rs.message) ctx.addOutput(theme.warning(`  Message: ${rs.message}`));
        ctx.addOutput("");
        return true;
      },
    },
    {
      name: "/telemetry",
      description: "Show recent telemetry events",
      category: "session",
      handler: async (_args, ctx) => {
        const { readRecentEvents, formatEvents } = await import("../telemetry/event-log.ts");
        const events = await readRecentEvents(20);
        ctx.addOutput(`\n  Recent events (${events.length}):\n${formatEvents(events)}\n`);
        return true;
      },
    },
    {
      name: "/bridge",
      description: "Show bridge server status",
      category: "tools",
      handler: async (_args, ctx) => {
        const { getBridgePort } = await import("../bridge/bridge-server.ts");
        const port = getBridgePort();
        if (port) {
          ctx.addOutput(`\n  Bridge active on http://localhost:${port}\n`);
        } else {
          ctx.addOutput(theme.tertiary("\n  Bridge not running. Set AC_BRIDGE_PORT=8743 to enable.\n"));
        }
        return true;
      },
    },
    {
      name: "/version",
      description: "Show version",
      category: "other",
      handler: async (_args, ctx) => {
        ctx.addOutput(`\n  AshlrCode v${deps.VERSION}\n`);
        return true;
      },
    },
    {
      name: "/voice",
      description: "Voice input mode",
      category: "other",
      handler: async (_args, ctx) => {
        const { feature } = await import("../config/features.ts");
        if (!feature("VOICE_MODE")) {
          ctx.addOutput(theme.tertiary("\n  Voice mode disabled. Set AC_FEATURE_VOICE_MODE=true\n"));
          return true;
        }
        const { checkVoiceAvailability, isRecording, startRecording, transcribeRecording } = await import(
          "../voice/voice-mode.ts"
        );
        const check = await checkVoiceAvailability();
        if (!check.available) {
          ctx.addOutput(theme.error(`\n  ${check.details}\n`));
          return true;
        }
        if (isRecording()) {
          ctx.addOutput(theme.accent("  Transcribing...\n"));
          const voiceConfig = {
            sttProvider: (process.env.OPENAI_API_KEY ? "whisper-api" : "whisper-local") as "whisper-api" | "whisper-local",
            whisperApiKey: process.env.OPENAI_API_KEY,
          };
          try {
            const text = await transcribeRecording(voiceConfig);
            if (text) {
              ctx.addOutput(theme.success(`  Voice: "${text}"\n`));
              await ctx.runTurnInk(text);
            } else {
              ctx.addOutput(theme.error("  Failed to transcribe\n"));
            }
          } catch (e: any) {
            ctx.addOutput(theme.error(`  Transcription error: ${e.message}\n`));
          }
        } else {
          await startRecording();
          ctx.addOutput(theme.accent("  Recording... /voice again to stop and transcribe\n"));
        }
        return true;
      },
    },
    {
      name: "/search",
      description: "Search output history for a pattern",
      category: "session",
      handler: async (args, ctx) => {
        if (!args) {
          ctx.addOutput(theme.tertiary("\n  Usage: /search <pattern>\n  Searches output history for matching lines.\n"));
          return true;
        }
        let regex: RegExp;
        try {
          regex = new RegExp(args, "i");
        } catch {
          ctx.addOutput(theme.error(`\n  Invalid regex: ${args}\n`));
          return true;
        }
        const items = ctx.getItems();
        const allLines: string[] = [];
        for (const item of items) {
          const plain = ctx.stripAnsi(item.text);
          for (const line of plain.split("\n")) {
            allLines.push(line);
          }
        }
        const matches: Array<{ lineNum: number; lines: string[] }> = [];
        const CONTEXT = 2;
        const seen = new Set<number>();
        for (let i = 0; i < allLines.length; i++) {
          if (regex.test(allLines[i] ?? "")) {
            const start = Math.max(0, i - CONTEXT);
            const end = Math.min(allLines.length - 1, i + CONTEXT);
            const contextLines: string[] = [];
            for (let j = start; j <= end; j++) {
              if (!seen.has(j)) {
                seen.add(j);
                const prefix = j === i ? theme.accent("  > ") : "    ";
                contextLines.push(prefix + allLines[j]);
              }
            }
            if (contextLines.length > 0) {
              matches.push({ lineNum: i + 1, lines: contextLines });
            }
          }
        }
        if (matches.length === 0) {
          ctx.addOutput(theme.tertiary(`\n  No matches for: ${args}\n`));
        } else {
          ctx.addOutput(
            "\n" + theme.accentBold(`  Search results for "${args}" (${matches.length} matches):`) + "\n",
          );
          for (const m of matches.slice(0, 50)) {
            ctx.addOutput(theme.muted(`  --- line ${m.lineNum} ---`));
            for (const l of m.lines) {
              ctx.addOutput(l);
            }
          }
          if (matches.length > 50) {
            ctx.addOutput(theme.muted(`  ... and ${matches.length - 50} more matches`));
          }
          ctx.addOutput("");
        }
        return true;
      },
    },
    {
      name: "/transcript",
      description: "Save session output to file",
      category: "session",
      subcommands: ["last"],
      handler: async (args, ctx) => {
        const { existsSync, mkdirSync, writeFileSync } = await import("fs");
        const { join } = await import("path");
        const { getConfigDir } = await import("../config/settings.ts");
        const items = ctx.getItems();

        if (args === "last") {
          const lastItems = items.slice(-50);
          if (lastItems.length === 0) {
            ctx.addOutput(theme.tertiary("\n  No output to show.\n"));
          } else {
            ctx.addOutput("\n" + theme.accentBold("  Last 50 output lines:") + "\n");
            for (const item of lastItems) {
              ctx.addOutput(ctx.stripAnsi(item.text));
            }
          }
          return true;
        }
        const transcriptDir = join(getConfigDir(), "transcripts");
        mkdirSync(transcriptDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const fname = `${ctx.state.session.id}-${ts}.txt`;
        const fpath = join(transcriptDir, fname);
        const lines = items.map((i) => ctx.stripAnsi(i.text));
        writeFileSync(fpath, lines.join("\n"), "utf-8");
        ctx.addOutput(theme.success(`\n  Transcript saved to ${fpath} (${lines.length} lines)\n`));
        return true;
      },
    },
  ];
}
