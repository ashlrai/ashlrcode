/**
 * Genome initialization — creates the full genome directory structure
 * with initial section files and manifest.
 */

import { existsSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { createEmptyManifest, genomeDir, genomeExists, saveManifest, writeSection } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenomeInitOptions {
  /** Project name */
  project: string;
  /** North-star vision statement */
  vision: string;
  /** First milestone description */
  milestone: string;
  /** Architectural principles */
  principles?: string[];
  /** Anti-patterns to avoid */
  antiPatterns?: string[];
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize a genome for the project.
 * Creates the directory structure, manifest, and initial section files.
 */
export async function initGenome(cwd: string, options: GenomeInitOptions): Promise<{ sectionsCreated: number }> {
  if (genomeExists(cwd)) {
    throw new Error("Genome already exists. Use /genome status to view it.");
  }

  const dir = genomeDir(cwd);

  // Create directory structure
  const dirs = ["", "vision", "milestones", "milestones/completed", "strategies", "knowledge", "evolution"];
  for (const sub of dirs) {
    const fullDir = join(dir, sub);
    if (!existsSync(fullDir)) {
      await mkdir(fullDir, { recursive: true });
    }
  }

  // Create and save manifest
  const manifest = createEmptyManifest(options.project);
  manifest.generation.milestone = options.milestone;
  await saveManifest(cwd, manifest);

  // Create initial sections
  let created = 0;

  // Vision
  await writeSection(cwd, "vision/north-star.md", `# North Star\n\n${options.vision}\n`, {
    title: "North Star Vision",
    summary: "Ultimate end-state vision for the project",
    tags: ["vision", "north-star", "goal", "purpose"],
  });
  created++;

  await writeSection(
    cwd,
    "vision/architecture.md",
    `# Architecture\n\nArchitectural decisions and system design will be documented here as agents discover and refine the optimal approach.\n`,
    {
      title: "Architecture",
      summary: "System architecture decisions and design",
      tags: ["vision", "architecture", "design", "system"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "vision/principles.md",
    formatListSection(
      "Design Principles",
      "Core principles will be documented here as the project evolves.",
      options.principles,
    ),
    {
      title: "Design Principles",
      summary: "Core design principles and constraints",
      tags: ["vision", "principles", "constraints", "rules"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "vision/anti-patterns.md",
    formatListSection(
      "Anti-Patterns",
      "Approaches to avoid will be documented here as agents learn from failures.",
      options.antiPatterns,
    ),
    {
      title: "Anti-Patterns",
      summary: "Approaches to avoid, learned from failures",
      tags: ["vision", "anti-patterns", "avoid", "failures", "lessons"],
    },
  );
  created++;

  // Milestones
  await writeSection(
    cwd,
    "milestones/current.md",
    `# ${options.milestone}\n\nStatus: In Progress\nGeneration: 1\n\n## Success Criteria\n\n- [ ] Define success criteria for this milestone\n`,
    {
      title: "Current Milestone",
      summary: options.milestone,
      tags: ["milestone", "current", "active"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "milestones/backlog.md",
    "# Milestone Backlog\n\nFuture milestones will be added here as the project evolves.\n",
    {
      title: "Milestone Backlog",
      summary: "Future milestones ordered by priority",
      tags: ["milestone", "backlog", "future", "planning"],
    },
  );
  created++;

  // Strategies
  await writeSection(
    cwd,
    "strategies/active.md",
    "# Active Strategies\n\nDevelopment approaches that have proven effective.\n\n- Explore existing codebase patterns before writing new code\n- Write tests alongside implementation\n- Keep changes small and reviewable\n",
    {
      title: "Active Strategies",
      summary: "Currently winning development approaches",
      tags: ["strategies", "active", "current", "methodology"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "strategies/graveyard.md",
    "# Strategy Graveyard\n\nFailed approaches and why they didn't work.\n",
    {
      title: "Strategy Graveyard",
      summary: "Failed approaches with post-mortems",
      tags: ["strategies", "graveyard", "failed", "lessons"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "strategies/experiments.md",
    "# Experimental Strategies\n\nApproaches being tested this generation.\n",
    {
      title: "Experimental Strategies",
      summary: "Approaches being tested this generation",
      tags: ["strategies", "experiments", "testing"],
    },
  );
  created++;

  // Knowledge
  await writeSection(
    cwd,
    "knowledge/decisions.md",
    "# Architectural Decision Records\n\nKey decisions and their rationale.\n",
    {
      title: "Decisions",
      summary: "Architectural decision records with rationale",
      tags: ["knowledge", "decisions", "adr", "rationale"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "knowledge/discoveries.md",
    "# Discoveries\n\nThings agents have learned about the codebase and domain.\n",
    {
      title: "Discoveries",
      summary: "Agent-discovered codebase and domain knowledge",
      tags: ["knowledge", "discoveries", "learned", "codebase"],
    },
  );
  created++;

  await writeSection(
    cwd,
    "knowledge/dependencies.md",
    "# Dependencies\n\nExternal dependencies, API contracts, and gotchas.\n",
    {
      title: "Dependencies",
      summary: "External deps, API contracts, integration notes",
      tags: ["knowledge", "dependencies", "external", "api"],
    },
  );
  created++;

  return { sectionsCreated: created };
}

/**
 * Initialize a genome by migrating content from existing CLAUDE.md.
 */
export async function initGenomeFromClaudeMd(cwd: string, project: string): Promise<{ sectionsCreated: number }> {
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const altPath = join(cwd, ".ashlrcode", "CLAUDE.md");
  const content = existsSync(claudeMdPath)
    ? await readFile(claudeMdPath, "utf-8")
    : existsSync(altPath)
      ? await readFile(altPath, "utf-8")
      : null;

  if (!content) {
    throw new Error("No CLAUDE.md found to migrate from.");
  }

  // Extract sections from CLAUDE.md by headers
  const sections = parseClaudeMdSections(content);

  // Initialize with extracted content
  const result = await initGenome(cwd, {
    project,
    vision: sections.description || `${project} — migrated from CLAUDE.md`,
    milestone: "Initial setup after CLAUDE.md migration",
    principles: sections.principles,
    antiPatterns: [],
  });

  // Write additional knowledge from CLAUDE.md
  if (sections.architecture) {
    await writeSection(cwd, "vision/architecture.md", `# Architecture\n\n${sections.architecture}\n`, {
      title: "Architecture",
      summary: "System architecture (migrated from CLAUDE.md)",
      tags: ["vision", "architecture", "design", "migrated"],
    });
  }

  if (sections.commands) {
    await writeSection(cwd, "knowledge/commands.md", `# Commands\n\n${sections.commands}\n`, {
      title: "Commands",
      summary: "Build, test, and run commands",
      tags: ["knowledge", "commands", "build", "test", "run"],
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatListSection(title: string, placeholder: string, items?: string[]): string {
  if (!items || items.length === 0) {
    return `# ${title}\n\n${placeholder}\n`;
  }
  const list = items.map((item) => `- ${item}`).join("\n");
  return `# ${title}\n\n${list}\n`;
}

/**
 * Naive CLAUDE.md section parser — extracts known sections by header keywords.
 */
function parseClaudeMdSections(content: string): {
  description?: string;
  architecture?: string;
  commands?: string;
  principles?: string[];
} {
  const lines = content.split("\n");
  const result: ReturnType<typeof parseClaudeMdSections> = {};

  // First non-empty, non-header line is likely the description
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      result.description = trimmed;
      break;
    }
  }

  // Extract sections between ## headers
  const sections = new Map<string, string>();
  let currentHeader = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.match(/^##\s+/)) {
      if (currentHeader) {
        sections.set(currentHeader.toLowerCase(), currentContent.join("\n").trim());
      }
      currentHeader = line.replace(/^##\s+/, "").trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentHeader) {
    sections.set(currentHeader.toLowerCase(), currentContent.join("\n").trim());
  }

  // Map known sections
  for (const [header, body] of sections) {
    if (header.includes("architecture") || header.includes("key director")) {
      result.architecture = body;
    }
    if (header.includes("command") || header.includes("script")) {
      result.commands = body;
    }
  }

  return result;
}
