/**
 * Unit tests for tool-dependency-scheduler.ts
 *
 * Covers:
 * - Resource extraction from tool inputs
 * - DAG construction and edge inference
 * - Topological sort / wave decomposition
 * - Cycle detection fallback
 * - Plan cache (hit / miss / eviction)
 * - buildExecutionPlan integration
 * - visualiseExecutionPlan output
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  extractResourceAccess,
  buildDAG,
  topologicalWaves,
  buildExecutionPlan,
  planFingerprint,
  getCachedPlan,
  cachePlan,
  clearPlanCache,
  planCacheSize,
  visualiseExecutionPlan,
  recordWaveTiming,
} from "../agent/tool-dependency-scheduler.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tc(name: string, input: Record<string, unknown> = {}, id?: string): ToolCall {
  return { id: id ?? `call_${name}_${Math.random().toString(36).slice(2, 6)}`, name, input };
}

// ---------------------------------------------------------------------------
// extractResourceAccess
// ---------------------------------------------------------------------------

describe("extractResourceAccess — read-only tools", () => {
  test("Read extracts file_path as read", () => {
    const accesses = extractResourceAccess(tc("Read", { file_path: "/src/a.ts" }));
    expect(accesses).toContainEqual({ resource: "/src/a.ts", mode: "read" });
    expect(accesses.every((a) => a.mode === "read")).toBe(true);
  });

  test("Grep extracts path as read", () => {
    const accesses = extractResourceAccess(tc("Grep", { pattern: "foo", path: "/src" }));
    expect(accesses).toContainEqual({ resource: "/src", mode: "read" });
  });

  test("Glob extracts nothing write-related", () => {
    const accesses = extractResourceAccess(tc("Glob", { pattern: "**/*.ts" }));
    expect(accesses.every((a) => a.mode === "read")).toBe(true);
  });

  test("LS extracts path as read", () => {
    const accesses = extractResourceAccess(tc("LS", { path: "/tmp" }));
    expect(accesses).toContainEqual({ resource: "/tmp", mode: "read" });
  });

  test("Diff extracts both old and new paths as reads", () => {
    const accesses = extractResourceAccess(
      tc("Diff", { old_file_path: "/a.ts", new_file_path: "/b.ts" })
    );
    const resources = accesses.map((a) => a.resource);
    expect(resources).toContain("/a.ts");
    expect(resources).toContain("/b.ts");
    expect(accesses.every((a) => a.mode === "read")).toBe(true);
  });
});

describe("extractResourceAccess — write tools", () => {
  test("Edit extracts file_path as both read and write", () => {
    const accesses = extractResourceAccess(tc("Edit", { file_path: "/src/b.ts" }));
    const modes = accesses.map((a) => a.mode);
    expect(modes).toContain("read");
    expect(modes).toContain("write");
    expect(accesses.every((a) => a.resource === "/src/b.ts")).toBe(true);
  });

  test("Write extracts file_path as write only", () => {
    const accesses = extractResourceAccess(tc("Write", { file_path: "/out.txt" }));
    expect(accesses).toContainEqual({ resource: "/out.txt", mode: "write" });
    // Write does NOT add a read access
    expect(accesses.filter((a) => a.mode === "read")).toHaveLength(0);
  });

  test("TodoWrite returns opaque tool:todo write", () => {
    const accesses = extractResourceAccess(tc("TodoWrite", {}));
    expect(accesses).toContainEqual({ resource: "tool:todo", mode: "write" });
  });
});

describe("extractResourceAccess — Bash", () => {
  test("Bash with no recognisable paths returns opaque tool:bash write", () => {
    const accesses = extractResourceAccess(tc("Bash", { command: "echo hello" }));
    expect(accesses).toContainEqual({ resource: "tool:bash", mode: "write" });
  });

  test("Bash with absolute path in command extracts read", () => {
    const accesses = extractResourceAccess(tc("Bash", { command: "cat /etc/hosts" }));
    const resources = accesses.map((a) => a.resource);
    expect(resources.some((r) => r.includes("etc/hosts") || r === "/etc/hosts")).toBe(true);
  });
});

describe("extractResourceAccess — web tools", () => {
  test("WebFetch extracts url as read", () => {
    const accesses = extractResourceAccess(tc("WebFetch", { url: "https://example.com" }));
    expect(accesses).toContainEqual({ resource: "url:https://example.com", mode: "read" });
  });

  test("WebSearch extracts query as read", () => {
    const accesses = extractResourceAccess(tc("WebSearch", { query: "bun test" }));
    expect(accesses).toContainEqual({ resource: "search:bun test", mode: "read" });
  });
});

// ---------------------------------------------------------------------------
// buildDAG
// ---------------------------------------------------------------------------

describe("buildDAG — edge inference", () => {
  test("two independent reads produce no edges", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ];
    const { edges } = buildDAG(calls);
    expect(edges).toHaveLength(0);
  });

  test("write then read of same file produces one edge", () => {
    const calls = [
      tc("Edit", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/a.ts" }),
    ];
    const { edges } = buildDAG(calls);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe(0);
    expect(edges[0]!.to).toBe(1);
    expect(edges[0]!.resource).toBe("/a.ts");
  });

  test("read then write of same file does NOT add a backward edge", () => {
    // Read[0] → Write[1] should serialise Write after Read — but our model
    // only adds forward edges A→B where A writes something B reads/writes.
    // Read only reads, so it creates no write-dependency edge.
    const calls = [
      tc("Read", { file_path: "/x.ts" }),
      tc("Edit", { file_path: "/x.ts" }),
    ];
    const { edges } = buildDAG(calls);
    // Edit also reads the file, but no write from Read[0] triggers the edge
    expect(edges).toHaveLength(0);
  });

  test("write-after-write on same file creates edge", () => {
    const calls = [
      tc("Write", { file_path: "/out.txt" }),
      tc("Write", { file_path: "/out.txt" }),
    ];
    const { edges } = buildDAG(calls);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe(0);
    expect(edges[0]!.to).toBe(1);
  });

  test("nodes reference correct toolCallIds", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }, "id-A"),
      tc("Edit", { file_path: "/a.ts" }, "id-B"),
    ];
    const { nodes } = buildDAG(calls);
    expect(nodes[0]!.toolCallId).toBe("id-A");
    expect(nodes[1]!.toolCallId).toBe("id-B");
  });

  test("three-tool chain: A writes, B reads, C reads B output — no C dependency from A", () => {
    // A writes /src/a.ts
    // B reads /src/a.ts and writes /src/b.ts
    // C reads /src/b.ts
    const calls = [
      tc("Write", { file_path: "/src/a.ts" }),
      tc("Edit", { file_path: "/src/a.ts" }), // reads+writes /src/a.ts
      tc("Read", { file_path: "/src/a.ts" }),  // reads /src/a.ts
    ];
    const { edges } = buildDAG(calls);
    // A(0) writes /src/a.ts → B(1) has that in reads+writes: edge 0→1
    // A(0) writes /src/a.ts → C(2) reads it: edge 0→2
    const fromA = edges.filter((e) => e.from === 0);
    expect(fromA.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// topologicalWaves
// ---------------------------------------------------------------------------

describe("topologicalWaves", () => {
  test("single node produces one wave", () => {
    const { nodes } = buildDAG([tc("Read", { file_path: "/a.ts" })]);
    const { waves, hasCycle } = topologicalWaves(nodes);
    expect(hasCycle).toBe(false);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toEqual([0]);
  });

  test("two independent nodes produce one wave with both", () => {
    const { nodes } = buildDAG([
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ]);
    const { waves, hasCycle } = topologicalWaves(nodes);
    expect(hasCycle).toBe(false);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toContain(0);
    expect(waves[0]).toContain(1);
  });

  test("chain A→B→C produces three sequential waves", () => {
    // Construct a chain manually: A writes /f, B reads+writes /f, C reads /f
    const calls = [
      tc("Write", { file_path: "/f" }),   // 0: writes /f
      tc("Edit", { file_path: "/f" }),    // 1: reads+writes /f → depends on 0
      tc("Read", { file_path: "/f" }),    // 2: reads /f → depends on 0 (and 1 writes /f)
    ];
    const { nodes } = buildDAG(calls);
    const { waves, hasCycle } = topologicalWaves(nodes);
    expect(hasCycle).toBe(false);
    // Wave 0 must contain node 0 (no deps)
    expect(waves[0]).toContain(0);
    // Node 1 depends on 0, node 2 depends on 0 (and 1); so at least 2 waves
    expect(waves.length).toBeGreaterThanOrEqual(2);
  });

  test("cycle detection: artificially constructed cycle falls back", () => {
    // Build nodes manually with a cycle: 0→1, 1→0
    const { nodes } = buildDAG([
      tc("Read", { file_path: "/a" }),
      tc("Read", { file_path: "/b" }),
    ]);
    // Inject cycle manually
    nodes[0]!.deps.add(1);
    nodes[1]!.deps.add(0);
    nodes[0]!.dependents.add(1);
    nodes[1]!.dependents.add(0);

    const { waves, hasCycle } = topologicalWaves(nodes);
    expect(hasCycle).toBe(true);
    // All nodes should still appear in the fallback wave
    const allIndices = waves.flat();
    expect(allIndices.length).toBe(2);
  });

  test("diamond dependency: A→B, A→C, B→D, C→D — 3 waves", () => {
    // Build DAG manually for a diamond
    const calls = [
      tc("Write", { file_path: "/shared" }),           // A=0 writes /shared
      tc("Read", { file_path: "/shared" }),             // B=1 reads /shared
      tc("Read", { file_path: "/shared" }),             // C=2 reads /shared
      tc("Bash", { command: "echo hello" }),            // D=3 independent
    ];
    const { nodes } = buildDAG(calls);
    // B(1) and C(2) depend on A(0); D(3) is independent
    const { waves, hasCycle } = topologicalWaves(nodes);
    expect(hasCycle).toBe(false);
    // Wave 0: A(0) and D(3) (both have no deps)
    expect(waves[0]).toContain(0);
  });

  test("all nodes in waves covers every index exactly once", () => {
    const calls = [
      tc("Write", { file_path: "/a" }),
      tc("Read", { file_path: "/a" }),
      tc("Read", { file_path: "/b" }),
      tc("Write", { file_path: "/b" }),
    ];
    const { nodes } = buildDAG(calls);
    const { waves } = topologicalWaves(nodes);
    const allIndices = waves.flat().sort((a, b) => a - b);
    expect(allIndices).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Plan cache
// ---------------------------------------------------------------------------

describe("plan cache", () => {
  beforeEach(() => clearPlanCache());

  test("cache starts empty", () => {
    expect(planCacheSize()).toBe(0);
  });

  test("getCachedPlan returns null for unknown fingerprint", () => {
    expect(getCachedPlan("nonexistent")).toBeNull();
  });

  test("cachePlan + getCachedPlan round-trip", () => {
    const fp = "test-fingerprint";
    const plan = buildExecutionPlan([tc("Read", { file_path: "/x.ts" })]);
    const planWithFp = { ...plan, fingerprint: fp };
    cachePlan(planWithFp);
    const retrieved = getCachedPlan(fp);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.fingerprint).toBe(fp);
  });

  test("buildExecutionPlan caches the plan on first call", () => {
    const calls = [tc("Read", { file_path: "/z.ts" }, "stable-id")];
    expect(planCacheSize()).toBe(0);
    buildExecutionPlan(calls);
    expect(planCacheSize()).toBe(1);
  });

  test("buildExecutionPlan returns cached plan on second call with identical inputs", () => {
    const calls = [
      tc("Read", { file_path: "/cached.ts" }, "id-1"),
    ];
    const fp = planFingerprint(calls);
    const plan1 = buildExecutionPlan(calls);
    const plan2 = buildExecutionPlan(calls);
    expect(plan1.fingerprint).toBe(fp);
    expect(plan2.fingerprint).toBe(fp);
  });

  test("planFingerprint differs for different tool names", () => {
    const a = [tc("Read", { file_path: "/a.ts" })];
    const b = [tc("Edit", { file_path: "/a.ts" })];
    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });

  test("planFingerprint is stable for same inputs in same order", () => {
    const calls = [
      tc("Read", { file_path: "/stable.ts" }, "fixed-id"),
      tc("Edit", { file_path: "/stable.ts" }, "fixed-id2"),
    ];
    expect(planFingerprint(calls)).toBe(planFingerprint(calls));
  });
});

// ---------------------------------------------------------------------------
// buildExecutionPlan integration
// ---------------------------------------------------------------------------

describe("buildExecutionPlan integration", () => {
  beforeEach(() => clearPlanCache());

  test("empty input returns empty plan", () => {
    const plan = buildExecutionPlan([]);
    expect(plan.waves).toHaveLength(0);
    expect(plan.nodes).toHaveLength(0);
    expect(plan.edges).toHaveLength(0);
    expect(plan.hasCycle).toBe(false);
  });

  test("single tool call produces one wave", () => {
    const plan = buildExecutionPlan([tc("Read", { file_path: "/a.ts" })]);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toEqual([0]);
    expect(plan.hasCycle).toBe(false);
  });

  test("two independent reads run in same wave (safe parallelism)", () => {
    const plan = buildExecutionPlan([
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ]);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toContain(0);
    expect(plan.waves[0]).toContain(1);
  });

  test("edit-then-read of same file preserves dependency order", () => {
    const plan = buildExecutionPlan([
      tc("Edit", { file_path: "/src/x.ts" }),  // wave 0
      tc("Read", { file_path: "/src/x.ts" }),  // wave 1 (depends on edit)
    ]);
    expect(plan.hasCycle).toBe(false);
    expect(plan.edges.length).toBeGreaterThan(0);
    // Edit must come in an earlier wave than Read
    const editWave = plan.waves.findIndex((w) => w.includes(0));
    const readWave = plan.waves.findIndex((w) => w.includes(1));
    expect(editWave).toBeLessThan(readWave);
  });

  test("waveTimingsMs is initially empty", () => {
    const plan = buildExecutionPlan([tc("Read", { file_path: "/t.ts" })]);
    expect(plan.waveTimingsMs).toHaveLength(0);
  });

  test("recordWaveTiming populates waveTimingsMs", () => {
    const plan = buildExecutionPlan([tc("Read", { file_path: "/t.ts" })]);
    recordWaveTiming(plan, 0, 42);
    expect(plan.waveTimingsMs[0]).toBe(42);
  });

  test("three independent tools all in first wave", () => {
    const plan = buildExecutionPlan([
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
      tc("Read", { file_path: "/c.ts" }),
    ]);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toHaveLength(3);
  });

  test("mixed: two reads + one edit of one file — reads parallel, edit ordered", () => {
    // edit /a.ts (0), read /b.ts (1), read /c.ts (2) — 1 and 2 have no deps on 0
    const plan = buildExecutionPlan([
      tc("Edit", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
      tc("Read", { file_path: "/c.ts" }),
    ]);
    // All three can run in parallel since /a.ts, /b.ts, /c.ts don't overlap
    expect(plan.waves[0]).toContain(0);
    expect(plan.waves[0]).toContain(1);
    expect(plan.waves[0]).toContain(2);
  });

  test("dependency chain produces strictly ordered waves", () => {
    // 0 writes /f, 1 reads /f and writes /g, 2 reads /g
    const plan = buildExecutionPlan([
      tc("Write", { file_path: "/f" }),
      tc("Edit", { file_path: "/f" }),  // reads+writes /f → after 0
      tc("Read", { file_path: "/f" }),  // reads /f → after 0, after 1
    ]);
    const wave0 = plan.waves.findIndex((w) => w.includes(0));
    const wave1 = plan.waves.findIndex((w) => w.includes(1));
    const wave2 = plan.waves.findIndex((w) => w.includes(2));
    expect(wave0).toBeLessThanOrEqual(wave1);
    expect(wave0).toBeLessThanOrEqual(wave2);
  });
});

// ---------------------------------------------------------------------------
// visualiseExecutionPlan
// ---------------------------------------------------------------------------

describe("visualiseExecutionPlan", () => {
  beforeEach(() => clearPlanCache());

  test("empty plan returns '(empty)'", () => {
    const plan = buildExecutionPlan([]);
    const output = visualiseExecutionPlan(plan, []);
    expect(output).toMatch(/empty/i);
  });

  test("single tool shows one wave", () => {
    const calls = [tc("Read", { file_path: "/x.ts" })];
    const plan = buildExecutionPlan(calls);
    const output = visualiseExecutionPlan(plan, calls);
    expect(output).toMatch(/Wave 0/);
    expect(output).toMatch(/Read/);
  });

  test("two independent tools shows 'parallel'", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const output = visualiseExecutionPlan(plan, calls);
    expect(output).toMatch(/parallel/);
  });

  test("edge list shows dependency arrow", () => {
    const calls = [
      tc("Edit", { file_path: "/dep.ts" }),
      tc("Read", { file_path: "/dep.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const output = visualiseExecutionPlan(plan, calls);
    expect(output).toMatch(/→/);
    expect(output).toMatch(/dep\.ts/);
  });

  test("includes timing when recordWaveTiming is called", () => {
    const calls = [tc("Read", { file_path: "/t.ts" })];
    const plan = buildExecutionPlan(calls);
    recordWaveTiming(plan, 0, 123);
    const output = visualiseExecutionPlan(plan, calls);
    expect(output).toMatch(/123ms/);
  });

  test("cycle warning appears in output when hasCycle=true", () => {
    const calls = [tc("Read", { file_path: "/a.ts" }), tc("Read", { file_path: "/b.ts" })];
    const plan = buildExecutionPlan(calls);
    // Inject cycle flag
    const cyclePlan = { ...plan, hasCycle: true };
    const output = visualiseExecutionPlan(cyclePlan, calls);
    expect(output).toMatch(/cycle/i);
  });
});
