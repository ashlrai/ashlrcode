/**
 * Genome strategy tracking — structured Darwinian selection of agent approaches.
 *
 * Records which strategies agents try, their outcomes, and enables
 * selection of the best approaches by category. Stored as JSONL for
 * append-only durability (same pattern as scribe.ts mutations).
 */

import { existsSync } from "fs";
import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { genomeDir } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyRecord {
  id: string;
  name: string;
  description: string;
  /** Which agent tried this */
  agentId: string;
  /** Generation when tried */
  generation: number;
  /** What type of work this applies to */
  category: "testing" | "implementation" | "refactoring" | "debugging" | "architecture" | "other";
  /** Outcome metrics */
  outcome: {
    success: boolean;
    testsPassedBefore: number;
    testsPassedAfter: number;
    filesModified: number;
    duration: number; // ms
    costUsd?: number;
  };
  timestamp: string;
}

export type StrategyCategory = StrategyRecord["category"];

export interface StrategyFilter {
  generation?: number;
  category?: StrategyCategory;
  agentId?: string;
}

export interface LeaderboardEntry {
  name: string;
  uses: number;
  successes: number;
  successRate: number;
  avgDuration: number;
  avgTestImprovement: number;
}

export interface CategoryLeaderboard {
  category: StrategyCategory;
  entries: LeaderboardEntry[];
}

export interface AgentProfile {
  agentId: string;
  totalStrategies: number;
  successRate: number;
  categoryCounts: Record<string, number>;
  topStrategies: Array<{ name: string; uses: number; successRate: number }>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function strategiesPath(cwd: string): string {
  return join(genomeDir(cwd), "evolution", "strategies.jsonl");
}

// ---------------------------------------------------------------------------
// JSONL helpers (mirrors scribe.ts pattern)
// ---------------------------------------------------------------------------

async function appendJsonl(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(path, JSON.stringify(data) + "\n", "utf-8");
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  const results: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // Skip corrupt JSONL lines — partial writes from crashes
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Record a strategy attempt and its outcome.
 * Generates an ID and timestamp if not provided.
 */
export async function recordStrategy(
  cwd: string,
  record: Omit<StrategyRecord, "id" | "timestamp"> & { id?: string; timestamp?: string },
): Promise<string> {
  const id = record.id ?? `strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const full: StrategyRecord = {
    ...record,
    id,
    timestamp: record.timestamp ?? new Date().toISOString(),
  };
  await appendJsonl(strategiesPath(cwd), full);
  return id;
}

/**
 * Load all strategy records, optionally filtered.
 */
export async function loadStrategies(cwd: string, filter?: StrategyFilter): Promise<StrategyRecord[]> {
  const all = await readJsonl<StrategyRecord>(strategiesPath(cwd));
  if (!filter) return all;

  return all.filter((r) => {
    if (filter.generation !== undefined && r.generation !== filter.generation) return false;
    if (filter.category !== undefined && r.category !== filter.category) return false;
    if (filter.agentId !== undefined && r.agentId !== filter.agentId) return false;
    return true;
  });
}

/**
 * Get strategies ranked by success rate (min 2 uses), grouped by category.
 */
export async function getStrategyLeaderboard(cwd: string): Promise<CategoryLeaderboard[]> {
  const all = await loadStrategies(cwd);
  if (all.length === 0) return [];

  // Group by category
  const byCategory = new Map<StrategyCategory, StrategyRecord[]>();
  for (const r of all) {
    const group = byCategory.get(r.category) ?? [];
    group.push(r);
    byCategory.set(r.category, group);
  }

  const leaderboards: CategoryLeaderboard[] = [];

  for (const [category, records] of byCategory) {
    // Group by strategy name within category
    const byName = new Map<string, StrategyRecord[]>();
    for (const r of records) {
      const group = byName.get(r.name) ?? [];
      group.push(r);
      byName.set(r.name, group);
    }

    const entries: LeaderboardEntry[] = [];
    for (const [name, nameRecords] of byName) {
      // Min 2 uses for statistical significance
      if (nameRecords.length < 2) continue;

      const successes = nameRecords.filter((r) => r.outcome.success).length;
      const avgDuration = nameRecords.reduce((sum, r) => sum + r.outcome.duration, 0) / nameRecords.length;
      const avgTestImprovement =
        nameRecords.reduce((sum, r) => sum + (r.outcome.testsPassedAfter - r.outcome.testsPassedBefore), 0) /
        nameRecords.length;

      entries.push({
        name,
        uses: nameRecords.length,
        successes,
        successRate: successes / nameRecords.length,
        avgDuration,
        avgTestImprovement,
      });
    }

    // Sort by success rate descending, then by uses descending
    entries.sort((a, b) => b.successRate - a.successRate || b.uses - a.uses);

    if (entries.length > 0) {
      leaderboards.push({ category, entries });
    }
  }

  // Sort categories alphabetically
  leaderboards.sort((a, b) => a.category.localeCompare(b.category));

  return leaderboards;
}

/**
 * Get an agent's strategy preferences and success rates.
 */
export async function getAgentProfile(cwd: string, agentId: string): Promise<AgentProfile> {
  const records = await loadStrategies(cwd, { agentId });

  const categoryCounts: Record<string, number> = {};
  for (const r of records) {
    categoryCounts[r.category] = (categoryCounts[r.category] ?? 0) + 1;
  }

  // Group by strategy name for top strategies
  const byName = new Map<string, StrategyRecord[]>();
  for (const r of records) {
    const group = byName.get(r.name) ?? [];
    group.push(r);
    byName.set(r.name, group);
  }

  const strategyStats = Array.from(byName.entries()).map(([name, recs]) => ({
    name,
    uses: recs.length,
    successRate: recs.filter((r) => r.outcome.success).length / recs.length,
  }));

  // Sort by uses descending
  strategyStats.sort((a, b) => b.uses - a.uses);

  const successes = records.filter((r) => r.outcome.success).length;

  return {
    agentId,
    totalStrategies: records.length,
    successRate: records.length > 0 ? successes / records.length : 0,
    categoryCounts,
    topStrategies: strategyStats.slice(0, 5),
  };
}

/**
 * Suggest the highest-success-rate strategy for a category.
 * Returns null if no strategies with 2+ uses exist for the category.
 */
export async function suggestStrategy(cwd: string, category: StrategyCategory): Promise<LeaderboardEntry | null> {
  const all = await loadStrategies(cwd, { category });
  if (all.length === 0) return null;

  // Group by name
  const byName = new Map<string, StrategyRecord[]>();
  for (const r of all) {
    const group = byName.get(r.name) ?? [];
    group.push(r);
    byName.set(r.name, group);
  }

  let best: LeaderboardEntry | null = null;

  for (const [name, records] of byName) {
    if (records.length < 2) continue;

    const successes = records.filter((r) => r.outcome.success).length;
    const successRate = successes / records.length;
    const avgDuration = records.reduce((sum, r) => sum + r.outcome.duration, 0) / records.length;
    const avgTestImprovement =
      records.reduce((sum, r) => sum + (r.outcome.testsPassedAfter - r.outcome.testsPassedBefore), 0) /
      records.length;

    const entry: LeaderboardEntry = {
      name,
      uses: records.length,
      successes,
      successRate,
      avgDuration,
      avgTestImprovement,
    };

    if (!best || successRate > best.successRate || (successRate === best.successRate && records.length > best.uses)) {
      best = entry;
    }
  }

  return best;
}

/**
 * Format leaderboard data for terminal display.
 */
export function formatLeaderboard(leaderboards: CategoryLeaderboard[]): string {
  if (leaderboards.length === 0) {
    return "No strategies with 2+ uses recorded yet.";
  }

  const lines: string[] = ["Strategy Leaderboard", "═".repeat(60)];

  for (const board of leaderboards) {
    lines.push("");
    lines.push(`  ${board.category.toUpperCase()}`);
    lines.push(`  ${"─".repeat(56)}`);
    lines.push(`  ${"Name".padEnd(28)} ${"Rate".padEnd(8)} ${"Uses".padEnd(6)} Avg Tests`);

    for (const entry of board.entries) {
      const rate = `${(entry.successRate * 100).toFixed(0)}%`;
      const testDelta = entry.avgTestImprovement >= 0 ? `+${entry.avgTestImprovement.toFixed(1)}` : entry.avgTestImprovement.toFixed(1);
      const name = entry.name.length > 27 ? entry.name.slice(0, 24) + "..." : entry.name;
      lines.push(`  ${name.padEnd(28)} ${rate.padEnd(8)} ${String(entry.uses).padEnd(6)} ${testDelta}`);
    }
  }

  return lines.join("\n");
}
