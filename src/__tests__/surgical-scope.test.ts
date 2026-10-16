/**
 * Tests for surgical-scope.ts — intent-aware scope detection + file-count guard.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  detectSurgicalScope,
  checkFileCountGuard,
  revertToPreSurgicalSnapshot,
  type SurgicalScope,
} from "../agent/surgical-scope.ts";

/* ── detectSurgicalScope ─────────────────────────────────────────── */

describe("detectSurgicalScope", () => {
  describe("narrow tier — fix/typo/null-check signals", () => {
    const narrowCases: [string, string][] = [
      ["fix typo in README", "fix typo"],
      ["typo on line 42", "typo"],
      ["null check for user param", "null check"],
      ["undefined check on token", "undefined check"],
      ["off-by-one in loop counter", "off-by-one"],
      ["off by one error in index", "off by one"],
      ["fix bug in parser", "fix bug"],
      ["fix crash on empty input", "fix crash"],
      ["add a one-line comment", "one-line"],
      ["one line change to config", "one line"],
      ["patch the version string", "patch"],
    ];

    for (const [goal, expectedSignal] of narrowCases) {
      it(`"${goal}" → narrow (budget 1)`, () => {
        const scope = detectSurgicalScope(goal);
        expect(scope.scopeTier).toBe("narrow");
        expect(scope.fileBudget).toBe(1);
        expect(scope.scopeLabel).toContain(expectedSignal);
      });
    }
  });

  describe("medium tier — fix-test/add-function/fix signals", () => {
    const mediumCases: [string, string][] = [
      ["fix failing test for auth module", "fix failing test"],
      ["add test for the login handler", "add test"],
      ["fix import path in utils", "fix import"],
      ["update export from index", "update export"],
      ["add function to parse dates", "add function"],
      ["fix interface for User type", "fix interface"],
      ["fix method signature", "fix method"],
    ];

    for (const [goal, expectedSignal] of mediumCases) {
      it(`"${goal}" → medium (budget 3)`, () => {
        const scope = detectSurgicalScope(goal);
        expect(scope.scopeTier).toBe("medium");
        expect(scope.fileBudget).toBe(3);
        expect(scope.scopeLabel).toContain(expectedSignal);
      });
    }
  });

  describe("wide tier — refactor/add-feature/across signals", () => {
    const wideCases: [string, string][] = [
      ["refactor the auth module", "refactor"],
      ["add feature to support OAuth", "add feature"],
      ["new feature: dark mode", "new feature"],
      ["implement the payment flow", "implement"],
      ["migrate database schema", "migrate"],
      ["update all files to use new API", "all files"],
      ["replace all usages of oldFn", "replace all"],
      ["fix across the codebase", "across"],
      ["reorganize the folder structure", "reorganize"],
      ["rewrite the routing layer", "rewrite"],
    ];

    for (const [goal, expectedSignal] of wideCases) {
      it(`"${goal}" → wide (budget 6)`, () => {
        const scope = detectSurgicalScope(goal);
        expect(scope.scopeTier).toBe("wide");
        expect(scope.fileBudget).toBe(6);
        expect(scope.scopeLabel).toContain(expectedSignal);
      });
    }
  });

  describe("wide dominates narrow", () => {
    it("'refactor to fix typo' → wide (wide signal wins)", () => {
      const scope = detectSurgicalScope("refactor to fix typo");
      expect(scope.scopeTier).toBe("wide");
      expect(scope.fileBudget).toBe(6);
    });

    it("'add feature: fix null check' → wide (wide signal wins)", () => {
      const scope = detectSurgicalScope("add feature: fix null check");
      expect(scope.scopeTier).toBe("wide");
    });
  });

  describe("default fallback", () => {
    it("unrecognized goal → medium default", () => {
      const scope = detectSurgicalScope("do something useful with the project");
      expect(scope.scopeTier).toBe("medium");
      expect(scope.fileBudget).toBe(3);
      expect(scope.scopeLabel).toContain("default");
    });
  });

  describe("case insensitivity", () => {
    it("uppercase goal matches narrow signal", () => {
      const scope = detectSurgicalScope("FIX TYPO IN DOCS");
      expect(scope.scopeTier).toBe("narrow");
    });

    it("mixed-case refactor matches wide", () => {
      const scope = detectSurgicalScope("Refactor the authentication module");
      expect(scope.scopeTier).toBe("wide");
    });
  });
});

/* ── checkFileCountGuard ─────────────────────────────────────────── */

describe("checkFileCountGuard", () => {
  // We mock Bun.spawn to avoid requiring a real git repo.
  const originalSpawn = Bun.spawn;

  afterEach(() => {
    // Restore after each test
    (Bun as any).spawn = originalSpawn;
  });

  function mockSpawnWithOutput(output: string, exitCode = 0) {
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      stdout: new Response(output).body,
      stderr: new Response("").body,
      exited: Promise.resolve(exitCode),
    });
  }

  it("within budget — 1 file touched, narrow scope (budget 1)", async () => {
    mockSpawnWithOutput("src/foo.ts\n");
    const scope = detectSurgicalScope("fix typo in foo");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.withinBudget).toBe(true);
    expect(result.filesChanged).toBe(1);
    expect(result.fileBudget).toBe(1);
  });

  it("overshoot — 2 files touched, narrow scope (budget 1)", async () => {
    mockSpawnWithOutput("src/foo.ts\nsrc/bar.ts\n");
    const scope = detectSurgicalScope("fix typo in foo");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.withinBudget).toBe(false);
    expect(result.filesChanged).toBe(2);
    expect(result.fileBudget).toBe(1);
  });

  it("within budget — 3 files touched, medium scope (budget 3)", async () => {
    mockSpawnWithOutput("src/a.ts\nsrc/b.ts\nsrc/c.ts\n");
    const scope = detectSurgicalScope("fix failing test for auth");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.withinBudget).toBe(true);
    expect(result.filesChanged).toBe(3);
  });

  it("overshoot — 4 files touched, medium scope (budget 3)", async () => {
    mockSpawnWithOutput("a.ts\nb.ts\nc.ts\nd.ts\n");
    const scope = detectSurgicalScope("fix failing test for auth");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.withinBudget).toBe(false);
    expect(result.filesChanged).toBe(4);
  });

  it("within budget — 6 files touched, wide scope (budget 6)", async () => {
    mockSpawnWithOutput("a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n");
    const scope = detectSurgicalScope("refactor the auth module");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.withinBudget).toBe(true);
    expect(result.filesChanged).toBe(6);
  });

  it("overshoot — 7 files touched, wide scope (budget 6)", async () => {
    mockSpawnWithOutput("a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\ng.ts\n");
    const scope = detectSurgicalScope("refactor the auth module");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.withinBudget).toBe(false);
    expect(result.filesChanged).toBe(7);
  });

  it("git error returns 0 files — always within budget", async () => {
    (Bun as any).spawn = () => { throw new Error("git not found"); };
    const scope = detectSurgicalScope("fix typo");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.filesChanged).toBe(0);
    expect(result.withinBudget).toBe(true);
  });

  it("empty diff output — 0 files", async () => {
    mockSpawnWithOutput("");
    const scope = detectSurgicalScope("fix typo");
    const result = await checkFileCountGuard("/tmp/fake", scope);
    expect(result.filesChanged).toBe(0);
    expect(result.withinBudget).toBe(true);
  });
});

/* ── revertToPreSurgicalSnapshot ─────────────────────────────────── */

describe("revertToPreSurgicalSnapshot", () => {
  const originalSpawn = Bun.spawn;

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  it("returns true when git stash exits 0", async () => {
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      stdout: new Response("Saved working directory").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    });
    const ok = await revertToPreSurgicalSnapshot("/tmp/fake", "fix typo in README");
    expect(ok).toBe(true);
  });

  it("returns false when git stash exits non-zero", async () => {
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      stdout: new Response("").body,
      stderr: new Response("nothing to stash").body,
      exited: Promise.resolve(1),
    });
    const ok = await revertToPreSurgicalSnapshot("/tmp/fake", "fix typo in README");
    expect(ok).toBe(false);
  });

  it("returns false on spawn error", async () => {
    (Bun as any).spawn = () => { throw new Error("spawn failed"); };
    const ok = await revertToPreSurgicalSnapshot("/tmp/fake", "fix typo");
    expect(ok).toBe(false);
  });
});
