/**
 * Genome scribe — agent-driven genome evolution.
 *
 * Agents propose updates to genome sections via proposeUpdate().
 * Proposals are queued in JSONL, then consolidated by an LLM-powered
 * scribe that merges them into coherent genome mutations.
 *
 * Pattern: fire-and-forget proposals + batch consolidation (like dream.ts).
 */

import { existsSync } from "fs";
import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { genomeDir, readSection, updateManifest, writeSection, type SectionMeta } from "./manifest.ts";
import type { ProviderRouter } from "../providers/router.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenomeProposal {
  id: string;
  agentId: string;
  section: string;
  operation: "update" | "append" | "create";
  content: string;
  rationale: string;
  timestamp: string;
  generation: number;
}

export interface MutationRecord {
  id: string;
  generation: number;
  section: string;
  agentId: string;
  operation: string;
  rationale: string;
  timestamp: string;
  /** Diff or summary of what changed */
  diff: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function pendingPath(cwd: string): string {
  return join(genomeDir(cwd), "evolution", "pending.jsonl");
}

function mutationsPath(cwd: string): string {
  return join(genomeDir(cwd), "evolution", "mutations.jsonl");
}

// ---------------------------------------------------------------------------
// Proposal queue
// ---------------------------------------------------------------------------

/**
 * Queue a genome update proposal from an agent.
 * Fire-and-forget — doesn't block the agent.
 */
export async function proposeUpdate(
  cwd: string,
  proposal: Omit<GenomeProposal, "id" | "timestamp">,
): Promise<string> {
  const dir = join(genomeDir(cwd), "evolution");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const id = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const full: GenomeProposal = {
    ...proposal,
    id,
    timestamp: new Date().toISOString(),
  };

  await appendFile(pendingPath(cwd), JSON.stringify(full) + "\n", "utf-8");
  return id;
}

/**
 * Load all pending proposals.
 */
export async function loadPendingProposals(cwd: string): Promise<GenomeProposal[]> {
  const path = pendingPath(cwd);
  if (!existsSync(path)) return [];

  const raw = await readFile(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GenomeProposal);
}

/**
 * Clear the pending proposals queue (after consolidation).
 */
async function clearPendingProposals(cwd: string): Promise<void> {
  const path = pendingPath(cwd);
  if (existsSync(path)) {
    await writeFile(path, "", "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Mutation log
// ---------------------------------------------------------------------------

/**
 * Log a mutation to the audit trail.
 */
async function logMutation(cwd: string, mutation: MutationRecord): Promise<void> {
  const dir = join(genomeDir(cwd), "evolution");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await appendFile(mutationsPath(cwd), JSON.stringify(mutation) + "\n", "utf-8");
}

/**
 * Load mutation history.
 */
export async function loadMutations(
  cwd: string,
  limit?: number,
): Promise<MutationRecord[]> {
  const path = mutationsPath(cwd);
  if (!existsSync(path)) return [];

  const raw = await readFile(path, "utf-8");
  const all = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as MutationRecord);

  if (limit) return all.slice(-limit);
  return all;
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Consolidate pending proposals into genome updates.
 *
 * Groups proposals by section, uses LLM to merge conflicting updates,
 * applies changes, and logs mutations. The scribe holds an exclusive
 * write lock by processing sequentially.
 */
export async function consolidateProposals(
  cwd: string,
  router?: ProviderRouter,
): Promise<{ applied: number; skipped: number }> {
  const proposals = await loadPendingProposals(cwd);
  if (proposals.length === 0) return { applied: 0, skipped: 0 };

  // Group by section
  const bySection = new Map<string, GenomeProposal[]>();
  for (const p of proposals) {
    const group = bySection.get(p.section) ?? [];
    group.push(p);
    bySection.set(p.section, group);
  }

  let applied = 0;
  let skipped = 0;

  for (const [section, sectionProposals] of bySection) {
    const existing = await readSection(cwd, section);

    if (sectionProposals.length === 1 && sectionProposals[0]!.operation !== "update") {
      // Simple append or create — apply directly
      const p = sectionProposals[0]!;
      const newContent = p.operation === "append" && existing
        ? existing + "\n\n" + p.content
        : p.content;

      await writeSectionFromProposal(cwd, section, newContent, p);
      applied++;
      continue;
    }

    // Multiple proposals or updates — use LLM to merge if available
    if (router && sectionProposals.length > 1) {
      const merged = await mergeProposalsWithLLM(
        existing ?? "",
        sectionProposals,
        router,
      );
      if (merged) {
        await writeSectionFromProposal(cwd, section, merged, sectionProposals[0]!);
        applied++;
        continue;
      }
    }

    // Fallback: apply proposals sequentially (last write wins for updates)
    for (const p of sectionProposals) {
      const current = await readSection(cwd, section);
      const newContent = p.operation === "append" && current
        ? current + "\n\n" + p.content
        : p.content;

      await writeSectionFromProposal(cwd, section, newContent, p);
      applied++;
    }
  }

  await clearPendingProposals(cwd);
  return { applied, skipped };
}

/**
 * Write a section from a proposal and log the mutation.
 */
async function writeSectionFromProposal(
  cwd: string,
  sectionPath: string,
  content: string,
  proposal: GenomeProposal,
): Promise<void> {
  // Derive title and tags from section path
  const parts = sectionPath.replace(".md", "").split("/");
  const title = parts[parts.length - 1]!
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const category = parts[0] ?? "other";

  await writeSection(cwd, sectionPath, content, {
    title,
    summary: proposal.rationale.slice(0, 200),
    tags: [category, ...extractKeyTerms(proposal.rationale)],
  });

  await logMutation(cwd, {
    id: `mut-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    generation: proposal.generation,
    section: sectionPath,
    agentId: proposal.agentId,
    operation: proposal.operation,
    rationale: proposal.rationale,
    timestamp: new Date().toISOString(),
    diff: `[${proposal.operation}] ${proposal.content.slice(0, 500)}`,
  });
}

/**
 * Use LLM to merge multiple conflicting proposals for the same section.
 */
async function mergeProposalsWithLLM(
  existingContent: string,
  proposals: GenomeProposal[],
  router: ProviderRouter,
): Promise<string | null> {
  const proposalText = proposals
    .map((p, i) => `--- Proposal ${i + 1} (by ${p.agentId}, ${p.operation}) ---\nRationale: ${p.rationale}\n\n${p.content}`)
    .join("\n\n");

  const prompt = `You are merging multiple proposed updates to a genome section (a project knowledge document).

Current section content:
${existingContent || "(empty section)"}

Proposed changes:
${proposalText}

Merge these proposals into a single coherent update. Keep all non-conflicting information.
For conflicts, prefer the most specific/recent information. Maintain the existing formatting style.

Return ONLY the merged section content, no explanation.`;

  let response = "";
  const stream = router.stream({
    systemPrompt: "You merge document proposals. Return only the merged content.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  for await (const event of stream) {
    if (event.type === "text_delta" && event.text) {
      response += event.text;
    }
  }

  return response.trim() || null;
}

/**
 * Extract key terms from rationale text for tagging.
 */
function extractKeyTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 4)
    .slice(0, 5);
}
