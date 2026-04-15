/**
 * Generation lifecycle — milestone-based evolutionary generations.
 *
 * A generation = agents working toward a milestone. When the milestone
 * completes, the genome is evaluated, evolved (strategies promoted/retired),
 * and the next generation starts on the next milestone.
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { LLMSummarizer } from "../providers/types.ts";
import { type FitnessMetrics, measureFitness } from "./fitness.ts";
import { type GenomeManifest, genomeDir, loadManifest, readSection, updateManifest, writeSection } from "./manifest.ts";
import { consolidateProposals, loadMutationsForGeneration } from "./scribe.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerationReport {
  generation: number;
  milestone: string;
  fitness: FitnessMetrics;
  mutations: number;
  promotedStrategies: string[];
  retiredStrategies: string[];
  newExperiments: string[];
}

// ---------------------------------------------------------------------------
// Generation lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new generation for the given milestone.
 * Snapshots current genome state and resets the generation counter.
 */
export async function startGeneration(cwd: string, milestone: string): Promise<number> {
  const manifest = await updateManifest(cwd, (m) => {
    m.generation = {
      number: m.generation.number + 1,
      milestone,
      startedAt: new Date().toISOString(),
    };
  });

  // Ensure milestone section exists
  const currentMilestone = await readSection(cwd, "milestones/current.md");
  if (!currentMilestone || !currentMilestone.includes(milestone)) {
    await writeSection(
      cwd,
      "milestones/current.md",
      `# ${milestone}\n\nStatus: In Progress\nGeneration: ${manifest.generation.number}\n`,
      {
        title: "Current Milestone",
        summary: milestone,
        tags: ["milestone", "current", "active"],
      },
    );
  }

  return manifest.generation.number;
}

/**
 * Evaluate the current generation — measure fitness, assess progress.
 */
export async function evaluateGeneration(cwd: string, summarizer?: LLMSummarizer): Promise<GenerationReport> {
  const manifest = await loadManifest(cwd);
  if (!manifest) throw new Error("No genome found.");

  // Consolidate any pending proposals first
  await consolidateProposals(cwd, summarizer);

  // Measure fitness
  const fitness = await measureFitness(cwd);

  // Count mutations this generation
  const genMutations = await loadMutationsForGeneration(cwd, manifest.generation.number);

  // Evolve strategies if a summarizer is available
  let promotedStrategies: string[] = [];
  let retiredStrategies: string[] = [];
  let newExperiments: string[] = [];

  if (summarizer) {
    const evolution = await evolveStrategies(cwd, fitness, genMutations.length, summarizer);
    promotedStrategies = evolution.promoted;
    retiredStrategies = evolution.retired;
    newExperiments = evolution.experiments;
  }

  // Record fitness via serialized update
  const genNumber = manifest.generation.number;
  const milestoneName = manifest.generation.milestone;
  await updateManifest(cwd, (m) => {
    m.fitnessHistory.push({
      generation: genNumber,
      scores: { ...fitness },
    });
  });

  return {
    generation: genNumber,
    milestone: milestoneName,
    fitness,
    mutations: genMutations.length,
    promotedStrategies,
    retiredStrategies,
    newExperiments,
  };
}

/**
 * End the current generation — archive milestone, prepare for next.
 */
export async function endGeneration(cwd: string): Promise<void> {
  // Read manifest to get generation info (updateManifest used for writes below)
  const manifest = await loadManifest(cwd);
  if (!manifest) throw new Error("No genome found.");
  const genNum = manifest.generation.number;

  // Ensure fitness was evaluated before archiving
  const hasEvaluation = manifest.fitnessHistory.some((f) => f.generation === genNum);
  if (!hasEvaluation) {
    const fitness = await measureFitness(cwd);
    await updateManifest(cwd, (m) => {
      m.fitnessHistory.push({ generation: genNum, scores: { ...fitness } });
    });
  }

  // Archive current milestone
  const currentMilestone = await readSection(cwd, "milestones/current.md");
  if (currentMilestone) {
    const archivePath = `milestones/completed/${String(genNum).padStart(3, "0")}-gen${genNum}.md`;
    const archiveDir = join(genomeDir(cwd), "milestones", "completed");
    if (!existsSync(archiveDir)) {
      await mkdir(archiveDir, { recursive: true });
    }

    await writeSection(cwd, archivePath, currentMilestone, {
      title: `Completed: ${manifest.generation.milestone}`,
      summary: `Generation ${genNum} milestone (completed)`,
      tags: ["milestone", "completed", `gen-${genNum}`],
    });
  }

  // Update lineage and mark generation ended — via serialized update
  const lineageManifest = await loadManifest(cwd);
  if (lineageManifest) await updateLineage(cwd, lineageManifest);

  await updateManifest(cwd, (m) => {
    m.generation.endedAt = new Date().toISOString();
  });
}

// ---------------------------------------------------------------------------
// Strategy evolution
// ---------------------------------------------------------------------------

/**
 * Use LLM to evolve strategies based on generation fitness.
 */
async function evolveStrategies(
  cwd: string,
  fitness: FitnessMetrics,
  mutationCount: number,
  summarizer: LLMSummarizer,
): Promise<{ promoted: string[]; retired: string[]; experiments: string[] }> {
  const activeStrategies = (await readSection(cwd, "strategies/active.md")) ?? "";
  const experiments = (await readSection(cwd, "strategies/experiments.md")) ?? "";
  const graveyard = (await readSection(cwd, "strategies/graveyard.md")) ?? "";

  const prompt = `You are evolving the development strategies for an AI agent swarm.

Current fitness metrics:
${JSON.stringify(fitness, null, 2)}

Mutations this generation: ${mutationCount}

Active strategies:
${activeStrategies || "(none)"}

Experimental strategies being tested:
${experiments || "(none)"}

Strategy graveyard (failed approaches):
${graveyard || "(none)"}

Based on the fitness results, decide:
1. Which experimental strategies should be PROMOTED to active (they worked)?
2. Which active strategies should be RETIRED to graveyard (they didn't help)?
3. What NEW experiments should be tried next generation?

Respond in this exact JSON format (no markdown, no code fences):
{"promoted": ["strategy1"], "retired": ["strategy1"], "experiments": ["new experiment 1"], "updatedActive": "full text of updated active.md", "updatedExperiments": "full text of updated experiments.md", "graveyardAppend": "text to append to graveyard.md"}`;

  let response = "";
  const stream = summarizer.stream({
    systemPrompt: "You evolve development strategies. Respond only with the requested JSON.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  for await (const event of stream) {
    if (event.type === "text_delta" && event.text) {
      response += event.text;
    }
  }

  try {
    const cleaned = response
      .trim()
      .replace(/^```json?\n?/, "")
      .replace(/\n?```$/, "");
    const result = JSON.parse(cleaned);

    // Apply strategy updates
    if (result.updatedActive) {
      await writeSection(cwd, "strategies/active.md", result.updatedActive, {
        title: "Active Strategies",
        summary: "Currently winning development approaches",
        tags: ["strategies", "active", "current"],
      });
    }

    if (result.updatedExperiments) {
      await writeSection(cwd, "strategies/experiments.md", result.updatedExperiments, {
        title: "Experimental Strategies",
        summary: "Approaches being tested this generation",
        tags: ["strategies", "experiments", "testing"],
      });
    }

    if (result.graveyardAppend && result.graveyardAppend.trim()) {
      const currentGraveyard =
        (await readSection(cwd, "strategies/graveyard.md")) ??
        "# Strategy Graveyard\n\nFailed approaches and why they didn't work.\n";
      await writeSection(cwd, "strategies/graveyard.md", currentGraveyard + "\n\n" + result.graveyardAppend, {
        title: "Strategy Graveyard",
        summary: "Failed approaches with post-mortems",
        tags: ["strategies", "graveyard", "failed", "lessons"],
      });
    }

    return {
      promoted: Array.isArray(result.promoted) ? result.promoted : [],
      retired: Array.isArray(result.retired) ? result.retired : [],
      experiments: Array.isArray(result.experiments) ? result.experiments : [],
    };
  } catch {
    return { promoted: [], retired: [], experiments: [] };
  }
}

// ---------------------------------------------------------------------------
// Lineage tracking
// ---------------------------------------------------------------------------

interface LineageEntry {
  generation: number;
  milestone: string;
  startedAt: string;
  endedAt: string;
  mutationCount: number;
  fitnessScores: Record<string, number>;
}

async function updateLineage(cwd: string, manifest: GenomeManifest): Promise<void> {
  const lineagePath = join(genomeDir(cwd), "evolution", "lineage.json");
  const dir = join(genomeDir(cwd), "evolution");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  let lineage: LineageEntry[] = [];
  if (existsSync(lineagePath)) {
    try {
      const raw = await readFile(lineagePath, "utf-8");
      lineage = JSON.parse(raw);
    } catch {
      // Corrupt lineage file — start fresh
    }
  }

  const genMutations = await loadMutationsForGeneration(cwd, manifest.generation.number);
  const fitnessEntry = manifest.fitnessHistory.find((f) => f.generation === manifest.generation.number);

  lineage.push({
    generation: manifest.generation.number,
    milestone: manifest.generation.milestone,
    startedAt: manifest.generation.startedAt,
    endedAt: manifest.generation.endedAt ?? new Date().toISOString(),
    mutationCount: genMutations.length,
    fitnessScores: fitnessEntry?.scores ?? {},
  });

  await writeFile(lineagePath, JSON.stringify(lineage, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatGenerationReport(report: GenerationReport): string {
  const lines: string[] = [];

  lines.push(`Generation ${report.generation}: ${report.milestone}`);
  lines.push("");
  lines.push("Fitness:");
  for (const [key, value] of Object.entries(report.fitness)) {
    const bar = "█".repeat(Math.round(value * 10)) + "░".repeat(10 - Math.round(value * 10));
    lines.push(`  ${key.padEnd(20)} ${bar} ${(value * 100).toFixed(0)}%`);
  }
  lines.push("");
  lines.push(`Mutations: ${report.mutations}`);

  if (report.promotedStrategies.length > 0) {
    lines.push(`Promoted: ${report.promotedStrategies.join(", ")}`);
  }
  if (report.retiredStrategies.length > 0) {
    lines.push(`Retired: ${report.retiredStrategies.join(", ")}`);
  }
  if (report.newExperiments.length > 0) {
    lines.push(`New experiments: ${report.newExperiments.join(", ")}`);
  }

  return lines.join("\n");
}
