/**
 * Tests for ToolResultPredictor — pattern classification, size prediction,
 * accuracy logging, and integration with ToolMetrics history.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ToolResultPredictor,
  classifyOutputPattern,
  predictToolOutputSize,
  getToolResultPredictor,
  type OutputPattern,
  type PredictionResult,
} from "../agent/tool-result-predictor.ts";
import { ToolMetrics } from "../agent/tool-metrics.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshPredictor(): ToolResultPredictor {
  return ToolResultPredictor.create();
}

// ---------------------------------------------------------------------------
// classifyOutputPattern()
// ---------------------------------------------------------------------------

describe("classifyOutputPattern() — tool name + input classification", () => {
  test("Bash + find → file_listing", () => {
    expect(classifyOutputPattern("Bash", { command: "find . -name '*.ts'" })).toBe("file_listing");
  });

  test("Bash + grep -r → grep_results", () => {
    expect(classifyOutputPattern("Bash", { command: "grep -r 'import' src/" })).toBe("grep_results");
  });

  test("Bash + rg (ripgrep) → grep_results", () => {
    expect(classifyOutputPattern("Bash", { command: "rg 'TODO' src/" })).toBe("grep_results");
  });

  test("Bash + git log → git_log", () => {
    expect(classifyOutputPattern("Bash", { command: "git log --oneline" })).toBe("git_log");
  });

  test("Bash + git diff → git_log", () => {
    expect(classifyOutputPattern("Bash", { command: "git diff HEAD~1" })).toBe("git_log");
  });

  test("Bash + bun install → package_install", () => {
    expect(classifyOutputPattern("Bash", { command: "bun install" })).toBe("package_install");
  });

  test("Bash + npm ci → package_install", () => {
    expect(classifyOutputPattern("Bash", { command: "npm ci" })).toBe("package_install");
  });

  test("Bash + bun test → test_output", () => {
    expect(classifyOutputPattern("Bash", { command: "bun test" })).toBe("test_output");
  });

  test("Bash + jest → test_output", () => {
    expect(classifyOutputPattern("Bash", { command: "jest --coverage" })).toBe("test_output");
  });

  test("Bash + cat → code_dump", () => {
    expect(classifyOutputPattern("Bash", { command: "cat src/index.ts" })).toBe("code_dump");
  });

  test("Bash + generic command → generic_text", () => {
    expect(classifyOutputPattern("Bash", { command: "echo hello" })).toBe("generic_text");
  });

  test("dedicated Grep tool → grep_results", () => {
    expect(classifyOutputPattern("Grep", { pattern: "TODO", path: "src/" })).toBe("grep_results");
  });

  test("dedicated Glob tool → file_listing", () => {
    expect(classifyOutputPattern("Glob", { pattern: "**/*.ts" })).toBe("file_listing");
  });

  test("LS tool → file_listing", () => {
    expect(classifyOutputPattern("LS", { path: "src/" })).toBe("file_listing");
  });

  test("Read + package.json → config_file", () => {
    expect(classifyOutputPattern("Read", { file_path: "/project/package.json" })).toBe("config_file");
  });

  test("Read + tsconfig.json → config_file", () => {
    expect(classifyOutputPattern("Read", { file_path: "/project/tsconfig.json" })).toBe("config_file");
  });

  test("Read + .ts file → code_dump", () => {
    expect(classifyOutputPattern("Read", { file_path: "src/agent/tool-executor.ts" })).toBe("code_dump");
  });

  test("Read + .md file → generic_text", () => {
    expect(classifyOutputPattern("Read", { file_path: "README.md" })).toBe("generic_text");
  });

  test("Write tool → write_confirm", () => {
    expect(classifyOutputPattern("Write", { file_path: "out.ts", content: "hello" })).toBe("write_confirm");
  });

  test("Edit tool → write_confirm", () => {
    expect(classifyOutputPattern("Edit", { file_path: "out.ts" })).toBe("write_confirm");
  });

  test("unknown tool → generic_text", () => {
    expect(classifyOutputPattern("SomeMcpTool", {})).toBe("generic_text");
  });
});

// ---------------------------------------------------------------------------
// ToolResultPredictor.predict() — heuristic path
// ---------------------------------------------------------------------------

describe("ToolResultPredictor.predict() — heuristic only", () => {
  beforeEach(() => ToolMetrics.resetInstance());

  test("file_listing pattern returns large estimate (> 50 KB)", () => {
    const p = freshPredictor();
    const r = p.predict("Bash", { command: "find . -type f" });
    expect(r.pattern).toBe("file_listing");
    expect(r.estimatedBytes).toBeGreaterThan(50_000);
    expect(r.source).toBe("heuristic");
    expect(r.confidence).toBe("low");
  });

  test("write_confirm pattern returns tiny estimate (< 1 KB)", () => {
    const p = freshPredictor();
    const r = p.predict("Write", { file_path: "a.ts" });
    expect(r.pattern).toBe("write_confirm");
    expect(r.estimatedBytes).toBeLessThan(1_000);
  });

  test("config_file pattern returns small estimate (< 8 KB)", () => {
    const p = freshPredictor();
    const r = p.predict("Read", { file_path: "package.json" });
    expect(r.pattern).toBe("config_file");
    expect(r.estimatedBytes).toBeLessThan(8_000);
  });

  test("grep_results pattern returns large estimate (> 30 KB)", () => {
    const p = freshPredictor();
    const r = p.predict("Grep", { pattern: "TODO" });
    expect(r.estimatedBytes).toBeGreaterThan(30_000);
  });

  test("test_output returns moderate estimate (10–50 KB)", () => {
    const p = freshPredictor();
    const r = p.predict("Bash", { command: "bun test" });
    expect(r.estimatedBytes).toBeGreaterThan(10_000);
    expect(r.estimatedBytes).toBeLessThan(50_000);
  });

  test("all patterns produce positive byte estimates", () => {
    const patterns: Array<[string, Record<string, unknown>]> = [
      ["Bash", { command: "find . -type f" }],
      ["Bash", { command: "grep -r foo src/" }],
      ["Bash", { command: "bun test" }],
      ["Bash", { command: "cat src/index.ts" }],
      ["Bash", { command: "git log" }],
      ["Bash", { command: "bun install" }],
      ["Read", { file_path: "package.json" }],
      ["Write", { file_path: "a.ts" }],
      ["Grep", { pattern: "x" }],
    ];
    const p = freshPredictor();
    for (const [name, input] of patterns) {
      const r = p.predict(name, input);
      expect(r.estimatedBytes).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ToolResultPredictor.predict() — history blending
// ---------------------------------------------------------------------------

describe("ToolResultPredictor.predict() — history-based blending", () => {
  beforeEach(() => ToolMetrics.resetInstance());

  test("uses history after ≥ 3 ToolMetrics samples (source = history)", () => {
    const m = ToolMetrics.getInstance();
    m.record("Bash", 500, 10);
    m.record("Bash", 600, 10);
    m.record("Bash", 700, 10);

    const p = freshPredictor();
    const r = p.predict("Bash", { command: "find . -type f" });
    // History avg ~600, max 700 → blended history << heuristic 65 KB
    expect(r.source).toBe("history");
    expect(r.estimatedBytes).toBeLessThan(20_000);
  });

  test("uses blended source for 1–2 ToolMetrics samples", () => {
    const m = ToolMetrics.getInstance();
    m.record("Bash", 800, 10);

    const p = freshPredictor();
    const r = p.predict("Bash", { command: "echo hi" });
    expect(r.source).toBe("blended");
    expect(r.confidence).toBe("low");
  });

  test("history confidence = medium for 3–9 samples", () => {
    const m = ToolMetrics.getInstance();
    for (let i = 0; i < 5; i++) m.record("Read", 4_000, 20);

    const p = freshPredictor();
    const r = p.predict("Read", { file_path: "src/index.ts" });
    expect(r.source).toBe("history");
    expect(r.confidence).toBe("medium");
  });

  test("history confidence = high for ≥ 10 samples", () => {
    const m = ToolMetrics.getInstance();
    for (let i = 0; i < 12; i++) m.record("Read", 3_000, 20);

    const p = freshPredictor();
    const r = p.predict("Read", { file_path: "src/index.ts" });
    expect(r.source).toBe("history");
    expect(r.confidence).toBe("high");
  });

  test("blended estimate is between history mean and heuristic", () => {
    const m = ToolMetrics.getInstance();
    // 2 samples only → blended
    m.record("Grep", 1_000, 5);
    m.record("Grep", 1_200, 5);

    const p = freshPredictor();
    const r = p.predict("Grep", { pattern: "foo" });
    expect(r.source).toBe("blended");
    // Heuristic is 42 KB, history avg is ~1100 → blended should be ~21 KB
    expect(r.estimatedBytes).toBeGreaterThan(500);
    expect(r.estimatedBytes).toBeLessThan(42_000);
  });
});

// ---------------------------------------------------------------------------
// Accuracy logging
// ---------------------------------------------------------------------------

describe("ToolResultPredictor accuracy logging", () => {
  test("recordActual() stores a log entry", () => {
    const p = freshPredictor();
    const prediction: PredictionResult = {
      estimatedBytes: 10_000,
      pattern: "code_dump",
      confidence: "low",
      source: "heuristic",
    };
    p.recordActual("Read", prediction, 8_000);
    const log = p.getPredictionLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.toolName).toBe("Read");
    expect(log[0]!.actualBytes).toBe(8_000);
    expect(log[0]!.estimatedBytes).toBe(10_000);
    expect(log[0]!.pattern).toBe("code_dump");
  });

  test("accuracyRatio = actual / estimated", () => {
    const p = freshPredictor();
    const prediction: PredictionResult = {
      estimatedBytes: 20_000,
      pattern: "grep_results",
      confidence: "low",
      source: "heuristic",
    };
    p.recordActual("Grep", prediction, 40_000);
    expect(p.getPredictionLog()[0]!.accuracyRatio).toBeCloseTo(2.0, 3);
  });

  test("getAccuracyStats() returns undefined when log is empty", () => {
    const p = freshPredictor();
    expect(p.getAccuracyStats()).toBeUndefined();
  });

  test("getAccuracyStats() aggregates mean ratio and over/under counts", () => {
    const p = freshPredictor();
    const makePred = (pattern: OutputPattern): PredictionResult => ({
      estimatedBytes: 10_000,
      pattern,
      confidence: "low",
      source: "heuristic",
    });

    // 3 over-predictions (actual < estimated), 1 under-prediction
    p.recordActual("Read", makePred("code_dump"), 5_000);   // ratio 0.5 → over
    p.recordActual("Read", makePred("code_dump"), 8_000);   // ratio 0.8 → over
    p.recordActual("Bash", makePred("grep_results"), 3_000); // ratio 0.3 → over
    p.recordActual("Bash", makePred("file_listing"), 25_000); // ratio 2.5 → under

    const stats = p.getAccuracyStats()!;
    expect(stats.count).toBe(4);
    expect(stats.overPredictions).toBe(3);
    expect(stats.underPredictions).toBe(1);
    expect(stats.meanRatio).toBeCloseTo((0.5 + 0.8 + 0.3 + 2.5) / 4, 3);
  });

  test("getAccuracyStats().byPattern groups entries correctly", () => {
    const p = freshPredictor();
    const makePred = (pattern: OutputPattern): PredictionResult => ({
      estimatedBytes: 10_000,
      pattern,
      confidence: "low",
      source: "heuristic",
    });

    p.recordActual("Read", makePred("code_dump"), 5_000);
    p.recordActual("Read", makePred("code_dump"), 7_000);
    p.recordActual("Bash", makePred("grep_results"), 20_000);

    const stats = p.getAccuracyStats()!;
    expect(stats.byPattern["code_dump"]!.count).toBe(2);
    expect(stats.byPattern["grep_results"]!.count).toBe(1);
    expect(stats.byPattern["code_dump"]!.meanRatio).toBeCloseTo(0.6, 3);
  });

  test("log is capped at MAX_LOG_ENTRIES (500)", () => {
    const p = freshPredictor();
    const pred: PredictionResult = {
      estimatedBytes: 1_000,
      pattern: "generic_text",
      confidence: "low",
      source: "heuristic",
    };
    for (let i = 0; i < 510; i++) {
      p.recordActual("Bash", pred, 1_000);
    }
    expect(p.getPredictionLog().length).toBeLessThanOrEqual(500);
  });

  test("resetLog() clears the prediction log", () => {
    const p = freshPredictor();
    const pred: PredictionResult = {
      estimatedBytes: 5_000,
      pattern: "code_dump",
      confidence: "low",
      source: "heuristic",
    };
    p.recordActual("Read", pred, 4_000);
    p.resetLog();
    expect(p.getPredictionLog()).toHaveLength(0);
    expect(p.getAccuracyStats()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

describe("ToolResultPredictor singleton", () => {
  test("getInstance() returns the same instance", () => {
    const a = ToolResultPredictor.getInstance();
    const b = ToolResultPredictor.getInstance();
    expect(a).toBe(b);
  });

  test("resetInstance() produces a fresh instance", () => {
    const a = ToolResultPredictor.getInstance();
    ToolResultPredictor.resetInstance();
    const b = ToolResultPredictor.getInstance();
    expect(a).not.toBe(b);
    ToolResultPredictor.resetInstance(); // clean up
  });

  test("getToolResultPredictor() returns the singleton", () => {
    expect(getToolResultPredictor()).toBe(ToolResultPredictor.getInstance());
  });

  test("create() returns isolated instances", () => {
    const a = ToolResultPredictor.create();
    const b = ToolResultPredictor.create();
    expect(a).not.toBe(b);
    expect(a).not.toBe(ToolResultPredictor.getInstance());
  });
});

// ---------------------------------------------------------------------------
// predictToolOutputSize() convenience wrapper
// ---------------------------------------------------------------------------

describe("predictToolOutputSize() convenience wrapper", () => {
  beforeEach(() => {
    ToolMetrics.resetInstance();
    ToolResultPredictor.resetInstance();
  });

  test("returns a positive byte estimate", () => {
    expect(predictToolOutputSize("Bash", { command: "find . -type f" })).toBeGreaterThan(0);
  });

  test("Write returns smaller estimate than Bash+find", () => {
    const write = predictToolOutputSize("Write", { file_path: "x.ts" });
    const find = predictToolOutputSize("Bash", { command: "find . -type f" });
    expect(write).toBeLessThan(find);
  });
});
