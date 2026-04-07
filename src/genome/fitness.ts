/**
 * Fitness measurement — quantitative assessment of genome generation health.
 *
 * Measures: test pass rate, code quality, milestone progress,
 * cost efficiency, and strategy success rate. All scores are 0-1.
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { genomeDir, loadManifest, readSection } from "./manifest.ts";
import { loadMutationsForGeneration } from "./scribe.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FitnessMetrics {
  /** Fraction of tests passing (0-1) */
  testsPassRate: number;
  /** Code quality score based on heuristics (0-1) */
  codeQuality: number;
  /** Estimated milestone completion (0-1) */
  milestoneProgress: number;
  /** Cost efficiency: work done per dollar (0-1, normalized) */
  costEfficiency: number;
  /** Fraction of strategies that produced positive outcomes (0-1) */
  strategySuccessRate: number;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Measure fitness metrics for the current project state.
 */
export async function measureFitness(cwd: string): Promise<FitnessMetrics> {
  const [testsPassRate, codeQuality, milestoneProgress, costEfficiency, strategySuccessRate] = await Promise.all([
    measureTestPassRate(cwd),
    measureCodeQuality(cwd),
    measureMilestoneProgress(cwd),
    measureCostEfficiency(cwd),
    measureStrategySuccessRate(cwd),
  ]);

  return {
    testsPassRate,
    codeQuality,
    milestoneProgress,
    costEfficiency,
    strategySuccessRate,
  };
}

/**
 * Compare fitness between two snapshots.
 */
export function compareFitness(
  before: FitnessMetrics,
  after: FitnessMetrics,
): Record<string, { before: number; after: number; delta: number }> {
  const result: Record<string, { before: number; after: number; delta: number }> = {};
  for (const key of Object.keys(before) as (keyof FitnessMetrics)[]) {
    result[key] = {
      before: before[key],
      after: after[key],
      delta: after[key] - before[key],
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Individual measurements
// ---------------------------------------------------------------------------

/**
 * Run tests and return pass rate. Falls back to 0.5 if tests can't be run.
 */
async function measureTestPassRate(cwd: string): Promise<number> {
  try {
    // Check if test script exists
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) return 0.5;

    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    if (!pkg.scripts?.test) return 0.5;

    // Run tests with bun
    const proc = Bun.spawn(["bun", "test", "--bail", "0"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "true" },
    });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;

    // Parse test results from output
    const output = stdout + stderr;
    const passMatch = output.match(/(\d+)\s+pass/i);
    const failMatch = output.match(/(\d+)\s+fail/i);

    const passed = passMatch ? parseInt(passMatch[1]!, 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1]!, 10) : 0;
    const total = passed + failed;

    if (total === 0) return exitCode === 0 ? 1.0 : 0.5;
    return passed / total;
  } catch {
    return 0.5;
  }
}

/**
 * Code quality heuristic based on TODO/FIXME density and TypeScript errors.
 */
async function measureCodeQuality(cwd: string): Promise<number> {
  try {
    const srcDir = join(cwd, "src");
    if (!existsSync(srcDir)) return 0.5;

    // Count TODO/FIXME/HACK markers
    let totalLines = 0;
    let markerCount = 0;

    await countMarkersRecursive(srcDir, (lines, markers) => {
      totalLines += lines;
      markerCount += markers;
    });

    if (totalLines === 0) return 0.5;

    // Quality = 1 - (marker density), clamped
    const density = markerCount / totalLines;
    const quality = Math.max(0, Math.min(1, 1 - density * 100));

    return quality;
  } catch {
    return 0.5;
  }
}

async function countMarkersRecursive(dir: string, callback: (lines: number, markers: number) => void): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      await countMarkersRecursive(fullPath, callback);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n").length;
      const markers = (content.match(/\b(TODO|FIXME|HACK|XXX)\b/gi) ?? []).length;
      callback(lines, markers);
    }
  }
}

/**
 * Estimate milestone progress by checking success criteria in the current milestone doc.
 */
async function measureMilestoneProgress(cwd: string): Promise<number> {
  const milestone = await readSection(cwd, "milestones/current.md");
  if (!milestone) return 0;

  // Count checkbox-style criteria: [x] done, [ ] pending
  const checked = (milestone.match(/\[x\]/gi) ?? []).length;
  const unchecked = (milestone.match(/\[\s\]/g) ?? []).length;
  const total = checked + unchecked;

  if (total === 0) {
    // No checkboxes — check for "complete"/"done" keywords
    const doneKeywords = (milestone.match(/\b(complete|done|finished|shipped)\b/gi) ?? []).length;
    return doneKeywords > 0 ? 0.7 : 0.3;
  }

  return checked / total;
}

/**
 * Cost efficiency based on mutations per generation (proxy for work done).
 * Normalized: 10+ mutations = 1.0, 0 mutations = 0.0.
 */
async function measureCostEfficiency(cwd: string): Promise<number> {
  const manifest = await loadManifest(cwd);
  if (!manifest) return 0;

  const genMutations = await loadMutationsForGeneration(cwd, manifest.generation.number);
  // Normalize: 10+ mutations = 1.0
  return Math.min(1, genMutations.length / 10);
}

/**
 * Strategy success rate based on active vs graveyard strategy counts.
 */
async function measureStrategySuccessRate(cwd: string): Promise<number> {
  const active = await readSection(cwd, "strategies/active.md");
  const graveyard = await readSection(cwd, "strategies/graveyard.md");

  // Count strategies by counting headers or bullet points
  const activeCount = countListItems(active ?? "");
  const graveyardCount = countListItems(graveyard ?? "");
  const total = activeCount + graveyardCount;

  if (total === 0) return 0.5;
  return activeCount / total;
}

function countListItems(text: string): number {
  return (text.match(/^[-*]\s/gm) ?? []).length + (text.match(/^#{2,3}\s/gm) ?? []).length;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatFitnessReport(metrics: FitnessMetrics): string {
  const lines: string[] = ["Fitness Metrics:"];

  for (const [key, value] of Object.entries(metrics)) {
    const label = key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (s) => s.toUpperCase())
      .trim();
    const pct = (value * 100).toFixed(0);
    const bar = "█".repeat(Math.round(value * 20)) + "░".repeat(20 - Math.round(value * 20));
    lines.push(`  ${label.padEnd(25)} ${bar} ${pct}%`);
  }

  return lines.join("\n");
}
