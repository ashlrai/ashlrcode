/**
 * Genome retriever — keyword-based section retrieval for system prompt injection.
 *
 * Scores genome sections by relevance to a query (task description),
 * returning the top-N sections that fit within a token budget.
 * Uses TF-IDF-inspired scoring against section tags, summaries, and titles.
 */

import { readFile } from "fs/promises";
import { estimateTokens, type GenomeManifest, genomeDir, loadManifest, sectionPath, type SectionMeta } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoredSection {
  section: SectionMeta;
  score: number;
}

/**
 * Tokenize a string into lowercase terms, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Score a section's relevance to a set of query terms.
 *
 * Scoring heuristic:
 *  - Tag match:     3 points per matching tag
 *  - Title match:   2 points per term found in title
 *  - Summary match: 1 point per term found in summary
 *  - IDF boost:     rarer terms (fewer section matches) score higher
 */
function scoreSection(section: SectionMeta, queryTerms: string[], idf: Map<string, number>): number {
  let score = 0;

  const tagSet = new Set(section.tags.map((t) => t.toLowerCase()));
  const titleTerms = new Set(tokenize(section.title));
  const summaryTerms = new Set(tokenize(section.summary));

  for (const term of queryTerms) {
    const boost = idf.get(term) ?? 1;

    if (tagSet.has(term)) score += 3 * boost;
    if (titleTerms.has(term)) score += 2 * boost;
    if (summaryTerms.has(term)) score += 1 * boost;
  }

  return score;
}

/**
 * Build an IDF-like map: terms that appear in fewer sections get higher weight.
 */
function buildIDF(sections: SectionMeta[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  const n = sections.length;

  for (const s of sections) {
    const allTerms = new Set([...s.tags.map((t) => t.toLowerCase()), ...tokenize(s.title), ...tokenize(s.summary)]);
    for (const term of allTerms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, freq] of docFreq) {
    // log(N / freq) + 1, minimum 1
    idf.set(term, Math.max(1, Math.log(n / freq) + 1));
  }

  return idf;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RetrievedSection {
  path: string;
  title: string;
  content: string;
  tokens: number;
  score: number;
}

/**
 * Retrieve the most relevant genome sections for a query, fitting within a token budget.
 *
 * Returns sections sorted by relevance score (descending), including content.
 * Sections with score 0 are excluded.
 */
export async function retrieveSections(cwd: string, query: string, maxTokens: number): Promise<RetrievedSection[]> {
  const manifest = await loadManifest(cwd);
  if (!manifest || manifest.sections.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    // No meaningful query — return highest-priority sections (vision, current milestone)
    return retrieveCoreSections(cwd, manifest, maxTokens);
  }

  const idf = buildIDF(manifest.sections);

  // Score all sections
  const scored: ScoredSection[] = manifest.sections
    .map((section) => ({
      section,
      score: scoreSection(section, queryTerms, idf),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Pack sections within token budget
  return packSections(cwd, scored, maxTokens);
}

/**
 * Retrieve core sections (north-star, current milestone, active strategies)
 * when no specific query is given.
 */
async function retrieveCoreSections(
  cwd: string,
  manifest: GenomeManifest,
  maxTokens: number,
): Promise<RetrievedSection[]> {
  const corePaths = ["vision/north-star.md", "milestones/current.md", "strategies/active.md"];

  const coreScored: ScoredSection[] = manifest.sections
    .filter((s) => corePaths.includes(s.path))
    .map((section) => ({ section, score: corePaths.length - corePaths.indexOf(section.path) }));

  return packSections(cwd, coreScored, maxTokens);
}

/**
 * Pack scored sections into the token budget, reading content from disk.
 */
async function packSections(cwd: string, scored: ScoredSection[], maxTokens: number): Promise<RetrievedSection[]> {
  const results: RetrievedSection[] = [];
  let usedTokens = 0;

  for (const { section, score } of scored) {
    if (usedTokens >= maxTokens) break;

    let content: string;
    try {
      // Use sectionPath for path traversal validation at read time
      const fullPath = sectionPath(cwd, section.path);
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue; // File missing, unreadable, or invalid path — skip
    }
    const tokens = estimateTokens(content);

    if (usedTokens + tokens > maxTokens) {
      // Try truncating to fit
      const remaining = maxTokens - usedTokens;
      if (remaining > 200) {
        // Worth including a truncated version
        const truncated = content.slice(0, remaining * 4) + "\n\n[... section truncated ...]";
        results.push({
          path: section.path,
          title: section.title,
          content: truncated,
          tokens: remaining,
          score,
        });
        usedTokens += remaining;
      }
      break;
    }

    results.push({
      path: section.path,
      title: section.title,
      content,
      tokens,
      score,
    });
    usedTokens += tokens;
  }

  return results;
}

/**
 * Retrieve sections using semantic search (Ollama embeddings) when available,
 * falling back to keyword-based TF-IDF search.
 *
 * This is the preferred entry point for retrieval — it transparently upgrades
 * to embedding-based search when a local Ollama instance is running with
 * cached embeddings, and degrades gracefully to keyword search otherwise.
 */
export async function retrieveSectionsV2(cwd: string, query: string, maxTokens: number): Promise<RetrievedSection[]> {
  // Only attempt semantic search for non-empty queries
  if (query.trim().length > 0) {
    try {
      const { isOllamaAvailable, semanticSearch } = await import("./embeddings.ts");
      if (await isOllamaAvailable()) {
        const results = await semanticSearch(cwd, query, maxTokens);
        if (results.length > 0) return results;
      }
    } catch {
      // Embedding module unavailable or errored — fall through to keyword search
    }
  }

  // Fall back to keyword search
  return retrieveSections(cwd, query, maxTokens);
}

/**
 * Format retrieved sections for injection into the system prompt.
 */
export function formatGenomeForPrompt(sections: RetrievedSection[]): string {
  if (sections.length === 0) return "";

  const formatted = sections.map((s) => `### ${s.title} (${s.path})\n${s.content}`);

  return `## Project Genome\n\n${formatted.join("\n\n---\n\n")}`;
}

/**
 * Inject genome context into a system prompt builder.
 *
 * Reads the genome, retrieves relevant sections for the task, and adds
 * them at priority 25 (after permissions, before knowledge files).
 */
export async function injectGenomeContext(
  builder: { addPart: (name: string, content: string, priority: number) => unknown },
  cwd: string,
  taskDescription: string,
  maxTokens: number,
): Promise<number> {
  const sections = await retrieveSections(cwd, taskDescription, maxTokens);
  if (sections.length === 0) return 0;

  const content = formatGenomeForPrompt(sections);
  builder.addPart("genome", content, 25);

  return sections.reduce((sum, s) => sum + s.tokens, 0);
}
