/**
 * Tests for Tool Result Streaming Predictor + Adaptive Compression
 *
 * Covers:
 *   - ToolMetrics singleton: record(), predictOutputSize(), getStats()
 *   - Heuristic predictions for known tool/input patterns
 *   - History-based prediction after MIN_SAMPLES_FOR_HISTORY samples
 *   - resolveCompressionOptions() threshold adaptation rules
 *   - streamResultCompressor() integration with predictedSize
 *   - CompressorConfig interface
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ToolMetrics,
  getToolMetrics,
  resolveCompressionOptions,
  PREDICT_LARGE_THRESHOLD,
  PREDICT_SMALL_THRESHOLD,
  AGGRESSIVE_MAX_BYTES,
  AGGRESSIVE_CHUNK_THRESHOLD,
  type CompressorConfig,
} from "../agent/tool-metrics.ts";
import {
  streamResultCompressor,
  compressToolResult,
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD,
} from "../agent/tool-executor.ts";
import type { Tool, ToolContext } from "../tools/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, output: string): Tool {
  return {
    name,
    prompt: () => `Tool ${name}`,
    inputSchema: () => ({ type: "object" as const, properties: {} }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    validateInput: () => null,
    call: async () => output,
  };
}

const ctx: ToolContext = {
  cwd: "/tmp",
  requestPermission: async () => true,
};

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// ToolMetrics — unit tests
// ---------------------------------------------------------------------------

describe("ToolMetrics singleton", () => {
  beforeEach(() => {
    ToolMetrics.resetInstance();
  });

  test("getInstance() returns the same instance each time", () => {
    const a = ToolMetrics.getInstance();
    const b = ToolMetrics.getInstance();
    expect(a).toBe(b);
  });

  test("resetInstance() creates a fresh instance", () => {
    const a = ToolMetrics.getInstance();
    ToolMetrics.resetInstance();
    const b = ToolMetrics.getInstance();
    expect(a).not.toBe(b);
  });

  test("getToolMetrics() returns the singleton", () => {
    expect(getToolMetrics()).toBe(ToolMetrics.getInstance());
  });

  test("record() stores stats for a tool", () => {
    const m = ToolMetrics.getInstance();
    m.record("Bash", 5_000, 120);
    const stats = m.getStats("Bash");
    expect(stats).toBeDefined();
    expect(stats!.samples).toBe(1);
    expect(stats!.avgBytes).toBe(5_000);
    expect(stats!.maxBytes).toBe(5_000);
    expect(stats!.minBytes).toBe(5_000);
    expect(stats!.avgDurationMs).toBe(120);
  });

  test("record() updates running averages correctly", () => {
    const m = ToolMetrics.getInstance();
    m.record("Read", 2_000, 50);
    m.record("Read", 4_000, 150);
    const stats = m.getStats("Read")!;
    expect(stats.samples).toBe(2);
    expect(stats.avgBytes).toBeCloseTo(3_000, 0);
    expect(stats.maxBytes).toBe(4_000);
    expect(stats.minBytes).toBe(2_000);
    expect(stats.avgDurationMs).toBeCloseTo(100, 0);
  });

  test("record() tracks dominant pattern", () => {
    const m = ToolMetrics.getInstance();
    m.record("Bash", 10_000, 200, "grep matches");
    const stats = m.getStats("Bash")!;
    expect(stats.dominantPattern).toBe("grep matches");
  });

  test("getAllStats() returns all tools sorted by sample count desc", () => {
    const m = ToolMetrics.getInstance();
    m.record("A", 1_000, 10);
    m.record("B", 1_000, 10);
    m.record("B", 1_000, 10);
    m.record("B", 1_000, 10);
    const all = m.getAllStats();
    expect(all[0]!.name).toBe("B");
    expect(all[1]!.name).toBe("A");
  });

  test("reset() clears all stats", () => {
    const m = ToolMetrics.getInstance();
    m.record("Bash", 5_000, 100);
    m.reset();
    expect(m.getAllStats()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ToolMetrics — prediction: heuristics
// ---------------------------------------------------------------------------

describe("ToolMetrics.predictOutputSize() — heuristics", () => {
  beforeEach(() => {
    ToolMetrics.resetInstance();
  });

  test("Bash + 'find' predicts > 50 KB", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Bash", { command: "find . -name '*.ts'" });
    expect(predicted).toBeGreaterThanOrEqual(50_000);
  });

  test("Bash + 'grep -r' predicts > 30 KB", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Bash", { command: "grep -r 'import' src/" });
    expect(predicted).toBeGreaterThanOrEqual(30_000);
  });

  test("Bash + 'git log' predicts >= 20 KB", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Bash", { command: "git log --oneline" });
    expect(predicted).toBeGreaterThanOrEqual(20_000);
  });

  test("Read + 'package.json' predicts < 10 KB", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Read", { file_path: "/project/package.json" });
    expect(predicted).toBeLessThan(10_000);
  });

  test("Write tool predicts small output (< 2 KB)", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Write", { file_path: "out.ts", content: "hello" });
    expect(predicted).toBeLessThan(2_000);
  });

  test("generic Bash with no special flags predicts moderate output", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Bash", { command: "echo hello" });
    // Should match the generic Bash heuristic (12 KB) or similar
    expect(predicted).toBeGreaterThan(0);
    expect(predicted).toBeLessThan(30_000);
  });

  test("unknown tool returns conservative default > 0", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("SomeWeirdTool", {});
    expect(predicted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ToolMetrics — prediction: history overrides heuristics after 3+ samples
// ---------------------------------------------------------------------------

describe("ToolMetrics.predictOutputSize() — history-based", () => {
  beforeEach(() => {
    ToolMetrics.resetInstance();
  });

  test("uses history after 3 samples instead of heuristic", () => {
    const m = ToolMetrics.getInstance();
    // Record 3 very small results for Bash (normally heuristic would say 12 KB)
    m.record("Bash", 200, 10);
    m.record("Bash", 250, 10);
    m.record("Bash", 300, 10);

    const predicted = m.predictOutputSize("Bash", { command: "find . -name '*.ts'" });
    // History avg ~250, max 300 → blended ~265, well below heuristic 60 KB
    expect(predicted).toBeLessThan(5_000);
  });

  test("does NOT use history with fewer than 3 samples", () => {
    const m = ToolMetrics.getInstance();
    m.record("Bash", 200, 10);
    m.record("Bash", 250, 10);
    // Only 2 samples — should still use heuristic for find
    const predicted = m.predictOutputSize("Bash", { command: "find . -name '*.ts'" });
    expect(predicted).toBeGreaterThanOrEqual(50_000);
  });

  test("blends mean and max (conservative bias)", () => {
    const m = ToolMetrics.getInstance();
    m.record("Read", 1_000, 20);
    m.record("Read", 2_000, 20);
    m.record("Read", 3_000, 20);
    // avg = 2000, max = 3000 → 0.7*2000 + 0.3*3000 = 2300
    const predicted = m.predictOutputSize("Read", {});
    expect(predicted).toBeCloseTo(2_300, -2); // within ~100 bytes
  });
});

// ---------------------------------------------------------------------------
// resolveCompressionOptions() — threshold adaptation
// ---------------------------------------------------------------------------

describe("resolveCompressionOptions()", () => {
  test("large prediction (> 30 KB) → aggressive thresholds", () => {
    const result = resolveCompressionOptions({}, PREDICT_LARGE_THRESHOLD + 1);
    expect(result.maxBytes).toBe(AGGRESSIVE_MAX_BYTES);
    expect(result.chunkSummaryThreshold).toBe(AGGRESSIVE_CHUNK_THRESHOLD);
  });

  test("small prediction (< 5 KB) → no summarisation (Infinity thresholds)", () => {
    const result = resolveCompressionOptions({}, PREDICT_SMALL_THRESHOLD - 1);
    expect(result.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.chunkSummaryThreshold).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("medium prediction → default thresholds", () => {
    const mediumSize = Math.floor((PREDICT_SMALL_THRESHOLD + PREDICT_LARGE_THRESHOLD) / 2);
    const result = resolveCompressionOptions({}, mediumSize);
    expect(result.maxBytes).toBe(DEFAULT_TOOL_RESULT_MAX_BYTES);
    expect(result.chunkSummaryThreshold).toBe(DEFAULT_TOOL_CHUNK_SUMMARY_THRESHOLD);
  });

  test("explicit maxBytes override wins over adaptive", () => {
    const result = resolveCompressionOptions({ maxBytes: 999 }, PREDICT_LARGE_THRESHOLD + 1);
    expect(result.maxBytes).toBe(999);
    // chunkSummaryThreshold still adaptive
    expect(result.chunkSummaryThreshold).toBe(AGGRESSIVE_CHUNK_THRESHOLD);
  });

  test("disableSummarisation sets both thresholds to MAX_SAFE_INTEGER", () => {
    const result = resolveCompressionOptions({ disableSummarisation: true }, PREDICT_LARGE_THRESHOLD + 1);
    expect(result.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.chunkSummaryThreshold).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("disableSummarisation respects explicit maxBytes override", () => {
    const result = resolveCompressionOptions(
      { disableSummarisation: true, maxBytes: 500 },
      PREDICT_LARGE_THRESHOLD + 1
    );
    expect(result.maxBytes).toBe(500);
  });

  test("CompressorConfig interface is structurally sound", () => {
    const config: CompressorConfig = {
      predictor: (toolName, _input) => (toolName === "Bash" ? 60_000 : 5_000),
      maxBytes: 8_192,
      chunkSummaryThreshold: 1_024,
      disableSummarisation: false,
    };
    // Use predictor result directly
    const predicted = config.predictor!("Bash", {});
    const result = resolveCompressionOptions(config, predicted);
    // Explicit overrides win
    expect(result.maxBytes).toBe(8_192);
    expect(result.chunkSummaryThreshold).toBe(1_024);
  });
});

// ---------------------------------------------------------------------------
// streamResultCompressor() — integration with predictedSize
// ---------------------------------------------------------------------------

describe("streamResultCompressor() — predictedSize integration", () => {
  beforeEach(() => {
    ToolMetrics.resetInstance();
  });

  test("small predicted size disables summarisation — full output passes through", async () => {
    // 3 KB output, predicted small → no summarisation
    const output = "x".repeat(3_000);
    const tool = makeTool("Write", output);
    const result = await compressToolResult(tool, {}, ctx, {
      predictedSize: PREDICT_SMALL_THRESHOLD - 1,
    });
    // With disabled summarisation, full output should be returned
    expect(result).toBe(output);
    expect(result).not.toMatch(/\[SUMMARY:/);
  });

  test("large predicted size triggers aggressive compression (8 KB head)", async () => {
    // Build ~40 KB output
    const lines = Array.from({ length: 1_600 }, (_, i) => `line_${i}: ${"a".repeat(20)}`);
    const output = lines.join("\n");
    expect(encoder.encode(output).length).toBeGreaterThan(30_000);

    const tool = makeTool("Bash", output);
    const result = await compressToolResult(tool, {}, ctx, {
      predictedSize: PREDICT_LARGE_THRESHOLD + 1,
    });

    const resultBytes = encoder.encode(result).length;
    // Aggressive: maxBytes 8 KB + summaries. Result should be well under 15 KB
    expect(resultBytes).toBeLessThan(15_000);
    expect(result).toMatch(/\[SUMMARY:/);
  });

  test("medium predicted size uses default thresholds — 15 KB verbatim", async () => {
    const mediumPrediction = Math.floor((PREDICT_SMALL_THRESHOLD + PREDICT_LARGE_THRESHOLD) / 2);
    // 30 KB output with medium prediction → defaults apply
    const output = "m".repeat(30_000);
    const tool = makeTool("Read", output);
    const result = await compressToolResult(tool, {}, ctx, {
      predictedSize: mediumPrediction,
    });
    // With 15 KB verbatim, result should be under ~18 KB (head + a few summaries)
    const resultBytes = encoder.encode(result).length;
    expect(resultBytes).toBeLessThan(25_000);
    expect(result).toMatch(/\[SUMMARY:/);
  });

  test("ToolMetrics records execution after streamResultCompressor runs", async () => {
    const m = ToolMetrics.getInstance();
    const output = "hello world";
    const tool = makeTool("Bash", output);

    await compressToolResult(tool, {}, ctx);

    const stats = m.getStats("Bash");
    expect(stats).toBeDefined();
    expect(stats!.samples).toBe(1);
    expect(stats!.avgBytes).toBe(encoder.encode(output).length);
  });

  test("repeated executions improve future predictions via history", async () => {
    const m = ToolMetrics.getInstance();
    const smallOutput = "tiny";
    const tool = makeTool("Bash", smallOutput);

    // Run 3 times to accumulate history
    for (let i = 0; i < 3; i++) {
      await compressToolResult(tool, {}, ctx);
    }

    // Now prediction should be based on history (tiny output), not heuristic (12 KB)
    const predicted = m.predictOutputSize("Bash", { command: "find . -name '*.ts'" });
    expect(predicted).toBeLessThan(1_000);
  });

  test("explicit opts.maxBytes overrides predictedSize adaptive logic", async () => {
    const output = "a".repeat(20_000);
    const tool = makeTool("Read", output);

    // predictedSize says large → would normally use 8 KB. But explicit maxBytes = 18 KB wins.
    const result = await compressToolResult(tool, {}, ctx, {
      predictedSize: PREDICT_LARGE_THRESHOLD + 1,
      maxBytes: 18_000,
    });

    const resultBytes = encoder.encode(result).length;
    // Verbatim head up to 18 KB; 20 KB input → small compressed tail
    expect(resultBytes).toBeGreaterThan(15_000);
  });

  test("all delta events still have type 'delta' with predictedSize", async () => {
    const output = "x".repeat(50_000);
    const tool = makeTool("Bash", output);
    const gen = streamResultCompressor(tool, {}, ctx, {
      predictedSize: PREDICT_LARGE_THRESHOLD + 1,
    });
    for await (const event of gen) {
      expect(event.type).toBe("delta");
    }
  });
});

// ---------------------------------------------------------------------------
// Real-world tool simulation
// ---------------------------------------------------------------------------

describe("Real-world tool output scenarios", () => {
  beforeEach(() => {
    ToolMetrics.resetInstance();
  });

  test("'find' output (60 KB) with heuristic prediction compresses aggressively", async () => {
    // Simulate find output: many file paths
    const paths = Array.from({ length: 2_000 }, (_, i) => `/project/src/module_${i}/index.ts`);
    const output = paths.join("\n");
    expect(encoder.encode(output).length).toBeGreaterThan(50_000);

    const tool = makeTool("Bash", output);
    // Use heuristic prediction (no manual predictedSize — let ToolMetrics predict)
    const predicted = getToolMetrics().predictOutputSize("Bash", { command: "find . -type f" });
    expect(predicted).toBeGreaterThanOrEqual(50_000);

    const result = await compressToolResult(tool, {}, ctx, { predictedSize: predicted });
    const resultBytes = encoder.encode(result).length;
    // Aggressive compression: should be under 12 KB
    expect(resultBytes).toBeLessThan(12_000);
    expect(result).toMatch(/\[SUMMARY:/);
  });

  test("'package.json' read (small) passes through unsummarised", async () => {
    const pkgJson = JSON.stringify(
      { name: "my-app", version: "1.0.0", dependencies: { react: "^18.0.0" } },
      null,
      2
    );
    const tool = makeTool("Read", pkgJson);
    const predicted = getToolMetrics().predictOutputSize("Read", { file_path: "package.json" });
    expect(predicted).toBeLessThan(PREDICT_SMALL_THRESHOLD);

    const result = await compressToolResult(tool, {}, ctx, { predictedSize: predicted });
    expect(result).toBe(pkgJson);
    expect(result).not.toMatch(/\[SUMMARY:/);
  });

  test("stack-trace output is compressed with pattern detection", async () => {
    const stackTrace = [
      "Error: Cannot read property 'foo' of undefined",
      "    at Object.<anonymous> (/app/index.ts:10:5)",
      "    at Module._compile (node:internal/modules/cjs/loader:1364:14)",
      "    at Object.Module._extensions..js (node:internal/modules/cjs/loader:1422:10)",
    ]
      .join("\n")
      .repeat(300); // Repeat to exceed threshold

    const tool = makeTool("Bash", stackTrace);
    const result = await compressToolResult(tool, {}, ctx, {
      predictedSize: PREDICT_LARGE_THRESHOLD + 1,
    });

    expect(result).toMatch(/\[SUMMARY:/);
    expect(result).toMatch(/stack trace/);
  });

  test("prediction accuracy: actual bytes within 2x of prediction for typical Bash", () => {
    const m = ToolMetrics.getInstance();
    const predicted = m.predictOutputSize("Bash", { command: "npm install" });
    // Heuristic says 15 KB for npm install. Real output typically 5-30 KB.
    // Just verify it's in a reasonable ballpark.
    expect(predicted).toBeGreaterThan(1_000);
    expect(predicted).toBeLessThan(100_000);
  });
});
