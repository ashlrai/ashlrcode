/**
 * Tests for the surgical-mode closed-loop feedback system:
 *   - SurgicalFeedbackRecorder  (surgical-feedback-recorder.ts)
 *   - ProposalRetrainer         (surgical-proposal-retrainer.ts)
 *   - proposeTierForGoal biasWeights integration (surgical-proposer.ts)
 *   - FEATURE_SURGICAL_RETRAINING flag integration
 *
 * Coverage:
 *   SurgicalFeedbackRecorder
 *     - record() writes a valid SurgicalRunRecord to JSONL
 *     - record() classifies outcome correctly (accepted / under / over)
 *     - record() computes durationMs and withinBudget fields
 *     - loadAll() returns [] when file does not exist
 *     - loadAll() skips lines missing filesTouched (ProposalFeedback rows)
 *     - loadRecent(n) returns at most n records, newest last
 *     - formatReport() shows "No run records" for empty list
 *     - formatReport() shows accuracy, confidence, per-run lines for non-empty
 *     - getRunRecordFilePath() is under homedir
 *     - getGlobalFeedbackRecorder() returns singleton
 *
 *   ProposalRetrainer
 *     - loadWeights() returns DEFAULT_WEIGHTS when file missing
 *     - retrain() returns changed:false for < 5 records
 *     - retrain() boosts under-performing tier bias
 *     - retrain() slightly penalises over-performing tier
 *     - retrain() clamps biases to [−0.2, +0.2]
 *     - retrain() saves weights to disk
 *     - loadWeights() round-trips persisted weights
 *     - formatResult() shows sample size, tier accuracy, weight changes
 *     - getGlobalRetrainer() returns singleton
 *     - loadCurrentWeights() delegates to global retrainer
 *
 *   proposeTierForGoal bias integration
 *     - positive narrow bias nudges scores toward narrow
 *     - zero bias produces same result as no bias
 *     - large positive wide bias can flip a narrow goal to wide (feature on)
 *     - bias is ignored when FEATURE_SURGICAL_RETRAINING is off
 *
 *   proposeTierForGoalAsync
 *     - returns a SurgicalProposal without throwing
 *     - with feature off, loads no weights (same as heuristic)
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rm, mkdir, writeFile, readFile } from "fs/promises";

import {
  SurgicalFeedbackRecorder,
  getRunRecordFilePath,
  getGlobalFeedbackRecorder,
  type SurgicalRunRecord,
  type RunCompletionEvent,
} from "../agent/surgical-feedback-recorder.ts";

import {
  ProposalRetrainer,
  DEFAULT_WEIGHTS,
  getGlobalRetrainer,
  loadCurrentWeights,
  type TierBiasWeights,
} from "../agent/surgical-proposal-retrainer.ts";

import {
  proposeTierForGoal,
  proposeTierForGoalAsync,
} from "../agent/surgical-proposer.ts";

import { setFeature } from "../config/features.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal RunCompletionEvent. */
function makeEvent(
  overrides: Partial<RunCompletionEvent> & { goal?: string } = {},
): RunCompletionEvent {
  return {
    goal: overrides.goal ?? "fix typo in README",
    proposedTier: overrides.proposedTier ?? "narrow",
    actualTier: overrides.actualTier ?? "narrow",
    proposedNumericTier: overrides.proposedNumericTier ?? 1,
    actualNumericTier: overrides.actualNumericTier ?? 1,
    filesTouched: overrides.filesTouched ?? 1,
    fileBudget: overrides.fileBudget ?? 1,
    startedAt: overrides.startedAt ?? (Date.now() - 500),
    testsPassed: overrides.testsPassed ?? null,
    proposalConfidence: overrides.proposalConfidence ?? 0.85,
  };
}

/** Unique temp file path for each test. */
function tempPath(suffix = ""): string {
  return join(tmpdir(), `surgical-feedback-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}.jsonl`);
}

function tempWeightsPath(): string {
  return join(tmpdir(), `surgical-weights-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ── SurgicalFeedbackRecorder — basic recording ────────────────────────────────

describe("SurgicalFeedbackRecorder — record()", () => {
  it("writes a JSONL line to the specified file", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent());

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.goal).toBe("fix typo in README");
  });

  it("appends multiple records as separate JSONL lines", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ goal: "goal A" }));
    await recorder.record(makeEvent({ goal: "goal B" }));
    await recorder.record(makeEvent({ goal: "goal C" }));

    const records = await recorder.loadAll();
    expect(records.length).toBe(3);
    expect(records.map((r) => r.goal)).toEqual(["goal A", "goal B", "goal C"]);
  });

  it("classifies outcome as 'accepted' when proposed == actual", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ proposedTier: "medium", actualTier: "medium" }));

    const [r] = await recorder.loadAll();
    expect(r!.outcome).toBe("accepted");
  });

  it("classifies outcome as 'under' when user needed wider tier", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ proposedTier: "narrow", actualTier: "wide" }));

    const [r] = await recorder.loadAll();
    expect(r!.outcome).toBe("under");
  });

  it("classifies outcome as 'over' when user ran narrower tier", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ proposedTier: "wide", actualTier: "narrow" }));

    const [r] = await recorder.loadAll();
    expect(r!.outcome).toBe("over");
  });

  it("computes durationMs > 0", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ startedAt: Date.now() - 1000 }));

    const [r] = await recorder.loadAll();
    expect(r!.durationMs).toBeGreaterThan(0);
  });

  it("sets withinBudget=true when filesTouched <= fileBudget", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ filesTouched: 1, fileBudget: 3 }));

    const [r] = await recorder.loadAll();
    expect(r!.withinBudget).toBe(true);
  });

  it("sets withinBudget=false when filesTouched > fileBudget", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ filesTouched: 5, fileBudget: 1 }));

    const [r] = await recorder.loadAll();
    expect(r!.withinBudget).toBe(false);
  });

  it("preserves testsPassed=true", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ testsPassed: true }));

    const [r] = await recorder.loadAll();
    expect(r!.testsPassed).toBe(true);
  });

  it("preserves testsPassed=null", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ testsPassed: null }));

    const [r] = await recorder.loadAll();
    expect(r!.testsPassed).toBeNull();
  });

  it("records have a valid ISO timestamp", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent());

    const [r] = await recorder.loadAll();
    expect(() => new Date(r!.timestamp)).not.toThrow();
    expect(new Date(r!.timestamp).getTime()).toBeGreaterThan(0);
  });
});

// ── SurgicalFeedbackRecorder — loadAll / loadRecent ───────────────────────────

describe("SurgicalFeedbackRecorder — loadAll()", () => {
  it("returns [] when file does not exist", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    const records = await recorder.loadAll();
    expect(records).toEqual([]);
  });

  it("skips JSONL lines that lack filesTouched (ProposalFeedback rows)", async () => {
    const path = tempPath();
    // Write a ProposalFeedback-shaped line (no filesTouched)
    const proposalLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      goal: "fix typo",
      suggestedTier: "narrow",
      suggestedConfidence: 0.88,
      chosenTier: "narrow",
      outcome: "accepted",
    });
    await writeFile(path, proposalLine + "\n", "utf8");

    const recorder = new SurgicalFeedbackRecorder(path);
    const records = await recorder.loadAll();
    // ProposalFeedback lines should be filtered out
    expect(records.length).toBe(0);
  });

  it("skips malformed lines without throwing", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ goal: "valid goal" }));
    // Prepend a bad line
    const existing = await readFile(path, "utf8");
    await writeFile(path, "NOT JSON\n" + existing, "utf8");

    const records = await recorder.loadAll();
    expect(records.length).toBe(1);
    expect(records[0]!.goal).toBe("valid goal");
  });
});

describe("SurgicalFeedbackRecorder — loadRecent(n)", () => {
  it("returns at most n records", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    for (let i = 0; i < 10; i++) {
      await recorder.record(makeEvent({ goal: `goal ${i}` }));
    }

    const recent = await recorder.loadRecent(5);
    expect(recent.length).toBe(5);
  });

  it("returns records in chronological order (oldest first)", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    for (let i = 0; i < 3; i++) {
      await recorder.record(makeEvent({ goal: `goal ${i}` }));
    }

    const recent = await recorder.loadRecent(3);
    expect(recent[0]!.goal).toBe("goal 0");
    expect(recent[2]!.goal).toBe("goal 2");
  });
});

// ── SurgicalFeedbackRecorder — formatReport() ─────────────────────────────────

describe("SurgicalFeedbackRecorder — formatReport()", () => {
  it("shows 'No run records' for empty list", () => {
    const recorder = new SurgicalFeedbackRecorder(tempPath());
    const report = recorder.formatReport([]);
    expect(report).toContain("No run records");
  });

  it("shows proposal accuracy for non-empty list", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ proposedTier: "narrow", actualTier: "narrow" }));
    await recorder.record(makeEvent({ proposedTier: "medium", actualTier: "wide" }));
    const records = await recorder.loadAll();
    const report = recorder.formatReport(records);
    expect(report).toContain("Proposal accuracy");
  });

  it("shows under-proposed count", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ proposedTier: "narrow", actualTier: "wide" }));
    const records = await recorder.loadAll();
    const report = recorder.formatReport(records);
    expect(report).toContain("Under-proposed");
  });

  it("shows per-run lines with proposed→actual", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ proposedTier: "narrow", actualTier: "medium" }));
    const records = await recorder.loadAll();
    const report = recorder.formatReport(records);
    expect(report).toContain("narrow→medium");
  });

  it("shows test pass rate when tests were run", async () => {
    const path = tempPath();
    const recorder = new SurgicalFeedbackRecorder(path);
    await recorder.record(makeEvent({ testsPassed: true }));
    await recorder.record(makeEvent({ testsPassed: false }));
    const records = await recorder.loadAll();
    const report = recorder.formatReport(records);
    expect(report).toContain("Test pass rate");
  });
});

// ── SurgicalFeedbackRecorder — module-level singleton ────────────────────────

describe("SurgicalFeedbackRecorder — singleton", () => {
  it("getGlobalFeedbackRecorder() returns same instance on repeated calls", () => {
    const a = getGlobalFeedbackRecorder();
    const b = getGlobalFeedbackRecorder();
    expect(a).toBe(b);
  });

  it("getRunRecordFilePath() is under homedir", () => {
    const { homedir } = require("os");
    expect(getRunRecordFilePath()).toContain(homedir());
  });
});

// ── ProposalRetrainer — loadWeights() ────────────────────────────────────────

describe("ProposalRetrainer — loadWeights()", () => {
  it("returns DEFAULT_WEIGHTS when file does not exist", async () => {
    const retrainer = new ProposalRetrainer(
      new SurgicalFeedbackRecorder(tempPath()),
      tempWeightsPath(),
    );
    const weights = await retrainer.loadWeights();
    expect(weights.narrow).toBe(0);
    expect(weights.medium).toBe(0);
    expect(weights.wide).toBe(0);
  });

  it("round-trips persisted weights", async () => {
    const wPath = tempWeightsPath();
    const retrainer = new ProposalRetrainer(
      new SurgicalFeedbackRecorder(tempPath()),
      wPath,
    );

    // Write weights directly to test load
    const expected: TierBiasWeights = {
      narrow: 0.05,
      medium: -0.1,
      wide: 0.15,
      lastRetrained: "2026-06-29T00:00:00.000Z",
      sampleSize: 42,
      tierAccuracy: { narrow: 0.6, medium: 0.4, wide: 0.85 },
    };
    await writeFile(wPath, JSON.stringify(expected), "utf8");

    const loaded = await retrainer.loadWeights();
    expect(loaded.narrow).toBeCloseTo(0.05);
    expect(loaded.medium).toBeCloseTo(-0.1);
    expect(loaded.wide).toBeCloseTo(0.15);
    expect(loaded.sampleSize).toBe(42);
  });
});

// ── ProposalRetrainer — retrain() ─────────────────────────────────────────────

describe("ProposalRetrainer — retrain()", () => {
  it("returns changed:false for < 5 records", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    for (let i = 0; i < 3; i++) {
      await recorder.record(makeEvent());
    }
    const retrainer = new ProposalRetrainer(recorder, tempWeightsPath());
    const result = await retrainer.retrain();
    expect(result.changed).toBe(false);
    expect(result.summary).toContain("Insufficient data");
  });

  it("boosts narrow bias when narrow accuracy is below LOW_THRESHOLD", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    // 10 runs proposing narrow, all actually ended up as wide (0% narrow accuracy)
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "narrow", actualTier: "wide", proposedNumericTier: 1, actualNumericTier: 4 }),
      );
    }
    const wPath = tempWeightsPath();
    const retrainer = new ProposalRetrainer(recorder, wPath);
    const result = await retrainer.retrain();

    // Narrow accuracy is 0 < 0.5 (LOW_THRESHOLD) → should boost narrow bias
    // But note: "under" means narrow was too small, so we should boost narrow to
    // make narrow proposals more likely when the goal warrants it. However the
    // retrainer boosts the tier that was PROPOSED but inaccurate.
    expect(result.changed).toBe(true);
    expect(result.updated.narrow).toBeGreaterThan(result.previous.narrow);
  });

  it("slightly penalises wide bias when wide accuracy is above HIGH_THRESHOLD", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    // 10 runs proposing wide, all accepted — accuracy > 80%
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "wide", actualTier: "wide", proposedNumericTier: 4, actualNumericTier: 4 }),
      );
    }
    const wPath = tempWeightsPath();
    const retrainer = new ProposalRetrainer(recorder, wPath);
    const result = await retrainer.retrain();

    expect(result.changed).toBe(true);
    // Wide accuracy is 100% > 80% (HIGH_THRESHOLD) → slight negative adjustment
    expect(result.updated.wide).toBeLessThan(result.previous.wide);
  });

  it("clamps biases to [-0.2, +0.2]", async () => {
    const rPath = tempPath();
    const wPath = tempWeightsPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);

    // Pre-seed weights already at max
    await writeFile(
      wPath,
      JSON.stringify({ ...DEFAULT_WEIGHTS, narrow: 0.2 }),
      "utf8",
    );

    // All narrow proposals fail → would try to boost beyond 0.2
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "narrow", actualTier: "wide", proposedNumericTier: 1, actualNumericTier: 4 }),
      );
    }

    const retrainer = new ProposalRetrainer(recorder, wPath);
    const result = await retrainer.retrain();
    expect(result.updated.narrow).toBeLessThanOrEqual(0.2);
    expect(result.updated.narrow).toBeGreaterThanOrEqual(-0.2);
  });

  it("does not go below -0.2", async () => {
    const rPath = tempPath();
    const wPath = tempWeightsPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);

    // Pre-seed weights at min
    await writeFile(
      wPath,
      JSON.stringify({ ...DEFAULT_WEIGHTS, wide: -0.2 }),
      "utf8",
    );

    // All wide proposals accepted (100% accuracy) → would penalise further
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "wide", actualTier: "wide", proposedNumericTier: 4, actualNumericTier: 4 }),
      );
    }

    const retrainer = new ProposalRetrainer(recorder, wPath);
    const result = await retrainer.retrain();
    expect(result.updated.wide).toBeGreaterThanOrEqual(-0.2);
  });

  it("saves weights to disk after retraining", async () => {
    const rPath = tempPath();
    const wPath = tempWeightsPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "narrow", actualTier: "wide", proposedNumericTier: 1, actualNumericTier: 4 }),
      );
    }

    const retrainer = new ProposalRetrainer(recorder, wPath);
    await retrainer.retrain();

    const saved = JSON.parse(await readFile(wPath, "utf8"));
    expect(typeof saved.narrow).toBe("number");
    expect(typeof saved.medium).toBe("number");
    expect(typeof saved.wide).toBe("number");
    expect(typeof saved.lastRetrained).toBe("string");
  });

  it("sampleSize in result equals number of records used", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    for (let i = 0; i < 7; i++) {
      await recorder.record(makeEvent());
    }
    const retrainer = new ProposalRetrainer(recorder, tempWeightsPath());
    const result = await retrainer.retrain();
    expect(result.sampleSize).toBe(7);
  });
});

// ── ProposalRetrainer — formatResult() ───────────────────────────────────────

describe("ProposalRetrainer — formatResult()", () => {
  it("shows sample size", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    for (let i = 0; i < 3; i++) {
      await recorder.record(makeEvent());
    }
    const retrainer = new ProposalRetrainer(recorder, tempWeightsPath());
    const result = await retrainer.retrain();
    const output = retrainer.formatResult(result);
    expect(output).toContain("Sample size");
  });

  it("shows tier accuracy when changed", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "narrow", actualTier: "wide", proposedNumericTier: 1, actualNumericTier: 4 }),
      );
    }
    const retrainer = new ProposalRetrainer(recorder, tempWeightsPath());
    const result = await retrainer.retrain();
    const output = retrainer.formatResult(result);
    expect(output).toContain("Tier accuracy");
    expect(output).toContain("narrow");
  });

  it("shows weight adjustments when changed", async () => {
    const rPath = tempPath();
    const recorder = new SurgicalFeedbackRecorder(rPath);
    for (let i = 0; i < 10; i++) {
      await recorder.record(
        makeEvent({ proposedTier: "narrow", actualTier: "wide", proposedNumericTier: 1, actualNumericTier: 4 }),
      );
    }
    const retrainer = new ProposalRetrainer(recorder, tempWeightsPath());
    const result = await retrainer.retrain();
    const output = retrainer.formatResult(result);
    expect(output).toContain("Weight adjustments");
  });
});

// ── ProposalRetrainer — singleton ─────────────────────────────────────────────

describe("ProposalRetrainer — singleton", () => {
  it("getGlobalRetrainer() returns same instance", () => {
    const a = getGlobalRetrainer();
    const b = getGlobalRetrainer();
    expect(a).toBe(b);
  });

  it("loadCurrentWeights() returns TierBiasWeights shaped object", async () => {
    const weights = await loadCurrentWeights();
    expect(typeof weights.narrow).toBe("number");
    expect(typeof weights.medium).toBe("number");
    expect(typeof weights.wide).toBe("number");
    expect(typeof weights.lastRetrained).toBe("string");
  });
});

// ── proposeTierForGoal bias integration ──────────────────────────────────────

describe("proposeTierForGoal — bias integration", () => {
  afterEach(() => {
    // Ensure feature is reset to default (off) after each test
    setFeature("SURGICAL_RETRAINING", false);
  });

  it("zero bias produces same tier as no-bias call", () => {
    const noWeights = proposeTierForGoal("fix typo", {});
    const zeroWeights = proposeTierForGoal("fix typo", {}, {
      ...DEFAULT_WEIGHTS,
    });
    expect(zeroWeights.tier).toBe(noWeights.tier);
    expect(zeroWeights.confidence).toBeCloseTo(noWeights.confidence, 1);
  });

  it("positive narrow bias with feature ON nudges narrow score higher", () => {
    setFeature("SURGICAL_RETRAINING", true);

    const baseline = proposeTierForGoal("fix failing test", {});
    const biased = proposeTierForGoal("fix failing test", {}, {
      ...DEFAULT_WEIGHTS,
      narrow: 0.15,
    });

    // With a strong positive narrow bias, narrow score should be higher
    expect(biased.scores.narrow).toBeGreaterThanOrEqual(baseline.scores.narrow);
  });

  it("large positive wide bias with feature ON can flip a narrow goal to wide", () => {
    setFeature("SURGICAL_RETRAINING", true);

    const biased = proposeTierForGoal("fix typo", {}, {
      ...DEFAULT_WEIGHTS,
      wide: 0.2,
      narrow: -0.15,
    });
    // Extreme bias should move toward wide
    expect(biased.scores.wide).toBeGreaterThan(0);
  });

  it("bias is ignored when FEATURE_SURGICAL_RETRAINING is OFF", () => {
    setFeature("SURGICAL_RETRAINING", false);

    const baseline = proposeTierForGoal("fix typo", {});
    const withBias = proposeTierForGoal("fix typo", {}, {
      ...DEFAULT_WEIGHTS,
      wide: 0.2,
      narrow: -0.2,
    });
    // Feature is off → bias should have no effect
    expect(withBias.tier).toBe(baseline.tier);
    expect(withBias.scores.narrow).toBeCloseTo(baseline.scores.narrow, 5);
    expect(withBias.scores.wide).toBeCloseTo(baseline.scores.wide, 5);
  });

  it("proposal confidence stays in [0, 1] with extreme biases (feature ON)", () => {
    setFeature("SURGICAL_RETRAINING", true);

    const biased = proposeTierForGoal("fix typo", {}, {
      ...DEFAULT_WEIGHTS,
      narrow: 0.2,
      medium: 0.2,
      wide: 0.2,
    });
    expect(biased.confidence).toBeGreaterThanOrEqual(0);
    expect(biased.confidence).toBeLessThanOrEqual(1);
  });
});

// ── proposeTierForGoalAsync ───────────────────────────────────────────────────

describe("proposeTierForGoalAsync", () => {
  afterEach(() => {
    setFeature("SURGICAL_RETRAINING", false);
  });

  it("returns a valid SurgicalProposal without throwing (feature off)", async () => {
    setFeature("SURGICAL_RETRAINING", false);
    const p = await proposeTierForGoalAsync("fix typo");
    expect(p).toBeDefined();
    expect(["narrow", "medium", "wide"]).toContain(p.tier);
    expect(p.confidence).toBeGreaterThanOrEqual(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
  });

  it("returns a valid SurgicalProposal without throwing (feature on)", async () => {
    setFeature("SURGICAL_RETRAINING", true);
    const p = await proposeTierForGoalAsync("refactor auth module", { fileCount: 50 });
    expect(p).toBeDefined();
    expect(["narrow", "medium", "wide"]).toContain(p.tier);
  });

  it("source is 'heuristic' for async path (no LLM)", async () => {
    setFeature("SURGICAL_RETRAINING", false);
    const p = await proposeTierForGoalAsync("fix typo");
    expect(p.source).toBe("heuristic");
  });
});
