import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  recordStep,
  loadTimeline,
  listTimelines,
  forkFrom,
  isTimeTravelEnabled,
  resetTimeTravelCache,
} from "../agent/time-travel.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-tt-test-"));
  setConfigDirForTests(configDir);
  resetTimeTravelCache();
  // Force-enable via env so we don't depend on a settings.json file.
  process.env.ASHLRCODE_TIME_TRAVEL = "1";
});

afterEach(() => {
  delete process.env.ASHLRCODE_TIME_TRAVEL;
  resetTimeTravelCache();
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

function step(index: number, over: Partial<{ toolName: string; result: string }> = {}) {
  return {
    index,
    toolName: over.toolName ?? "read",
    args: { file_path: `/x/${index}.ts` },
    result: over.result ?? `result-${index}`,
    // Skip git capture for determinism — pass a fake treeSha.
    treeSha: `sha-${index}`,
  };
}

describe("flag gating", () => {
  test("env=0 disables recording", async () => {
    process.env.ASHLRCODE_TIME_TRAVEL = "0";
    resetTimeTravelCache();
    expect(isTimeTravelEnabled()).toBe(false);
    await recordStep("s-disabled", step(0));
    expect(await loadTimeline("s-disabled")).toEqual([]);
  });

  test("env=1 enables recording", () => {
    expect(isTimeTravelEnabled()).toBe(true);
  });
});

describe("recordStep + loadTimeline", () => {
  test("appends steps in order", async () => {
    await recordStep("sess-a", step(0));
    await recordStep("sess-a", step(1, { toolName: "edit" }));
    await recordStep("sess-a", step(2));

    const tl = await loadTimeline("sess-a");
    expect(tl.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(tl[1]!.toolName).toBe("edit");
    expect(tl[0]!.tree.sha).toBe("sha-0");
    expect(tl[0]!.at).toBeTruthy();
  });

  test("clamps oversized results", async () => {
    await recordStep("sess-big", step(0, { result: "x".repeat(20_000) }));
    const tl = await loadTimeline("sess-big");
    expect(tl[0]!.result.length).toBeLessThan(20_000);
    expect(tl[0]!.result).toContain("chars]");
  });

  test("never throws on empty sessionId", async () => {
    await expect(recordStep("", step(0))).resolves.toBeUndefined();
  });

  test("missing timeline loads as empty", async () => {
    expect(await loadTimeline("nope")).toEqual([]);
  });

  test("listTimelines reports recorded sessions", async () => {
    await recordStep("sess-1", step(0));
    await recordStep("sess-2", step(0));
    const list = await listTimelines();
    expect(list.sort()).toEqual(["sess-1", "sess-2"]);
  });
});

describe("forkFrom", () => {
  test("seeds a new session from a prefix of the parent", async () => {
    for (let i = 0; i < 5; i++) await recordStep("parent", step(i));

    const fork = await forkFrom("parent", 2);
    expect(fork).not.toBeNull();
    expect(fork!.fromIndex).toBe(2);
    expect(fork!.steps).toBe(3);
    expect(fork!.tree.sha).toBe("sha-2");

    const forked = await loadTimeline(fork!.sessionId);
    expect(forked.map((s) => s.index)).toEqual([0, 1, 2]);

    // Parent is untouched — branchable.
    expect((await loadTimeline("parent")).length).toBe(5);
  });

  test("forking the same point twice yields independent branches", async () => {
    for (let i = 0; i < 3; i++) await recordStep("p", step(i));
    const a = await forkFrom("p", 1);
    const b = await forkFrom("p", 1);
    expect(a!.sessionId).not.toBe(b!.sessionId);
    expect((await loadTimeline(a!.sessionId)).length).toBe(2);
    expect((await loadTimeline(b!.sessionId)).length).toBe(2);
  });

  test("returns null for missing source or out-of-range index", async () => {
    expect(await forkFrom("ghost", 0)).toBeNull();
    await recordStep("only0", step(0));
    expect(await forkFrom("only0", -1)).toBeNull();
  });
});
