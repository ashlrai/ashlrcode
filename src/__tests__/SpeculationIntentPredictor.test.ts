/**
 * SpeculationIntentPredictor tests
 *
 * 12+ fixtures covering refactor / feature / debug / read / search / test
 * intent patterns.  Tests verify intent inference, prediction ordering,
 * confidence intervals, telemetry, feedback logging, and the batchWithSpeculation
 * integration.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SpeculationIntentPredictor,
  formatPredictionProposal,
  getSpeculationTelemetry,
  resetSpeculationTelemetry,
  type IntentBucket,
  type ToolPrediction,
} from "../agent/speculation-predictor.ts";
import { batchWithSpeculation } from "../agent/tool-batching.ts";
import type { ToolCall } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePredictor(tmpDir: string) {
  return new SpeculationIntentPredictor(join(tmpDir, "speculation-feedback.jsonl"));
}

function topTool(predictions: ToolPrediction[]): string {
  return predictions[0]?.toolName ?? "";
}

// ---------------------------------------------------------------------------
// Fixture 1: Refactor intent — explicit keyword
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — refactor intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("refactor message infers refactor intent", () => {
    const r = predictor.predict("refactor the auth module to extract token logic");
    expect(r.intent).toBe("refactor");
    expect(r.intentConfidence).toBeGreaterThan(0.6);
  });

  test("refactor: Read is top prediction", () => {
    const r = predictor.predict("refactor the auth module to extract token logic");
    expect(topTool(r.predictions)).toBe("Read");
  });

  test("refactor: Grep is in top-3 predictions", () => {
    const r = predictor.predict("refactor login flow, rename UserAuth to AuthManager");
    const top3 = r.predictions.slice(0, 3).map((p) => p.toolName);
    expect(top3).toContain("Grep");
  });

  test("refactor: all predictions have valid confidence intervals", () => {
    const r = predictor.predict("clean up and reorganize the utils directory");
    for (const p of r.predictions) {
      expect(p.confidenceLo).toBeLessThanOrEqual(p.confidence);
      expect(p.confidenceHi).toBeGreaterThanOrEqual(p.confidence);
      expect(p.confidenceLo).toBeGreaterThanOrEqual(0);
      expect(p.confidenceHi).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: Feature intent
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — feature intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-feat-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("'add caching to login flow' → feature intent", () => {
    const r = predictor.predict("add caching to login flow");
    expect(r.intent).toBe("feature");
  });

  test("feature: Read appears in predictions", () => {
    const r = predictor.predict("implement a new rate-limiting middleware");
    const names = r.predictions.map((p) => p.toolName);
    expect(names).toContain("Read");
  });

  test("feature: at least 3 predictions returned", () => {
    const r = predictor.predict("create new dashboard component");
    expect(r.predictions.length).toBeGreaterThanOrEqual(3);
  });

  test("feature: predictions sorted descending by confidence", () => {
    const r = predictor.predict("build user profile API endpoint");
    for (let i = 1; i < r.predictions.length; i++) {
      expect(r.predictions[i - 1]!.confidence).toBeGreaterThanOrEqual(
        r.predictions[i]!.confidence,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: Debug intent
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — debug intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-dbg-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("'fix the crash in the payment service' → debug intent", () => {
    const r = predictor.predict("fix the crash in the payment service");
    expect(r.intent).toBe("debug");
  });

  test("debug: Bash is top prediction (need to run failing code)", () => {
    const r = predictor.predict("debug this error: TypeError undefined is not a function");
    expect(topTool(r.predictions)).toBe("Bash");
  });

  test("debug: prediction confidence > 0.5 for top tool", () => {
    const r = predictor.predict("the tests are broken, diagnose the issue");
    expect(r.predictions[0]!.confidence).toBeGreaterThan(0.5);
  });

  test("debug: rationale is non-empty for every prediction", () => {
    const r = predictor.predict("something broke in the build pipeline");
    for (const p of r.predictions) {
      expect(p.rationale.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 4: Read intent
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — read intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-read-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("'show me the contents of config.ts' → read intent", () => {
    const r = predictor.predict("show me the contents of config.ts");
    expect(r.intent).toBe("read");
  });

  test("read: Read is highest-confidence prediction", () => {
    const r = predictor.predict("display the current auth middleware");
    expect(r.predictions[0]!.toolName).toBe("Read");
    expect(r.predictions[0]!.confidence).toBeGreaterThan(0.5);
  });

  test("read: with recent Glob history, file hint injected on Read prediction", () => {
    const history = [
      {
        name: "Glob",
        input: { pattern: "*.ts" },
        result: "/src/auth.ts\n/src/user.ts\n",
      },
    ];
    const r = predictor.predict("read the auth module", history);
    const readPred = r.predictions.find((p) => p.toolName === "Read");
    expect(readPred?.inputHints).toBeDefined();
    expect(readPred?.inputHints?.file_path).toBe("/src/auth.ts");
  });
});

// ---------------------------------------------------------------------------
// Fixture 5: Search intent
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — search intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-srch-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("'find all usages of deprecated API' → search intent", () => {
    const r = predictor.predict("find all usages of deprecated API");
    expect(r.intent).toBe("search");
  });

  test("search: Grep is top-2 prediction", () => {
    const r = predictor.predict("search for all TODO comments in the codebase");
    const top2 = r.predictions.slice(0, 2).map((p) => p.toolName);
    expect(top2).toContain("Grep");
  });

  test("search: Glob in top-3", () => {
    const r = predictor.predict("locate all test files matching *.spec.ts");
    const top3 = r.predictions.slice(0, 3).map((p) => p.toolName);
    expect(top3).toContain("Glob");
  });
});

// ---------------------------------------------------------------------------
// Fixture 6: Test intent
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — test intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-test-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("'run all unit tests and check coverage' → test intent", () => {
    const r = predictor.predict("run all unit tests and check coverage");
    expect(r.intent).toBe("test");
  });

  test("test intent: Bash is top prediction", () => {
    const r = predictor.predict("run bun test and verify all specs pass");
    expect(topTool(r.predictions)).toBe("Bash");
  });
});

// ---------------------------------------------------------------------------
// Fixture 7: Unknown / other intent fallback
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — other/unknown intent", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-other-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("empty-ish message → 'other' intent with reduced confidence", () => {
    const r = predictor.predict("hmm");
    expect(r.intent).toBe("other");
    expect(r.intentConfidence).toBeLessThanOrEqual(0.65);
  });

  test("other intent still returns predictions", () => {
    const r = predictor.predict("let's go");
    expect(r.predictions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 8: Recency bonus from history
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — recency bonus", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-recency-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("recently used tool gets higher confidence than baseline", () => {
    const historyWithBash = [
      { name: "Bash", input: { command: "npm test" }, result: "passed" },
    ];

    const withHistory = predictor.predict("fix the broken build", historyWithBash);
    const noHistory = predictor.predict("fix the broken build", []);

    const bashWithHistory = withHistory.predictions.find((p) => p.toolName === "Bash");
    const bashNoHistory = noHistory.predictions.find((p) => p.toolName === "Bash");

    expect(bashWithHistory).toBeDefined();
    expect(bashNoHistory).toBeDefined();
    // With recency bonus, Bash confidence should be >= without history
    expect(bashWithHistory!.confidence).toBeGreaterThanOrEqual(bashNoHistory!.confidence);
  });
});

// ---------------------------------------------------------------------------
// Fixture 9: Prediction latency is fast
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — performance", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-perf-"));
    predictor = makePredictor(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("predict() completes in < 20ms (pure CPU)", () => {
    const r = predictor.predict(
      "refactor the authentication system to use JWT tokens",
    );
    expect(r.latencyMs).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// Fixture 10: Telemetry accumulates correctly
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — telemetry", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-tel-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("recordOutcome cache hit increments hitRate", async () => {
    const r = predictor.predict("read the config file");
    const p = r.predictions[0]!;

    await predictor.recordOutcome({
      prediction: p,
      toolName: p.toolName,
      cacheHit: true,
      latencySavedMs: 80,
      messageSnippet: "read the config file",
      intent: r.intent,
      intentConfidence: r.intentConfidence,
    });

    const tel = getSpeculationTelemetry();
    expect(tel.cacheHits).toBe(1);
    expect(tel.cacheMisses).toBe(0);
    expect(tel.hitRatePct).toBe(100);
    expect(tel.totalLatencySavedMs).toBe(80);
  });

  test("recordOutcome cache miss increments misses", async () => {
    const r = predictor.predict("search for error patterns");
    const p = r.predictions[0]!;

    await predictor.recordOutcome({
      prediction: p,
      toolName: p.toolName,
      cacheHit: false,
      latencySavedMs: 0,
      messageSnippet: "search for error patterns",
      intent: r.intent,
      intentConfidence: r.intentConfidence,
    });

    const tel = getSpeculationTelemetry();
    expect(tel.cacheMisses).toBe(1);
    expect(tel.hitRatePct).toBe(0);
  });

  test("resetSpeculationTelemetry clears all counters", async () => {
    const r = predictor.predict("add feature");
    const p = r.predictions[0]!;
    await predictor.recordOutcome({
      prediction: p, toolName: p.toolName, cacheHit: true,
      latencySavedMs: 50, messageSnippet: "add feature",
      intent: r.intent, intentConfidence: r.intentConfidence,
    });

    resetSpeculationTelemetry();
    const tel = getSpeculationTelemetry();
    expect(tel.predictions).toBe(0);
    expect(tel.cacheHits).toBe(0);
    expect(tel.cacheMisses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 11: Feedback JSONL logging on cache hit
// ---------------------------------------------------------------------------

describe("SpeculationIntentPredictor — feedback logging", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;
  let feedbackPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-fb-"));
    feedbackPath = join(tmpDir, "speculation-feedback.jsonl");
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("cache hit writes a line to speculation-feedback.jsonl", async () => {
    const r = predictor.predict("refactor auth module");
    const p = r.predictions[0]!;

    await predictor.recordOutcome({
      prediction: p,
      toolName: p.toolName,
      cacheHit: true,
      latencySavedMs: 120,
      messageSnippet: "refactor auth module",
      intent: r.intent,
      intentConfidence: r.intentConfidence,
    });

    expect(existsSync(feedbackPath)).toBe(true);
    const raw = readFileSync(feedbackPath, "utf-8");
    const record = JSON.parse(raw.trim().split("\n")[0]!);
    expect(record.cacheHit).toBe(true);
    expect(record.predictedTool).toBe(p.toolName);
    expect(record.latencySavedMs).toBe(120);
    expect(record.intent).toBe(r.intent);
  });

  test("cache miss does NOT write to feedback file", async () => {
    const r = predictor.predict("search for broken imports");
    const p = r.predictions[0]!;

    await predictor.recordOutcome({
      prediction: p,
      toolName: p.toolName,
      cacheHit: false,
      latencySavedMs: 0,
      messageSnippet: "search for broken imports",
      intent: r.intent,
      intentConfidence: r.intentConfidence,
    });

    // File should not be created for misses
    expect(existsSync(feedbackPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture 12: formatPredictionProposal formatting
// ---------------------------------------------------------------------------

describe("formatPredictionProposal", () => {
  let tmpDir: string;
  let predictor: SpeculationIntentPredictor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sip-fmt-"));
    predictor = makePredictor(tmpDir);
    resetSpeculationTelemetry();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("output contains intent bucket and confidence", () => {
    const r = predictor.predict("refactor the payment module");
    const output = formatPredictionProposal(r);
    expect(output).toContain("refactor");
    expect(output).toContain("%");
  });

  test("output contains all predicted tool names", () => {
    const r = predictor.predict("find all usages of getUser");
    const output = formatPredictionProposal(r);
    for (const p of r.predictions) {
      expect(output).toContain(p.toolName);
    }
  });

  test("output contains prediction latency line", () => {
    const r = predictor.predict("add rate limiting feature");
    const output = formatPredictionProposal(r);
    expect(output).toContain("latency");
  });
});

// ---------------------------------------------------------------------------
// Fixture 13: batchWithSpeculation integration
// ---------------------------------------------------------------------------

describe("batchWithSpeculation integration", () => {
  test("high-confidence Read prediction injected into first wave", () => {
    const pending: ToolCall[] = [
      { id: "tc1", name: "Bash", input: { command: "bun test" } },
    ];

    // Simulate a prediction result with a high-confidence Read hint
    const mockPrediction = {
      intent: "refactor" as IntentBucket,
      intentConfidence: 0.85,
      predictions: [
        {
          toolName: "Read",
          confidence: 0.88,
          confidenceLo: 0.78,
          confidenceHi: 0.98,
          rationale: "Refactor needs to read source files",
          inputHints: { file_path: "/src/auth.ts" },
        },
      ],
      latencyMs: 2,
    };

    const { batches, injectedPredictions } = batchWithSpeculation(pending, {
      prediction: mockPrediction,
      confidenceThreshold: 0.75,
    });

    expect(injectedPredictions.length).toBe(1);
    expect(injectedPredictions[0]!.toolName).toBe("Read");
    // The synthetic Read call should appear in one of the batches
    const allToolNames = batches.flatMap((b) => b.tools.map((t) => t.name));
    expect(allToolNames).toContain("Read");
  });

  test("low-confidence predictions are NOT injected", () => {
    const pending: ToolCall[] = [
      { id: "tc1", name: "Bash", input: { command: "ls" } },
    ];

    const mockPrediction = {
      intent: "other" as IntentBucket,
      intentConfidence: 0.5,
      predictions: [
        {
          toolName: "Read",
          confidence: 0.40,  // below 0.75 threshold
          confidenceLo: 0.30,
          confidenceHi: 0.50,
          rationale: "low confidence",
          inputHints: { file_path: "/src/foo.ts" },
        },
      ],
      latencyMs: 1,
    };

    const { injectedPredictions } = batchWithSpeculation(pending, {
      prediction: mockPrediction,
      confidenceThreshold: 0.75,
    });

    expect(injectedPredictions.length).toBe(0);
  });

  test("duplicate pending calls are not injected again", () => {
    const pending: ToolCall[] = [
      { id: "tc1", name: "Read", input: { file_path: "/src/auth.ts" } },
    ];

    const mockPrediction = {
      intent: "read" as IntentBucket,
      intentConfidence: 0.90,
      predictions: [
        {
          toolName: "Read",
          confidence: 0.90,
          confidenceLo: 0.80,
          confidenceHi: 1.0,
          rationale: "read file",
          inputHints: { file_path: "/src/auth.ts" }, // same as pending
        },
      ],
      latencyMs: 1,
    };

    const { injectedPredictions } = batchWithSpeculation(pending, {
      prediction: mockPrediction,
    });

    // Should NOT inject — already covered by pending
    expect(injectedPredictions.length).toBe(0);
  });

  test("predictions without inputHints are not injected", () => {
    const pending: ToolCall[] = [
      { id: "tc1", name: "Bash", input: { command: "echo hi" } },
    ];

    const mockPrediction = {
      intent: "search" as IntentBucket,
      intentConfidence: 0.80,
      predictions: [
        {
          toolName: "Grep",
          confidence: 0.85,
          confidenceLo: 0.75,
          confidenceHi: 0.95,
          rationale: "search for patterns",
          // no inputHints
        },
      ],
      latencyMs: 1,
    };

    const { injectedPredictions } = batchWithSpeculation(pending, {
      prediction: mockPrediction,
    });

    expect(injectedPredictions.length).toBe(0);
  });
});
