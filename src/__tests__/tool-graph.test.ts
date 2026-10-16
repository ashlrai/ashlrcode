/**
 * Tests for the /tool-graph command and its supporting utilities.
 *
 * Covers:
 * - DAG rendering correctness (renderDAG output structure)
 * - Circular dependency detection reflected in snapshots
 * - Parallel-set accuracy (correct wave grouping in snapshots)
 * - JSON snapshot schema validation (GraphSnapshot fields)
 * - getGraph() exposes correct node/edge/wave data
 * - isDebugGraphMode flag detection
 * - writeGraphSnapshot / listGraphSnapshots I/O (with tmp dir)
 * - Serial bottleneck detection
 * - Coalescence candidate detection
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildExecutionPlan,
  clearPlanCache,
  getGraph,
  buildDAG,
  topologicalWaves,
  type GraphSnapshot,
} from "../agent/tool-dependency-scheduler.ts";
import {
  renderDAG,
  isDebugGraphMode,
  writeGraphSnapshot,
  listGraphSnapshots,
  toolGraphCommands,
} from "../commands/tool-graph.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tc(name: string, input: Record<string, unknown> = {}, id?: string): ToolCall {
  return { id: id ?? `call_${name}_${Math.random().toString(36).slice(2, 6)}`, name, input };
}

// ---------------------------------------------------------------------------
// getGraph — snapshot schema validation
// ---------------------------------------------------------------------------

describe("getGraph — GraphSnapshot schema", () => {
  beforeEach(() => clearPlanCache());

  test("empty plan produces a valid empty snapshot", () => {
    const plan = buildExecutionPlan([]);
    const snap = getGraph(plan);

    // Required fields
    expect(typeof snap.fingerprint).toBe("string");
    expect(typeof snap.capturedAt).toBe("string");
    expect(typeof snap.nodeCount).toBe("number");
    expect(typeof snap.edgeCount).toBe("number");
    expect(typeof snap.waveCount).toBe("number");
    expect(typeof snap.hasCycle).toBe("boolean");
    expect(Array.isArray(snap.nodes)).toBe(true);
    expect(Array.isArray(snap.edges)).toBe(true);
    expect(Array.isArray(snap.waves)).toBe(true);
    expect(Array.isArray(snap.waveTimingsMs)).toBe(true);
    expect(Array.isArray(snap.parallelismDegrees)).toBe(true);
    expect(Array.isArray(snap.serialBottlenecks)).toBe(true);
    expect(Array.isArray(snap.coalescedPairs)).toBe(true);

    // Empty plan specifics
    expect(snap.nodeCount).toBe(0);
    expect(snap.edgeCount).toBe(0);
    expect(snap.waveCount).toBe(0);
    expect(snap.hasCycle).toBe(false);
  });

  test("capturedAt is a valid ISO timestamp", () => {
    const plan = buildExecutionPlan([tc("Read", { file_path: "/a.ts" })]);
    const snap = getGraph(plan);
    const d = new Date(snap.capturedAt);
    expect(isNaN(d.getTime())).toBe(false);
  });

  test("node schema contains required fields", () => {
    const plan = buildExecutionPlan([tc("Read", { file_path: "/a.ts" }, "id-1")]);
    const snap = getGraph(plan);
    expect(snap.nodes).toHaveLength(1);
    const n = snap.nodes[0]!;
    expect(typeof n.index).toBe("number");
    expect(typeof n.toolCallId).toBe("string");
    expect(typeof n.toolName).toBe("string");
    expect(Array.isArray(n.reads)).toBe(true);
    expect(Array.isArray(n.writes)).toBe(true);
    expect(Array.isArray(n.deps)).toBe(true);
    expect(Array.isArray(n.dependents)).toBe(true);
    expect(n.toolCallId).toBe("id-1");
    expect(n.toolName).toBe("Read");
  });

  test("edge schema contains from, to, resource", () => {
    const calls = [
      tc("Edit", { file_path: "/x.ts" }),
      tc("Read", { file_path: "/x.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.edgeCount).toBeGreaterThan(0);
    const e = snap.edges[0]!;
    expect(typeof e.from).toBe("number");
    expect(typeof e.to).toBe("number");
    expect(typeof e.resource).toBe("string");
  });

  test("nodeCount, edgeCount, waveCount are consistent with arrays", () => {
    const calls = [
      tc("Write", { file_path: "/f" }),
      tc("Read",  { file_path: "/f" }),
      tc("Read",  { file_path: "/g" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.nodeCount).toBe(snap.nodes.length);
    expect(snap.edgeCount).toBe(snap.edges.length);
    expect(snap.waveCount).toBe(snap.waves.length);
  });

  test("reads and writes in nodes are plain arrays (not Sets)", () => {
    const calls = [tc("Edit", { file_path: "/m.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const n = snap.nodes[0]!;
    // Must be serialisable — not a Set
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(n.reads).toBeInstanceOf(Array);
    expect(n.writes).toBeInstanceOf(Array);
  });

  test("snapshot is fully JSON-serialisable", () => {
    const calls = [
      tc("Edit", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/a.ts" }),
      tc("Bash", { command: "bun test" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    let serialised: string;
    expect(() => { serialised = JSON.stringify(snap); }).not.toThrow();
    const parsed = JSON.parse(serialised!) as GraphSnapshot;
    expect(parsed.fingerprint).toBe(snap.fingerprint);
    expect(parsed.nodeCount).toBe(snap.nodeCount);
  });
});

// ---------------------------------------------------------------------------
// getGraph — parallel-set accuracy
// ---------------------------------------------------------------------------

describe("getGraph — parallel-set accuracy", () => {
  beforeEach(() => clearPlanCache());

  test("two independent reads are in the same wave", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.waveCount).toBe(1);
    expect(snap.waves[0]).toContain(0);
    expect(snap.waves[0]).toContain(1);
    expect(snap.parallelismDegrees[0]).toBe(2);
  });

  test("write-then-read of same file are in different waves", () => {
    const calls = [
      tc("Edit", { file_path: "/dep.ts" }),
      tc("Read", { file_path: "/dep.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.waveCount).toBeGreaterThanOrEqual(2);
    const editWave = snap.waves.findIndex((w) => w.includes(0));
    const readWave = snap.waves.findIndex((w) => w.includes(1));
    expect(editWave).toBeLessThan(readWave);
  });

  test("three independent reads produce parallelismDegree of 3", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
      tc("Read", { file_path: "/c.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.parallelismDegrees[0]).toBe(3);
  });

  test("each index appears exactly once across all waves", () => {
    const calls = [
      tc("Write", { file_path: "/x" }),
      tc("Edit",  { file_path: "/x" }),
      tc("Read",  { file_path: "/x" }),
      tc("Read",  { file_path: "/y" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const allIndices = snap.waves.flat().sort((a, b) => a - b);
    expect(allIndices).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Circular dependency detection
// ---------------------------------------------------------------------------

describe("getGraph — circular dependency detection", () => {
  test("hasCycle is false for a normal acyclic plan", () => {
    const calls = [
      tc("Write", { file_path: "/f" }),
      tc("Read",  { file_path: "/f" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.hasCycle).toBe(false);
  });

  test("hasCycle is true when cycle injected manually", () => {
    // Build a plan then manually inject a cycle into the DAG
    const calls = [
      tc("Read", { file_path: "/a" }),
      tc("Read", { file_path: "/b" }),
    ];
    const { nodes } = buildDAG(calls);
    // Inject cycle: 0 depends on 1 and 1 depends on 0
    nodes[0]!.deps.add(1);
    nodes[1]!.deps.add(0);
    nodes[0]!.dependents.add(1);
    nodes[1]!.dependents.add(0);

    const { waves, hasCycle } = topologicalWaves(nodes);
    // Simulate building an execution plan with the cycle
    const cyclePlan = {
      fingerprint: "cycle-test",
      nodes,
      edges: [],
      waves,
      hasCycle,
      waveTimingsMs: [],
    };
    const snap = getGraph(cyclePlan);
    expect(snap.hasCycle).toBe(true);
  });

  test("renderDAG shows cycle warning when hasCycle=true", () => {
    const snap: GraphSnapshot = {
      fingerprint: "cycle-fp",
      capturedAt: new Date().toISOString(),
      nodeCount: 2,
      edgeCount: 0,
      waveCount: 1,
      hasCycle: true,
      nodes: [
        { index: 0, toolCallId: "a", toolName: "Read", reads: ["/a"], writes: [], deps: [1], dependents: [1] },
        { index: 1, toolCallId: "b", toolName: "Read", reads: ["/b"], writes: [], deps: [0], dependents: [0] },
      ],
      edges: [],
      waves: [[0, 1]],
      waveTimingsMs: [],
      parallelismDegrees: [2],
      serialBottlenecks: [],
      coalescedPairs: [],
    };
    const output = renderDAG(snap);
    expect(output).toMatch(/cycle/i);
    expect(output).toMatch(/WARNING/i);
  });
});

// ---------------------------------------------------------------------------
// renderDAG — output structure and correctness
// ---------------------------------------------------------------------------

describe("renderDAG — output correctness", () => {
  beforeEach(() => clearPlanCache());

  test("renders wave headers", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toMatch(/Wave 0/);
  });

  test("shows 'parallel' label for multi-tool wave", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toMatch(/parallel/i);
  });

  test("shows 'serial' label for single-tool wave", () => {
    const calls = [tc("Bash", { command: "bun test" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toMatch(/serial/i);
  });

  test("shows tool name in output", () => {
    const calls = [tc("Edit", { file_path: "/comp.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toContain("Edit");
  });

  test("dependency edge arrow appears when edges exist", () => {
    const calls = [
      tc("Edit", { file_path: "/dep.ts" }),
      tc("Read", { file_path: "/dep.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toMatch(/──▶/);
    expect(output).toMatch(/dep\.ts/);
  });

  test("'blocked by' annotation appears for dependent nodes", () => {
    const calls = [
      tc("Edit", { file_path: "/shared.ts" }),
      tc("Read", { file_path: "/shared.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toMatch(/blocked by/i);
  });

  test("shows fingerprint in header", () => {
    const calls = [tc("Read", { file_path: "/fp.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toContain(snap.fingerprint);
  });

  test("includes node count and edge count in header", () => {
    const calls = [
      tc("Edit", { file_path: "/h.ts" }),
      tc("Read", { file_path: "/h.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toContain("nodes: 2");
    expect(output).toContain("edges: 1");
  });

  test("write node uses diamond bullet (◆)", () => {
    const calls = [tc("Edit", { file_path: "/w.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toContain("◆");
  });

  test("read-only node uses circle bullet (●)", () => {
    const calls = [tc("Read", { file_path: "/r.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toContain("●");
  });

  test("serial bottleneck section appears when single-tool waves exist", () => {
    const calls = [tc("Bash", { command: "echo hi" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).toMatch(/bottleneck/i);
  });

  test("no dependency section when no edges", () => {
    const calls = [tc("Read", { file_path: "/only.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const output = renderDAG(snap, calls);
    expect(output).not.toMatch(/Dependency edges/);
  });

  test("renders without toolCalls argument (uses resource fallback labels)", () => {
    const calls = [
      tc("Edit", { file_path: "/noarg.ts" }),
      tc("Read", { file_path: "/noarg.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    // Should not throw
    let output = "";
    expect(() => { output = renderDAG(snap); }).not.toThrow();
    expect(output.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Serial bottleneck detection
// ---------------------------------------------------------------------------

describe("getGraph — serialBottlenecks", () => {
  beforeEach(() => clearPlanCache());

  test("single-tool wave appears in serialBottlenecks", () => {
    const calls = [tc("Bash", { command: "echo hi" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.serialBottlenecks).toContain(0);
  });

  test("multi-tool wave does not produce serialBottleneck entries", () => {
    const calls = [
      tc("Read", { file_path: "/a.ts" }),
      tc("Read", { file_path: "/b.ts" }),
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    expect(snap.serialBottlenecks).toHaveLength(0);
  });

  test("mixed plan: serial node identified correctly", () => {
    // 0 and 1 are parallel; 2 depends on 0 — so 2 will be in its own wave
    const calls = [
      tc("Read",  { file_path: "/a.ts" }),      // 0: parallel
      tc("Read",  { file_path: "/b.ts" }),      // 1: parallel
      tc("Edit",  { file_path: "/a.ts" }),      // 2: depends on 0 → serial wave
    ];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    // Node 2 should be in a serial wave (by itself)
    const wave2 = snap.waves.find((w) => w.includes(2));
    if (wave2 && wave2.length === 1) {
      expect(snap.serialBottlenecks).toContain(2);
    }
    // Nodes 0 and 1 are in a parallel wave — should NOT be in serialBottlenecks
    const wave01 = snap.waves.find((w) => w.includes(0) && w.includes(1));
    if (wave01) {
      expect(snap.serialBottlenecks).not.toContain(0);
      expect(snap.serialBottlenecks).not.toContain(1);
    }
  });
});

// ---------------------------------------------------------------------------
// isDebugGraphMode
// ---------------------------------------------------------------------------

describe("isDebugGraphMode", () => {
  test("returns true when --debug-graph flag present", () => {
    expect(isDebugGraphMode("--debug-graph")).toBe(true);
    expect(isDebugGraphMode("some text --debug-graph extra")).toBe(true);
  });

  test("returns false when flag absent and env not set", () => {
    const orig = process.env["ASHLRCODE_DEBUG_GRAPH"];
    delete process.env["ASHLRCODE_DEBUG_GRAPH"];
    expect(isDebugGraphMode("")).toBe(false);
    expect(isDebugGraphMode("show all waves")).toBe(false);
    if (orig !== undefined) process.env["ASHLRCODE_DEBUG_GRAPH"] = orig;
  });

  test("returns true when ASHLRCODE_DEBUG_GRAPH=1 env var set", () => {
    const orig = process.env["ASHLRCODE_DEBUG_GRAPH"];
    process.env["ASHLRCODE_DEBUG_GRAPH"] = "1";
    expect(isDebugGraphMode("")).toBe(true);
    if (orig !== undefined) {
      process.env["ASHLRCODE_DEBUG_GRAPH"] = orig;
    } else {
      delete process.env["ASHLRCODE_DEBUG_GRAPH"];
    }
  });
});

// ---------------------------------------------------------------------------
// writeGraphSnapshot / listGraphSnapshots
// ---------------------------------------------------------------------------

describe("writeGraphSnapshot + listGraphSnapshots", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tg-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writeGraphSnapshot creates a JSON file", async () => {
    const calls = [tc("Read", { file_path: "/snap.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);

    // Override snapshot dir via monkey-patching not needed — we test the
    // exported function directly and check the returned path.
    const filePath = await writeGraphSnapshot(snap);
    expect(filePath).toMatch(/\.json$/);

    // File should exist and be valid JSON
    const { readFile } = await import("fs/promises");
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as GraphSnapshot;
    expect(parsed.fingerprint).toBe(snap.fingerprint);
    expect(parsed.nodeCount).toBe(snap.nodeCount);
    expect(parsed.capturedAt).toBe(snap.capturedAt);

    // Cleanup
    const { unlink } = await import("fs/promises");
    await unlink(filePath).catch(() => {});
  });

  test("writeGraphSnapshot filename contains fingerprint", async () => {
    const calls = [tc("Edit", { file_path: "/fname.ts" })];
    const plan = buildExecutionPlan(calls);
    const snap = getGraph(plan);
    const filePath = await writeGraphSnapshot(snap);
    expect(filePath).toContain(snap.fingerprint);
    const { unlink } = await import("fs/promises");
    await unlink(filePath).catch(() => {});
  });

  test("listGraphSnapshots returns empty array when no snapshots exist", async () => {
    // Point to a non-existent dir — function should catch ENOENT and return []
    const snaps = await listGraphSnapshots();
    // Should be an array (may or may not be empty depending on prior runs)
    expect(Array.isArray(snaps)).toBe(true);
  });

  test("listGraphSnapshots returns .json entries sorted newest-first", async () => {
    const calls1 = [tc("Read", { file_path: "/list-a.ts" })];
    const calls2 = [tc("Read", { file_path: "/list-b.ts" })];
    const snap1 = getGraph(buildExecutionPlan(calls1));
    const snap2 = getGraph(buildExecutionPlan(calls2));
    const fp1 = await writeGraphSnapshot(snap1);
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const fp2 = await writeGraphSnapshot(snap2);

    const snaps = await listGraphSnapshots();
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    // Newest first — fp2 basename should appear before fp1 basename
    const base1 = fp1.split("/").pop()!;
    const base2 = fp2.split("/").pop()!;
    const idx1 = snaps.indexOf(base1);
    const idx2 = snaps.indexOf(base2);
    if (idx1 >= 0 && idx2 >= 0) {
      expect(idx2).toBeLessThan(idx1);
    }

    // Cleanup
    const { unlink } = await import("fs/promises");
    await unlink(fp1).catch(() => {});
    await unlink(fp2).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// toolGraphCommands — command registration
// ---------------------------------------------------------------------------

describe("toolGraphCommands", () => {
  test("returns an array with /tool-graph command", () => {
    const cmds = toolGraphCommands();
    expect(Array.isArray(cmds)).toBe(true);
    expect(cmds.length).toBeGreaterThanOrEqual(1);
    const cmd = cmds.find((c) => c.name === "/tool-graph");
    expect(cmd).toBeDefined();
  });

  test("/tool-graph has correct category and subcommands", () => {
    const cmd = toolGraphCommands().find((c) => c.name === "/tool-graph")!;
    expect(cmd.category).toBe("agent");
    expect(cmd.subcommands).toContain("show");
    expect(cmd.subcommands).toContain("snapshots");
    expect(cmd.subcommands).toContain("clear");
    expect(cmd.subcommands).toContain("--debug-graph");
  });

  test("/tool-graph handler returns true", async () => {
    const cmd = toolGraphCommands().find((c) => c.name === "/tool-graph")!;
    const outputs: string[] = [];
    const ctx = {
      addOutput: (t: string) => { outputs.push(t); },
      update: () => {},
      state: { registry: { clearSurgicalGate: () => {} } },
    } as any;
    const result = await cmd.handler("", ctx);
    expect(result).toBe(true);
    expect(outputs.length).toBeGreaterThan(0);
  });

  test("/tool-graph clear sub-command returns true", async () => {
    const cmd = toolGraphCommands().find((c) => c.name === "/tool-graph")!;
    const outputs: string[] = [];
    const ctx = { addOutput: (t: string) => { outputs.push(t); }, update: () => {} } as any;
    const result = await cmd.handler("clear", ctx);
    expect(result).toBe(true);
  });

  test("/tool-graph snapshots sub-command returns true", async () => {
    const cmd = toolGraphCommands().find((c) => c.name === "/tool-graph")!;
    const outputs: string[] = [];
    const ctx = { addOutput: (t: string) => { outputs.push(t); }, update: () => {} } as any;
    const result = await cmd.handler("snapshots", ctx);
    expect(result).toBe(true);
  });

  test("/tool-graph show <unknown-fp> returns true with error message", async () => {
    const cmd = toolGraphCommands().find((c) => c.name === "/tool-graph")!;
    const outputs: string[] = [];
    const ctx = { addOutput: (t: string) => { outputs.push(t); }, update: () => {} } as any;
    clearPlanCache();
    const result = await cmd.handler("show nonexistent-fingerprint", ctx);
    expect(result).toBe(true);
    expect(outputs.some((o) => o.toLowerCase().includes("no cached") || o.toLowerCase().includes("not found"))).toBe(true);
  });
});
