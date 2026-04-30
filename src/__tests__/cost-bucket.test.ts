/**
 * Tests for `CostBucket` + `BucketRegistry` — per-slug budget accounting
 * for concurrent autopilot drains.
 */

import { describe, expect, test } from "bun:test";
import {
  BucketRegistry,
  BudgetExceededError,
  CostBucket,
  budgetGuardFor,
  type CostBucketEvent,
} from "../autopilot/cost-bucket.ts";

describe("CostBucket", () => {
  test("reserve + settle accumulates spent", () => {
    const b = new CostBucket({ slug: "drake", budgetUsd: 10 });
    b.reserve(2, "llm:meanings");
    b.settle(1.8, "llm:meanings");
    b.reserve(3, "llm:themes");
    b.settle(2.5, "llm:themes");
    expect(b.spent).toBeCloseTo(4.3, 4);
    // remaining = budget - spent - lingering reservation residue.
    expect(b.remaining).toBeLessThanOrEqual(5.7);
    expect(b.remaining).toBeGreaterThanOrEqual(4.9);
    expect(b.halted).toBe(false);
  });

  test("reserve throws BudgetExceededError on projected breach", () => {
    const b = new CostBucket({ slug: "weeknd", budgetUsd: 1.0 });
    b.settle(0.8, "llm:bio");
    expect(() => b.reserve(0.5, "llm:samples")).toThrow(BudgetExceededError);
    expect(b.halted).toBe(true);
  });

  test("halt fires exactly once via onEvent", () => {
    const events: CostBucketEvent[] = [];
    const b = new CostBucket({
      slug: "beatles",
      budgetUsd: 1,
      onEvent: (ev) => events.push(ev),
    });
    b.settle(0.5, "a");
    expect(() => b.reserve(1.0, "b")).toThrow(BudgetExceededError);
    // A second breach attempt shouldn't emit another halt.
    expect(() => b.reserve(1.0, "c")).toThrow(BudgetExceededError);
    const halts = events.filter((e) => e.type === "halt");
    expect(halts.length).toBe(1);
  });

  test("warn fires once when crossing warnUsd", () => {
    const events: CostBucketEvent[] = [];
    const b = new CostBucket({
      slug: "rihanna",
      budgetUsd: 10,
      warnUsd: 5,
      onEvent: (ev) => events.push(ev),
    });
    b.settle(3, "a");
    expect(events.some((e) => e.type === "warn")).toBe(false);
    b.settle(3, "b"); // total 6, crosses warn threshold
    const warns = events.filter((e) => e.type === "warn");
    expect(warns.length).toBe(1);
    // Further settles shouldn't re-warn.
    b.settle(0.5, "c");
    expect(events.filter((e) => e.type === "warn").length).toBe(1);
  });

  test("concurrent buckets are isolated", () => {
    const a = new CostBucket({ slug: "A", budgetUsd: 10 });
    const b = new CostBucket({ slug: "B", budgetUsd: 10 });
    a.settle(8, "x");
    expect(a.spent).toBe(8);
    expect(b.spent).toBe(0);
    // A's near-breach doesn't affect B's headroom.
    expect(() => b.reserve(5, "y")).not.toThrow();
    expect(() => a.reserve(5, "y")).toThrow(BudgetExceededError);
  });

  test("budgetGuardFor closure delegates to bucket.reserve", () => {
    const b = new CostBucket({ slug: "kendrick", budgetUsd: 1 });
    const guard = budgetGuardFor(b);
    expect(() => guard(0.5, "llm:one")).not.toThrow();
    expect(() => guard(0.6, "llm:two")).toThrow(BudgetExceededError);
  });

  test("settle after halt still accumulates spent (no silent zeroing)", () => {
    const b = new CostBucket({ slug: "tyler", budgetUsd: 1 });
    try {
      b.reserve(2, "huge");
    } catch {
      /* expected */
    }
    b.settle(0.5, "salvage");
    expect(b.spent).toBe(0.5);
  });
});

describe("BucketRegistry", () => {
  test("getBucket returns same instance for same slug", () => {
    const reg = new BucketRegistry();
    const a1 = reg.getBucket("drake", 5);
    const a2 = reg.getBucket("drake", 999); // budget change ignored on re-get
    expect(a1).toBe(a2);
    expect(a1.budgetUsd).toBe(5);
  });

  test("getReport returns per-slug snapshot", () => {
    const reg = new BucketRegistry();
    const a = reg.getBucket("a", 10);
    const b = reg.getBucket("b", 20);
    a.settle(3, "x");
    b.settle(12, "y");
    const report = reg.getReport();
    expect(report.a?.spentUsd).toBe(3);
    expect(report.a?.budgetUsd).toBe(10);
    expect(report.b?.spentUsd).toBe(12);
    expect(report.b?.budgetUsd).toBe(20);
  });

  test("dispose clears buckets", () => {
    const reg = new BucketRegistry();
    reg.getBucket("a", 1);
    reg.dispose();
    expect(Object.keys(reg.getReport())).toEqual([]);
  });

  test("registry-level onEvent receives events from all buckets", () => {
    const events: CostBucketEvent[] = [];
    const reg = new BucketRegistry({ onEvent: (ev) => events.push(ev) });
    const a = reg.getBucket("a", 1);
    const b = reg.getBucket("b", 1);
    a.settle(0.5, "x");
    b.settle(0.5, "y");
    expect(events.filter((e) => e.slug === "a").length).toBeGreaterThan(0);
    expect(events.filter((e) => e.slug === "b").length).toBeGreaterThan(0);
  });
});
