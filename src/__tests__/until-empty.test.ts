/**
 * Tests for runUntilEmpty drain mode.
 *
 * Uses the `mockExecutor` seam and overrides the config dir via
 * `setConfigDirForTests` so queue + report paths land in a tmpdir.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setConfigDirForTests } from "../config/settings.ts";
import { WorkQueue } from "../autopilot/queue.ts";
import type { WorkItem } from "../autopilot/types.ts";
import { runUntilEmpty } from "../autopilot/until-empty.ts";
import { createDrainLogger } from "../autopilot/drain-logger.ts";

let tmpCfg: string;
const PROJECT_CWD = "/tmp/until-empty-fake-project";

function makeItem(slug: string): WorkItem {
  return {
    id: `artist-build:${slug}`,
    type: "artist_build",
    priority: "high",
    title: `build-artist: ${slug}`,
    description: `Build ${slug}`,
    file: `artists/${slug}.json`,
    line: 1,
    status: "discovered",
    discoveredAt: new Date().toISOString(),
    slug,
  };
}

function quietLogger() {
  const out: string[] = [];
  return { logger: createDrainLogger({ tty: false, write: (s) => out.push(s) }), out };
}

beforeEach(() => {
  tmpCfg = mkdtempSync(join(tmpdir(), "ashlrcode-untilempty-"));
  setConfigDirForTests(tmpCfg);
});

afterEach(() => {
  setConfigDirForTests(null);
  try {
    rmSync(tmpCfg, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("runUntilEmpty", () => {
  test("three-item queue with mock executor: all succeed", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("drake"), makeItem("weeknd"), makeItem("rihanna")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      env: { ANTHROPIC_API_KEY: "x" }, // keeps deploy-deferral off-path
      mockExecutor: async () => ({ status: "success", durationMs: 5, costUsd: 0.42 }),
    });

    expect(report.totalProcessed).toBe(3);
    expect(report.byStatus.success).toBe(3);
    expect(report.byStatus.failed).toBe(0);
    expect(report.byStatus.deferred).toBe(0);
    expect(report.totalCostUsd).toBeCloseTo(1.26, 2);
    expect(report.perArtist.map((a) => a.slug).sort()).toEqual([
      "drake",
      "rihanna",
      "weeknd",
    ]);
  });

  test("item 2 throws → drain continues, 1 failed / 2 success", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("a"), makeItem("b"), makeItem("c")]);
    await q.save();

    let n = 0;
    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => {
        n++;
        if (n === 2) throw new Error("boom");
        return { status: "success", durationMs: 1, costUsd: 0 };
      },
    });

    expect(report.totalProcessed).toBe(3);
    expect(report.byStatus.success).toBe(2);
    expect(report.byStatus.failed).toBe(1);
    const failed = report.perArtist.find((a) => a.status === "failed");
    expect(failed?.error).toContain("boom");
  });

  test("--require-deploy-env with missing VERCEL_TOKEN defers all items", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("x"), makeItem("y")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      requireDeployEnv: true,
      env: {}, // all deploy caps missing
      mockExecutor: async () => ({ status: "success", durationMs: 1, costUsd: 0 }),
    });

    expect(report.byStatus.deferred).toBe(2);
    expect(report.byStatus.success).toBe(0);
    for (const a of report.perArtist) {
      expect(a.status).toBe("deferred");
      expect(a.warnings.join(" ")).toContain("canDeployVercel");
    }
  });

  test("markdown report contains a row per artist", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("alpha"), makeItem("beta")]);
    await q.save();

    const { logger } = quietLogger();
    await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => ({ status: "success", durationMs: 1, costUsd: 0 }),
    });

    // Find the markdown report — path uses a hash of PROJECT_CWD
    const autopilotDir = join(tmpCfg, "autopilot");
    const files = await (await import("fs/promises")).readdir(autopilotDir);
    const md = files.find((f) => f.endsWith(".report.md"));
    expect(md).toBeDefined();
    const content = readFileSync(join(autopilotDir, md!), "utf-8");
    expect(content).toContain("| alpha |");
    expect(content).toContain("| beta |");
    expect(content).toContain("# Autopilot Drain Report");
  });

  test("budgetUsdPerArtist flows into executor input", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("kendrick")]);
    await q.save();

    let seenBudget: number | undefined;
    const { logger } = quietLogger();
    await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      budgetUsdPerArtist: 7.5,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async ({ budgetUsd }) => {
        seenBudget = budgetUsd;
        return { status: "success", durationMs: 1, costUsd: 0 };
      },
    });
    expect(seenBudget).toBe(7.5);
  });

  test("concurrency: 3 drains 5 × 50ms items in ~2 waves (~100ms), not serial (~250ms)", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([
      makeItem("a"),
      makeItem("b"),
      makeItem("c"),
      makeItem("d"),
      makeItem("e"),
    ]);
    await q.save();

    const { logger } = quietLogger();
    const start = Date.now();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      concurrency: 3,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { status: "success", durationMs: 50, costUsd: 0 };
      },
    });
    const elapsed = Date.now() - start;

    expect(report.totalProcessed).toBe(5);
    expect(report.byStatus.success).toBe(5);
    // Serial would be ~250ms. 3-way parallel should be ~100ms (ceil(5/3) = 2 waves).
    // Allow generous slack for CI jitter but catch a regression to serial.
    expect(elapsed).toBeLessThan(200);
  });

  test("concurrency: fast item finishes before slow item", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("slow"), makeItem("fast")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      concurrency: 2,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async ({ slug }) => {
        const delay = slug === "slow" ? 80 : 10;
        await new Promise((r) => setTimeout(r, delay));
        return { status: "success", durationMs: delay, costUsd: 0 };
      },
    });

    // Completion order: fast first, then slow.
    expect(report.perArtist[0]?.slug).toBe("fast");
    expect(report.perArtist[1]?.slug).toBe("slow");
  });

  test("concurrency: 1 keeps existing serial behavior (completion order = seed order)", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("first"), makeItem("second"), makeItem("third")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      concurrency: 1,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => ({ status: "success", durationMs: 1, costUsd: 0 }),
    });

    expect(report.perArtist.map((a) => a.slug)).toEqual(["first", "second", "third"]);
  });

  test("concurrency: 0 or negative is coerced to 1", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("only")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      concurrency: 0,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => ({ status: "success", durationMs: 1, costUsd: 0 }),
    });
    expect(report.totalProcessed).toBe(1);

    const q2 = new WorkQueue(PROJECT_CWD);
    await q2.load();
    q2.addItems([makeItem("two")]);
    await q2.save();
    const { logger: l2 } = quietLogger();
    const r2 = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger: l2,
      concurrency: -5,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => ({ status: "success", durationMs: 1, costUsd: 0 }),
    });
    expect(r2.totalProcessed).toBe(1);
  });

  test("per-slug bucket: concurrent drain with tiny budget fails all items independently", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("a"), makeItem("b"), makeItem("c")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      concurrency: 3,
      budgetUsdPerArtist: 0.001,
      env: { ANTHROPIC_API_KEY: "x" },
      // Mock executor simulates a tool run that spends $0.50 (way over
      // the $0.001 budget). It settles into the bucket, then attempts a
      // reservation that should throw BudgetExceededError.
      mockExecutor: async ({ slug, bucket }) => {
        expect(bucket).toBeDefined();
        expect(bucket!.slug).toBe(slug);
        // Attempting to reserve $0.50 against a $0.001 budget throws.
        bucket!.reserve(0.5, "llm:bigcall");
        // Unreachable — reserve throws above.
        return { status: "success", durationMs: 1, costUsd: 0 };
      },
    });

    expect(report.totalProcessed).toBe(3);
    expect(report.byStatus.failed).toBe(3);
    expect(report.byStatus.success).toBe(0);
    for (const a of report.perArtist) {
      expect(a.error ?? "").toContain("budget exceeded");
      expect(a.error ?? "").toContain(a.slug);
    }
    // Each slug's bucket is independent — no shared halt.
    const slugs = report.perArtist.map((a) => a.slug).sort();
    expect(slugs).toEqual(["a", "b", "c"]);
  });

  test("per-slug bucket: costUsd reflects bucket.spent, not readCostFor", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("x")]);
    await q.save();

    const { logger } = quietLogger();
    const report = await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      budgetUsdPerArtist: 5,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async ({ bucket }) => {
        bucket!.settle(1.25, "llm:bio");
        return { status: "success", durationMs: 1, costUsd: 999 /* should be ignored */ };
      },
    });
    expect(report.perArtist[0]?.costUsd).toBeCloseTo(1.25, 4);
  });

  test("progress ndjson file written", async () => {
    const q = new WorkQueue(PROJECT_CWD);
    await q.load();
    q.addItems([makeItem("one")]);
    await q.save();

    const { logger } = quietLogger();
    await runUntilEmpty({
      cwd: PROJECT_CWD,
      logger,
      env: { ANTHROPIC_API_KEY: "x" },
      mockExecutor: async () => ({ status: "success", durationMs: 1, costUsd: 0 }),
    });

    const autopilotDir = join(tmpCfg, "autopilot");
    const files = await (await import("fs/promises")).readdir(autopilotDir);
    const ndjson = files.find((f) => f.endsWith(".progress.ndjson"));
    expect(ndjson).toBeDefined();
    expect(existsSync(join(autopilotDir, ndjson!))).toBe(true);
    const lines = readFileSync(join(autopilotDir, ndjson!), "utf-8").trim().split("\n");
    // started + status entry per item
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
