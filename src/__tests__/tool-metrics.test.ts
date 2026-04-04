import { describe, test, expect, beforeEach } from "bun:test";
import {
  getToolMetrics,
  formatToolMetrics,
  resetToolMetrics,
} from "../agent/tool-executor.ts";

// We can't easily call recordToolMetric directly (not exported),
// but we can test the public API surface.

describe("Tool Execution Metrics", () => {
  beforeEach(() => {
    resetToolMetrics();
  });

  test("getToolMetrics returns empty array initially", () => {
    expect(getToolMetrics()).toEqual([]);
  });

  test("formatToolMetrics handles empty state", () => {
    expect(formatToolMetrics()).toBe("No tool calls recorded.");
  });

  test("resetToolMetrics clears all metrics", () => {
    // After reset, should be empty
    resetToolMetrics();
    expect(getToolMetrics()).toHaveLength(0);
  });
});
