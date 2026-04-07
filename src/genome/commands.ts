/**
 * Genome commands — /genome subcommands for managing the genetic development loop.
 */

import type { Command, CommandContext } from "../commands/types.ts";
import { theme } from "../ui/theme.ts";

export function genomeCommands(): Command[] {
  return [
    {
      name: "/genome",
      description: "Manage the genetic AI development loop",
      category: "agent",
      subcommands: ["init", "status", "sections", "read", "evolve", "propose", "history", "diff", "embeddings", "strategies"],
      handler: async (args, ctx) => {
        const [sub, ...rest] = (args ?? "").split(" ");
        const subArgs = rest.join(" ").trim();

        switch (sub) {
          case "init":
            return handleInit(subArgs, ctx);
          case "status":
            return handleStatus(ctx);
          case "sections":
            return handleSections(ctx);
          case "read":
            return handleRead(subArgs, ctx);
          case "evolve":
            return handleEvolve(ctx);
          case "propose":
            return handlePropose(subArgs, ctx);
          case "history":
            return handleHistory(ctx);
          case "diff":
            return handleDiff(subArgs, ctx);
          case "embeddings":
            return handleEmbeddings(subArgs, ctx);
          case "strategies":
            return handleStrategies(subArgs, ctx);
          default:
            ctx.addOutput(formatHelp());
            return true;
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleInit(args: string, ctx: CommandContext): Promise<boolean> {
  const { genomeExists } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;

  if (genomeExists(cwd)) {
    ctx.addOutput(theme.warning("\n  Genome already exists. Use /genome status to view it.\n"));
    return true;
  }

  if (args === "--from-claude-md") {
    const { initGenomeFromClaudeMd } = await import("./init.ts");
    try {
      const result = await initGenomeFromClaudeMd(cwd, getProjectName(cwd));
      ctx.addOutput(
        theme.success(`\n  Genome initialized from CLAUDE.md (${result.sectionsCreated} sections created)\n`),
      );
      ctx.addOutput(theme.tertiary("  Run /genome status to see the genome overview.\n"));
    } catch (e: any) {
      ctx.addOutput(theme.error(`\n  ${e.message}\n`));
    }
    return true;
  }

  // Interactive init: use LLM to gather vision from user
  if (!args) {
    ctx.addOutput(
      [
        "",
        theme.accentBold("  Genome — Genetic AI Development Loop"),
        "",
        `  ${theme.accent("Usage:")}`,
        "    /genome init <vision>           Initialize with a vision statement",
        "    /genome init --from-claude-md   Migrate from existing CLAUDE.md",
        "",
        `  ${theme.accent("Example:")}`,
        "    /genome init Build a production-ready API gateway with auth, rate limiting, and monitoring",
        "",
      ].join("\n"),
    );
    return true;
  }

  // Init with provided vision
  const { initGenome } = await import("./init.ts");
  try {
    const result = await initGenome(cwd, {
      project: getProjectName(cwd),
      vision: args,
      milestone: "Initial setup and foundation",
    });
    ctx.addOutput(theme.success(`\n  Genome initialized (${result.sectionsCreated} sections created)`));
    ctx.addOutput(theme.tertiary("  Generation 1 started. Vision: " + args.slice(0, 80)));
    ctx.addOutput(theme.tertiary("  Run /genome status for overview, /genome sections to see all sections.\n"));
  } catch (e: any) {
    ctx.addOutput(theme.error(`\n  ${e.message}\n`));
  }
  return true;
}

async function handleStatus(ctx: CommandContext): Promise<boolean> {
  const { loadManifest, totalGenomeTokens } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;
  const manifest = await loadManifest(cwd);

  if (!manifest) {
    ctx.addOutput(theme.tertiary("\n  No genome found. Run /genome init to create one.\n"));
    return true;
  }

  const tokens = totalGenomeTokens(manifest);
  const gen = manifest.generation;

  const lines = [
    "",
    theme.accentBold(`  Genome: ${manifest.project}`),
    "",
    `  ${theme.accent("Generation:")}  ${gen.number}`,
    `  ${theme.accent("Milestone:")}   ${gen.milestone || "(none)"}`,
    `  ${theme.accent("Started:")}     ${gen.startedAt.split("T")[0]}`,
    `  ${theme.accent("Sections:")}    ${manifest.sections.length}`,
    `  ${theme.accent("Tokens:")}      ${tokens.toLocaleString()} (~${((tokens * 4) / 1024).toFixed(0)}KB)`,
  ];

  if (manifest.fitnessHistory.length > 0) {
    const latest = manifest.fitnessHistory[manifest.fitnessHistory.length - 1]!;
    lines.push("");
    lines.push(`  ${theme.accent("Latest Fitness (Gen " + latest.generation + "):")}`);
    for (const [key, value] of Object.entries(latest.scores)) {
      const score = value as number;
      const label = key.replace(/([A-Z])/g, " $1").trim();
      const filled = Math.round(score * 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);
      lines.push(`    ${label.padEnd(22)} ${bar} ${(score * 100).toFixed(0)}%`);
    }
  }

  lines.push("");
  ctx.addOutput(lines.join("\n"));
  return true;
}

async function handleSections(ctx: CommandContext): Promise<boolean> {
  const { loadManifest } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;
  const manifest = await loadManifest(cwd);

  if (!manifest) {
    ctx.addOutput(theme.tertiary("\n  No genome found.\n"));
    return true;
  }

  const lines = ["", theme.accentBold("  Genome Sections"), ""];

  // Group by directory
  const groups = new Map<string, typeof manifest.sections>();
  for (const s of manifest.sections) {
    const dir = s.path.split("/")[0] ?? "other";
    const group = groups.get(dir) ?? [];
    group.push(s);
    groups.set(dir, group);
  }

  for (const [dir, sections] of groups) {
    lines.push(`  ${theme.accent(dir + "/")}`);
    for (const s of sections) {
      const name = s.path.split("/").slice(1).join("/");
      const tokens = `${s.tokens}t`;
      const dots = ".".repeat(Math.max(1, 35 - name.length - tokens.length));
      lines.push(`    ${name} ${theme.muted(dots)} ${theme.tertiary(tokens)}  ${theme.muted(s.summary.slice(0, 50))}`);
    }
    lines.push("");
  }

  ctx.addOutput(lines.join("\n"));
  return true;
}

async function handleRead(sectionPath: string, ctx: CommandContext): Promise<boolean> {
  if (!sectionPath) {
    ctx.addOutput(
      theme.tertiary("\n  Usage: /genome read <section-path>\n  Example: /genome read vision/north-star.md\n"),
    );
    return true;
  }

  const { readSection } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;

  // Add .md extension if missing
  const path = sectionPath.endsWith(".md") ? sectionPath : sectionPath + ".md";
  const content = await readSection(cwd, path);

  if (!content) {
    ctx.addOutput(theme.error(`\n  Section not found: ${path}\n`));
    ctx.addOutput(theme.tertiary("  Run /genome sections to see available sections.\n"));
    return true;
  }

  ctx.addOutput(`\n${theme.accent("  " + path)}\n\n${content}\n`);
  return true;
}

async function handleEvolve(ctx: CommandContext): Promise<boolean> {
  const { genomeExists } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;

  if (!genomeExists(cwd)) {
    ctx.addOutput(theme.tertiary("\n  No genome found.\n"));
    return true;
  }

  ctx.addOutput(theme.accent("\n  Evaluating generation...\n"));

  const { evaluateGeneration, formatGenerationReport } = await import("./generations.ts");
  const report = await evaluateGeneration(cwd, ctx.state.router);

  ctx.addOutput("\n" + formatGenerationReport(report) + "\n");
  return true;
}

async function handlePropose(args: string, ctx: CommandContext): Promise<boolean> {
  if (!args) {
    ctx.addOutput(
      theme.tertiary(
        "\n  Usage: /genome propose <section> <change-description>\n  Example: /genome propose knowledge/discoveries.md Found that auth uses JWT not sessions\n",
      ),
    );
    return true;
  }

  const parts = args.split(" ");
  const section = parts[0]!;
  const change = parts.slice(1).join(" ");

  if (!change) {
    ctx.addOutput(theme.error("\n  Provide a change description after the section path.\n"));
    return true;
  }

  const { loadManifest } = await import("./manifest.ts");
  const { proposeUpdate } = await import("./scribe.ts");
  const cwd = ctx.state.toolContext.cwd;
  const manifest = await loadManifest(cwd);

  if (!manifest) {
    ctx.addOutput(theme.tertiary("\n  No genome found.\n"));
    return true;
  }

  const path = section.endsWith(".md") ? section : section + ".md";
  const id = await proposeUpdate(cwd, {
    agentId: "user",
    section: path,
    operation: "append",
    content: change,
    rationale: "Manual proposal via /genome propose",
    generation: manifest.generation.number,
  });

  ctx.addOutput(theme.success(`\n  Proposal queued: ${id}`));
  ctx.addOutput(theme.tertiary("  Run /genome evolve to consolidate proposals.\n"));
  return true;
}

async function handleHistory(ctx: CommandContext): Promise<boolean> {
  const { loadManifest } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;
  const manifest = await loadManifest(cwd);

  if (!manifest) {
    ctx.addOutput(theme.tertiary("\n  No genome found.\n"));
    return true;
  }

  if (manifest.fitnessHistory.length === 0) {
    ctx.addOutput(theme.tertiary("\n  No generation history yet. Run /genome evolve to evaluate.\n"));
    return true;
  }

  const lines = ["", theme.accentBold("  Generation History"), ""];

  for (const entry of manifest.fitnessHistory) {
    const scores = Object.entries(entry.scores)
      .map(([k, v]) => `${k}: ${((v as number) * 100).toFixed(0)}%`)
      .join(", ");
    lines.push(`  Gen ${String(entry.generation).padStart(3)} — ${scores}`);
  }

  lines.push("");
  ctx.addOutput(lines.join("\n"));
  return true;
}

async function handleDiff(args: string, ctx: CommandContext): Promise<boolean> {
  const { loadMutations } = await import("./scribe.ts");
  const cwd = ctx.state.toolContext.cwd;

  const parts = args.split(" ").filter(Boolean);
  const gen = parts[0] ? parseInt(parts[0], 10) : undefined;

  const mutations = await loadMutations(cwd);
  const filtered = gen ? mutations.filter((m) => m.generation === gen) : mutations.slice(-20);

  if (filtered.length === 0) {
    ctx.addOutput(theme.tertiary(`\n  No mutations found${gen ? ` for generation ${gen}` : ""}.\n`));
    return true;
  }

  const lines = ["", theme.accentBold(`  Mutations${gen ? ` (Gen ${gen})` : " (Recent 20)"}`), ""];

  for (const m of filtered) {
    lines.push(`  ${theme.accent(m.id)} — Gen ${m.generation}`);
    lines.push(`    ${m.operation} ${m.section} by ${m.agentId}`);
    lines.push(`    ${theme.muted(m.rationale.slice(0, 80))}`);
    lines.push("");
  }

  ctx.addOutput(lines.join("\n"));
  return true;
}

async function handleEmbeddings(args: string, ctx: CommandContext): Promise<boolean> {
  const { genomeExists } = await import("./manifest.ts");
  const cwd = ctx.state.toolContext.cwd;

  if (!genomeExists(cwd)) {
    ctx.addOutput(theme.tertiary("\n  No genome found. Run /genome init first.\n"));
    return true;
  }

  const { isOllamaAvailable, updateEmbeddings, loadEmbeddingCache } = await import("./embeddings.ts");

  if (args === "status") {
    const available = await isOllamaAvailable();
    const cache = await loadEmbeddingCache(cwd);
    const lines = [
      "",
      theme.accentBold("  Embedding Status"),
      "",
      `  ${theme.accent("Ollama:")}      ${available ? theme.success("available") : theme.error("not available")}`,
      `  ${theme.accent("Cached:")}      ${cache.length} section${cache.length !== 1 ? "s" : ""}`,
    ];
    if (cache.length > 0) {
      const oldest = cache.reduce((min, c) => (c.updatedAt < min ? c.updatedAt : min), cache[0]!.updatedAt);
      const newest = cache.reduce((max, c) => (c.updatedAt > max ? c.updatedAt : max), cache[0]!.updatedAt);
      lines.push(`  ${theme.accent("Oldest:")}      ${oldest.split("T")[0]}`);
      lines.push(`  ${theme.accent("Newest:")}      ${newest.split("T")[0]}`);
    }
    lines.push("");
    ctx.addOutput(lines.join("\n"));
    return true;
  }

  // Default: update embeddings
  const available = await isOllamaAvailable();
  if (!available) {
    ctx.addOutput(
      theme.error("\n  Ollama is not available. Start Ollama to generate embeddings.") +
        "\n" +
        theme.tertiary("  Install: https://ollama.ai — then run: ollama pull nomic-embed-text\n"),
    );
    return true;
  }

  const model = args || undefined;
  ctx.addOutput(theme.accent(`\n  Generating embeddings${model ? ` with model ${model}` : ""}...\n`));

  const result = await updateEmbeddings(cwd, model);

  const lines = [
    theme.success(`  Embeddings updated`),
    `    ${theme.accent("Updated:")}  ${result.updated}`,
    `    ${theme.accent("Skipped:")}  ${result.skipped} (already cached)`,
  ];
  if (result.failed > 0) {
    lines.push(`    ${theme.warning("Failed:")}   ${result.failed}`);
  }
  lines.push("");
  ctx.addOutput(lines.join("\n"));
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleStrategies(args: string, ctx: CommandContext): Promise<boolean> {
  const cwd = ctx.state.toolContext.cwd;

  if (args === "leaderboard" || !args) {
    const { getStrategyLeaderboard, formatLeaderboard } = await import("./strategies.ts");
    const leaderboard = await getStrategyLeaderboard(cwd);
    if (leaderboard.length === 0) {
      ctx.addOutput(theme.tertiary("\n  No strategy data yet. Strategies are recorded as agents work.\n"));
      return true;
    }
    ctx.addOutput("\n" + formatLeaderboard(leaderboard) + "\n");
    return true;
  }

  if (args.startsWith("agent ")) {
    const agentId = args.replace("agent ", "").trim();
    if (!agentId) {
      ctx.addOutput(theme.tertiary("\n  Usage: /genome strategies agent <agent-id>\n"));
      return true;
    }
    const { getAgentProfile } = await import("./strategies.ts");
    const profile = await getAgentProfile(cwd, agentId);
    const lines = [
      "",
      theme.accentBold(`  Agent: ${agentId}`),
      `  Total strategies: ${profile.totalStrategies}`,
      `  Success rate: ${(profile.successRate * 100).toFixed(0)}%`,
      "",
    ];
    if (profile.topStrategies.length > 0) {
      lines.push("  Top strategies:");
      for (const s of profile.topStrategies) {
        lines.push(`    ${s.name} — ${s.uses}x used, ${(s.successRate * 100).toFixed(0)}% success`);
      }
    }
    lines.push("");
    ctx.addOutput(lines.join("\n"));
    return true;
  }

  if (args.startsWith("suggest ")) {
    const category = args.replace("suggest ", "").trim();
    const { suggestStrategy } = await import("./strategies.ts");
    const suggestion = await suggestStrategy(cwd, category as any);
    if (!suggestion) {
      ctx.addOutput(theme.tertiary(`\n  No strategy suggestions for "${category}" (need 2+ recorded uses).\n`));
    } else {
      ctx.addOutput(theme.success(`\n  Suggested: ${suggestion.name} (${(suggestion.successRate * 100).toFixed(0)}% success, ${suggestion.uses}x used)\n`));
    }
    return true;
  }

  ctx.addOutput([
    "",
    theme.accentBold("  Strategy Tracking"),
    "",
    `  ${theme.accent("/genome strategies")}             Show leaderboard`,
    `  ${theme.accent("/genome strategies agent <id>")}  Agent profile`,
    `  ${theme.accent("/genome strategies suggest <cat>")} Suggest best strategy`,
    "",
    theme.muted("  Categories: testing, implementation, refactoring, debugging, architecture, other"),
    "",
  ].join("\n"));
  return true;
}

function getProjectName(cwd: string): string {
  const parts = cwd.split("/");
  return parts[parts.length - 1] ?? "project";
}

function formatHelp(): string {
  return [
    "",
    theme.accentBold("  Genome — Genetic AI Development Loop"),
    "",
    `  ${theme.accent("/genome init <vision>")}      Initialize genome with vision`,
    `  ${theme.accent("/genome init --from-claude-md")}  Migrate from CLAUDE.md`,
    `  ${theme.accent("/genome status")}              Current generation & fitness`,
    `  ${theme.accent("/genome sections")}            List all genome sections`,
    `  ${theme.accent("/genome read <section>")}      Display a section`,
    `  ${theme.accent("/genome evolve")}              Evaluate & evolve generation`,
    `  ${theme.accent("/genome propose <s> <text>")}  Propose a genome update`,
    `  ${theme.accent("/genome history")}             Generation fitness trends`,
    `  ${theme.accent("/genome diff [gen]")}          Show mutations`,
    `  ${theme.accent("/genome strategies")}           Strategy leaderboard`,
    `  ${theme.accent("/genome strategies agent <id>")} Agent strategy profile`,
    `  ${theme.accent("/genome embeddings")}          Update Ollama embeddings`,
    `  ${theme.accent("/genome embeddings status")}   Show embedding cache status`,
    "",
    theme.muted("  The genome is a living specification that agents read and evolve."),
    theme.muted("  It replaces static CLAUDE.md with a two-layer system:"),
    theme.muted("    CLAUDE.md (bootstrap) → .ashlrcode/genome/ (full vision)"),
    "",
  ].join("\n");
}
