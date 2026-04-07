import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  createEmptyManifest,
  genomeDir,
  genomeExists,
  loadManifest,
  saveManifest,
  updateManifest,
  readSection,
  writeSection,
  totalGenomeTokens,
  estimateTokens,
  type GenomeManifest,
} from "../genome/manifest.ts";

import {
  retrieveSections,
  formatGenomeForPrompt,
} from "../genome/retriever.ts";

import {
  proposeUpdate,
  loadPendingProposals,
  loadMutations,
  consolidateProposals,
} from "../genome/scribe.ts";

import {
  initGenome,
} from "../genome/init.ts";

import {
  compareFitness,
  type FitnessMetrics,
} from "../genome/fitness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "ashlrcode-genome-test-"));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Manifest tests
// ---------------------------------------------------------------------------

describe("Genome Manifest", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("createEmptyManifest returns valid structure", () => {
    const m = createEmptyManifest("test-project");
    expect(m.version).toBe(1);
    expect(m.project).toBe("test-project");
    expect(m.sections).toEqual([]);
    expect(m.generation.number).toBe(1);
    expect(m.fitnessHistory).toEqual([]);
    expect(m.createdAt).toBeTruthy();
    expect(m.updatedAt).toBeTruthy();
  });

  test("genomeExists returns false for empty dir", () => {
    expect(genomeExists(tmpDir)).toBe(false);
  });

  test("saveManifest + loadManifest round-trips", async () => {
    const m = createEmptyManifest("my-project");
    m.generation.milestone = "Build auth";
    await saveManifest(tmpDir, m);

    expect(genomeExists(tmpDir)).toBe(true);

    const loaded = await loadManifest(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project).toBe("my-project");
    expect(loaded!.generation.milestone).toBe("Build auth");
    expect(loaded!.version).toBe(1);
  });

  test("updateManifest modifies and persists", async () => {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    const updated = await updateManifest(tmpDir, (manifest) => {
      manifest.generation.milestone = "Deploy v1";
    });

    expect(updated.generation.milestone).toBe("Deploy v1");

    const reloaded = await loadManifest(tmpDir);
    expect(reloaded!.generation.milestone).toBe("Deploy v1");
  });

  test("updateManifest throws if no genome", async () => {
    expect(
      updateManifest(tmpDir, () => {}),
    ).rejects.toThrow("No genome found");
  });

  test("writeSection creates file and updates manifest", async () => {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    await writeSection(tmpDir, "vision/north-star.md", "# Vision\n\nBuild something great", {
      title: "North Star",
      summary: "The ultimate vision",
      tags: ["vision", "goal"],
    });

    // File exists on disk
    const fullPath = join(genomeDir(tmpDir), "vision/north-star.md");
    expect(existsSync(fullPath)).toBe(true);

    // Content is correct
    const content = await readSection(tmpDir, "vision/north-star.md");
    expect(content).toContain("Build something great");

    // Manifest updated
    const loaded = await loadManifest(tmpDir);
    expect(loaded!.sections).toHaveLength(1);
    expect(loaded!.sections[0]!.path).toBe("vision/north-star.md");
    expect(loaded!.sections[0]!.title).toBe("North Star");
    expect(loaded!.sections[0]!.tags).toContain("vision");
    expect(loaded!.sections[0]!.tokens).toBeGreaterThan(0);
  });

  test("readSection returns null for missing section", async () => {
    const result = await readSection(tmpDir, "nonexistent.md");
    expect(result).toBeNull();
  });

  test("totalGenomeTokens sums all sections", () => {
    const m = createEmptyManifest("proj");
    m.sections = [
      { path: "a.md", title: "A", summary: "", tags: [], tokens: 100, updatedAt: "" },
      { path: "b.md", title: "B", summary: "", tags: [], tokens: 200, updatedAt: "" },
      { path: "c.md", title: "C", summary: "", tags: [], tokens: 300, updatedAt: "" },
    ];
    expect(totalGenomeTokens(m)).toBe(600);
  });

  test("estimateTokens uses chars/4 heuristic", () => {
    expect(estimateTokens("test")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("writeSection updates existing entry instead of duplicating", async () => {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    await writeSection(tmpDir, "vision/arch.md", "V1 content", {
      title: "Architecture",
      summary: "Initial arch",
      tags: ["arch"],
    });

    await writeSection(tmpDir, "vision/arch.md", "V2 content (updated)", {
      title: "Architecture v2",
      summary: "Updated arch",
      tags: ["arch", "updated"],
    });

    const loaded = await loadManifest(tmpDir);
    // Should still have only 1 section entry for this path
    const archSections = loaded!.sections.filter((s) => s.path === "vision/arch.md");
    expect(archSections).toHaveLength(1);
    expect(archSections[0]!.title).toBe("Architecture v2");

    const content = await readSection(tmpDir, "vision/arch.md");
    expect(content).toBe("V2 content (updated)");
  });
});

// ---------------------------------------------------------------------------
// Retriever tests
// ---------------------------------------------------------------------------

describe("Genome Retriever", () => {
  beforeEach(setup);
  afterEach(cleanup);

  async function seedGenome(): Promise<void> {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    await writeSection(tmpDir, "vision/north-star.md", "# North Star\n\nBuild an API gateway with auth and rate limiting.", {
      title: "North Star Vision",
      summary: "Build API gateway with authentication and rate limiting",
      tags: ["vision", "api", "gateway", "auth", "rate-limiting"],
    });

    await writeSection(tmpDir, "milestones/current.md", "# Auth Module\n\nImplement JWT authentication.", {
      title: "Current Milestone",
      summary: "JWT authentication implementation",
      tags: ["milestone", "auth", "jwt", "authentication"],
    });

    await writeSection(tmpDir, "strategies/active.md", "# Active Strategies\n\n- Test-driven development\n- Small PRs", {
      title: "Active Strategies",
      summary: "TDD and small PR approach",
      tags: ["strategies", "tdd", "testing"],
    });

    await writeSection(tmpDir, "knowledge/dependencies.md", "# Dependencies\n\n- Express.js for HTTP\n- Redis for caching", {
      title: "Dependencies",
      summary: "External dependencies and integrations",
      tags: ["knowledge", "dependencies", "express", "redis", "http"],
    });
  }

  test("retrieveSections returns relevant sections for query", async () => {
    await seedGenome();

    const results = await retrieveSections(tmpDir, "implement JWT authentication", 50_000);
    expect(results.length).toBeGreaterThan(0);

    // Auth-related sections should score highest
    const paths = results.map((r) => r.path);
    expect(paths).toContain("milestones/current.md");
  });

  test("retrieveSections returns empty for non-matching query", async () => {
    await seedGenome();

    const results = await retrieveSections(tmpDir, "xyzzy foobar nonsense", 50_000);
    expect(results).toEqual([]);
  });

  test("retrieveSections respects token budget", async () => {
    await seedGenome();

    // Very small budget — should only get 1-2 sections
    const results = await retrieveSections(tmpDir, "auth gateway", 50);
    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(50);
  });

  test("retrieveSections returns core sections for empty query", async () => {
    await seedGenome();

    const results = await retrieveSections(tmpDir, "", 50_000);
    expect(results.length).toBeGreaterThan(0);

    // Should include core sections
    const paths = results.map((r) => r.path);
    expect(paths).toContain("vision/north-star.md");
  });

  test("retrieveSections returns empty for no genome", async () => {
    const results = await retrieveSections(tmpDir, "anything", 50_000);
    expect(results).toEqual([]);
  });

  test("formatGenomeForPrompt produces readable output", async () => {
    await seedGenome();

    const results = await retrieveSections(tmpDir, "auth", 50_000);
    const formatted = formatGenomeForPrompt(results);

    expect(formatted).toContain("## Project Genome");
    expect(formatted.length).toBeGreaterThan(0);
  });

  test("formatGenomeForPrompt returns empty for no sections", () => {
    const formatted = formatGenomeForPrompt([]);
    expect(formatted).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Scribe tests
// ---------------------------------------------------------------------------

describe("Genome Scribe", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("proposeUpdate queues a proposal", async () => {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    const id = await proposeUpdate(tmpDir, {
      agentId: "agent-1",
      section: "knowledge/discoveries.md",
      operation: "append",
      content: "Found that auth uses JWT not sessions",
      rationale: "Discovered during codebase exploration",
      generation: 1,
    });

    expect(id).toMatch(/^prop-/);

    const pending = await loadPendingProposals(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.agentId).toBe("agent-1");
    expect(pending[0]!.section).toBe("knowledge/discoveries.md");
    expect(pending[0]!.content).toContain("JWT");
  });

  test("multiple proposals accumulate", async () => {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    await proposeUpdate(tmpDir, {
      agentId: "agent-1",
      section: "knowledge/discoveries.md",
      operation: "append",
      content: "Discovery 1",
      rationale: "Found something",
      generation: 1,
    });

    await proposeUpdate(tmpDir, {
      agentId: "agent-2",
      section: "knowledge/discoveries.md",
      operation: "append",
      content: "Discovery 2",
      rationale: "Found something else",
      generation: 1,
    });

    const pending = await loadPendingProposals(tmpDir);
    expect(pending).toHaveLength(2);
  });

  test("consolidateProposals applies single append", async () => {
    const m = createEmptyManifest("proj");
    await saveManifest(tmpDir, m);

    // Create the section first
    await writeSection(tmpDir, "knowledge/discoveries.md", "# Discoveries\n\nExisting content.", {
      title: "Discoveries",
      summary: "Agent discoveries",
      tags: ["knowledge"],
    });

    await proposeUpdate(tmpDir, {
      agentId: "agent-1",
      section: "knowledge/discoveries.md",
      operation: "append",
      content: "New discovery: Redis caching is used",
      rationale: "Found during exploration",
      generation: 1,
    });

    const result = await consolidateProposals(tmpDir);
    expect(result.applied).toBe(1);

    // Content should be appended
    const content = await readSection(tmpDir, "knowledge/discoveries.md");
    expect(content).toContain("Existing content");
    expect(content).toContain("Redis caching is used");

    // Pending should be cleared
    const pending = await loadPendingProposals(tmpDir);
    expect(pending).toHaveLength(0);

    // Mutation should be logged
    const mutations = await loadMutations(tmpDir);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.agentId).toBe("agent-1");
  });

  test("consolidateProposals with no pending returns zeros", async () => {
    const result = await consolidateProposals(tmpDir);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("loadMutations returns empty for fresh genome", async () => {
    const mutations = await loadMutations(tmpDir);
    expect(mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Init tests
// ---------------------------------------------------------------------------

describe("Genome Init", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("initGenome creates full directory structure", async () => {
    const result = await initGenome(tmpDir, {
      project: "test-project",
      vision: "Build the best CLI ever",
      milestone: "Core scaffolding",
      principles: ["Keep it simple", "Test everything"],
    });

    expect(result.sectionsCreated).toBe(12);

    // Manifest exists
    expect(genomeExists(tmpDir)).toBe(true);
    const manifest = await loadManifest(tmpDir);
    expect(manifest!.project).toBe("test-project");
    expect(manifest!.generation.number).toBe(1);
    expect(manifest!.generation.milestone).toBe("Core scaffolding");
    expect(manifest!.sections.length).toBe(12);

    // Key sections exist
    const northStar = await readSection(tmpDir, "vision/north-star.md");
    expect(northStar).toContain("Build the best CLI ever");

    const principles = await readSection(tmpDir, "vision/principles.md");
    expect(principles).toContain("Keep it simple");
    expect(principles).toContain("Test everything");

    const milestone = await readSection(tmpDir, "milestones/current.md");
    expect(milestone).toContain("Core scaffolding");

    const active = await readSection(tmpDir, "strategies/active.md");
    expect(active).toContain("Explore existing codebase");

    // Directories exist
    const dir = genomeDir(tmpDir);
    expect(existsSync(join(dir, "vision"))).toBe(true);
    expect(existsSync(join(dir, "milestones"))).toBe(true);
    expect(existsSync(join(dir, "milestones", "completed"))).toBe(true);
    expect(existsSync(join(dir, "strategies"))).toBe(true);
    expect(existsSync(join(dir, "knowledge"))).toBe(true);
    expect(existsSync(join(dir, "evolution"))).toBe(true);
  });

  test("initGenome throws if genome already exists", async () => {
    await initGenome(tmpDir, {
      project: "proj",
      vision: "Vision",
      milestone: "M1",
    });

    expect(
      initGenome(tmpDir, {
        project: "proj",
        vision: "Another vision",
        milestone: "M2",
      }),
    ).rejects.toThrow("Genome already exists");
  });

  test("initGenome without principles creates placeholder", async () => {
    await initGenome(tmpDir, {
      project: "proj",
      vision: "Build stuff",
      milestone: "Start",
    });

    const principles = await readSection(tmpDir, "vision/principles.md");
    expect(principles).toContain("principles will be documented");
  });
});

// ---------------------------------------------------------------------------
// Fitness tests
// ---------------------------------------------------------------------------

describe("Fitness", () => {
  test("compareFitness computes deltas", () => {
    const before: FitnessMetrics = {
      testsPassRate: 0.8,
      codeQuality: 0.7,
      milestoneProgress: 0.3,
      costEfficiency: 0.5,
      strategySuccessRate: 0.6,
    };

    const after: FitnessMetrics = {
      testsPassRate: 0.95,
      codeQuality: 0.75,
      milestoneProgress: 0.7,
      costEfficiency: 0.6,
      strategySuccessRate: 0.8,
    };

    const diff = compareFitness(before, after);

    expect(diff.testsPassRate!.delta).toBeCloseTo(0.15);
    expect(diff.milestoneProgress!.delta).toBeCloseTo(0.4);
    expect(diff.codeQuality!.delta).toBeCloseTo(0.05);
    expect(diff.strategySuccessRate!.delta).toBeCloseTo(0.2);
  });
});

// ---------------------------------------------------------------------------
// Integration: full init → retrieve → propose → consolidate flow
// ---------------------------------------------------------------------------

describe("Genome Integration", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("full lifecycle: init → retrieve → propose → consolidate", async () => {
    // 1. Init
    await initGenome(tmpDir, {
      project: "integration-test",
      vision: "Build an enterprise authentication system with OAuth2 and SAML support",
      milestone: "OAuth2 provider integration",
      principles: ["Security first", "No plaintext secrets"],
      antiPatterns: ["Don't store tokens in localStorage"],
    });

    // 2. Retrieve sections for a task
    const sections = await retrieveSections(
      tmpDir,
      "implement OAuth2 token exchange",
      10_000,
    );
    expect(sections.length).toBeGreaterThan(0);

    // Should find auth-related sections
    const titles = sections.map((s) => s.title);
    const hasRelevant = titles.some(
      (t) => t.includes("North Star") || t.includes("Milestone") || t.includes("Anti"),
    );
    expect(hasRelevant).toBe(true);

    // 3. Propose a genome update
    await proposeUpdate(tmpDir, {
      agentId: "oauth-agent",
      section: "knowledge/discoveries.md",
      operation: "append",
      content: "OAuth2 token exchange requires PKCE for public clients",
      rationale: "Discovered during OAuth2 implementation research",
      generation: 1,
    });

    const pending = await loadPendingProposals(tmpDir);
    expect(pending).toHaveLength(1);

    // 4. Consolidate
    const result = await consolidateProposals(tmpDir);
    expect(result.applied).toBe(1);

    // 5. Verify content was updated
    const discoveries = await readSection(tmpDir, "knowledge/discoveries.md");
    expect(discoveries).toContain("PKCE");

    // 6. Verify mutation was logged
    const mutations = await loadMutations(tmpDir);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.agentId).toBe("oauth-agent");

    // 7. Pending should be empty
    const remaining = await loadPendingProposals(tmpDir);
    expect(remaining).toHaveLength(0);
  });

  test("genome sections integrate with retriever formatting", async () => {
    await initGenome(tmpDir, {
      project: "format-test",
      vision: "Test formatting",
      milestone: "First milestone",
    });

    const sections = await retrieveSections(tmpDir, "", 50_000);
    const formatted = formatGenomeForPrompt(sections);

    expect(formatted).toContain("## Project Genome");
    expect(formatted).toContain("North Star");
  });
});
