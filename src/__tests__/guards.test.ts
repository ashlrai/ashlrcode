/**
 * Tests for autonomous safety guards:
 *   - BinShield install gate (src/tools/guards/binshield-gate.ts)
 *   - Phantom-seal wrapper (src/tools/guards/phantom-seal.ts)
 *   - bash.ts integration (both guards wired into call())
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseInstallCommand,
  checkBinshieldGate,
  type BinshieldGateOptions,
} from "../tools/guards/binshield-gate.ts";

import {
  applyPhantomSeal,
  _resetPhantomPathCache,
} from "../tools/guards/phantom-seal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GuardFixtureMode = "disabled" | "critical" | "safe" | "unreachable" | "phantom";
interface GuardFixtureResult {
  output: string;
  scans: Array<{ url: string; body: Record<string, unknown> }>;
  marker: string | null;
  networkRequests: number;
  wrapped?: boolean;
  command?: string;
}

async function runGuardFixture(mode: GuardFixtureMode): Promise<GuardFixtureResult> {
  const home = await mkdtemp(join(tmpdir(), "ashlrcode-guard-fixture-"));
  const bin = join(home, "bin");
  const markerPath = join(home, "synthetic-npm-invocation");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(bin);
    await symlink("/bin/bash", join(bin, "bash"));
    // This is the only npm on the child's PATH. It records argv and exits;
    // it cannot resolve dependencies, run lifecycle scripts, or use npm auth.
    await writeFile(join(bin, "npm"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$FIXTURE_INSTALL_MARKER"\nprintf "synthetic npm executed\\n"\n',
      { mode: 0o700 });
    const script = `
      const mode = ${JSON.stringify(mode)};
      let networkRequests = 0;
      globalThis.fetch = async () => { networkRequests++; throw new Error('Unexpected fixture network request'); };
      const scans = [];
      let output = '';
      let seal;
      if (mode === 'phantom') {
        const { applyPhantomSeal } = await import(${JSON.stringify(new URL("../tools/guards/phantom-seal.ts", import.meta.url).href)});
        seal = await applyPhantomSeal('echo fixture-secret', { enabled: true, cwd: process.env.HOME });
      } else {
        const { bashTool, _resetGuardSettingsCache, _setBinshieldFetch } = await import(${JSON.stringify(new URL("../tools/bash.ts", import.meta.url).href)});
        _resetGuardSettingsCache({ binshieldGate: mode !== 'disabled', binshieldUrl: 'https://binshield-fixture.invalid' });
        _setBinshieldFetch(async (url, init) => {
          scans.push({ url, body: JSON.parse(init.body) });
          if (mode === 'unreachable') throw new Error('Synthetic scanner unavailable');
          return new Response(JSON.stringify({ id: 'fixture-scan', status: 'complete', result: { riskLevel: mode === 'critical' ? 'critical' : 'none' } }), { headers: { 'content-type': 'application/json' } });
        });
        output = await bashTool.call({ command: mode === 'disabled' ? 'echo guards-off' : 'npm install synthetic-fixture@1.0.0', timeout: 1000 }, { cwd: process.env.HOME, requestPermission: async () => true });
      }
      console.log(JSON.stringify({ output, scans, networkRequests, wrapped: seal?.wrapped, command: seal?.command }));
    `;
    // Sentinel is present before imports. Neither test nor native shell can
    // discover the user's Phantom, npm, HOME, settings, or credential stores.
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      cwd: home,
      env: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
        PATH: bin, FIXTURE_INSTALL_MARKER: markerPath, _AC_TEST_PHANTOM_AVAILABLE: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 5_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Guard fixture exited ${code}: ${stderr}`);
    const report = JSON.parse(stdout.trim()) as Omit<GuardFixtureResult, "marker">;
    let marker: string | null = null;
    try {
      marker = await readFile(markerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ...report, marker };
  } finally {
    clearTimeout(deadline);
    await rm(home, { recursive: true, force: true });
  }
}

function expectFixtureScan(result: GuardFixtureResult): void {
  expect(result.scans).toEqual([{
    url: "https://binshield-fixture.invalid/public/scan",
    body: { ecosystem: "npm", packageName: "synthetic-fixture", version: "1.0.0" },
  }]);
  expect(result.networkRequests).toBe(0);
}

/** Build a minimal mock fetch that returns a binshield ScanJob response. */
function mockBinshieldFetch(riskLevel: string, ok = true): typeof fetch {
  return (async (_url, _init) => {
    if (!ok) {
      return new Response("Service Unavailable", { status: 503 });
    }
    const body = JSON.stringify({
      id: "test-job-123",
      status: "complete",
      result: { riskLevel },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// parseInstallCommand
// ---------------------------------------------------------------------------

describe("parseInstallCommand", () => {
  test("parses npm install with version", () => {
    const r = parseInstallCommand("npm install lodash@4.17.21");
    expect(r).not.toBeNull();
    expect(r!.ecosystem).toBe("npm");
    expect(r!.packages[0]).toEqual({ name: "lodash", version: "4.17.21" });
  });

  test("parses bun add without version", () => {
    const r = parseInstallCommand("bun add express");
    expect(r).not.toBeNull();
    expect(r!.ecosystem).toBe("npm");
    expect(r!.packages[0]).toEqual({ name: "express", version: "latest" });
  });

  test("parses pnpm add scoped package", () => {
    const r = parseInstallCommand("pnpm add @types/node@18");
    expect(r).not.toBeNull();
    expect(r!.packages[0]!.name).toBe("@types/node");
    expect(r!.packages[0]!.version).toBe("18");
  });

  test("parses pip install with version constraint", () => {
    const r = parseInstallCommand("pip install requests==2.28.0");
    expect(r).not.toBeNull();
    expect(r!.ecosystem).toBe("pip");
    expect(r!.packages[0]!.name).toBe("requests");
  });

  test("parses multiple packages", () => {
    const r = parseInstallCommand("npm install react react-dom");
    expect(r).not.toBeNull();
    expect(r!.packages).toHaveLength(2);
  });

  test("strips dev flags", () => {
    const r = parseInstallCommand("npm install --save-dev typescript");
    expect(r).not.toBeNull();
    expect(r!.packages[0]!.name).toBe("typescript");
  });

  test("returns null for non-install commands", () => {
    expect(parseInstallCommand("git status")).toBeNull();
    expect(parseInstallCommand("ls -la")).toBeNull();
    expect(parseInstallCommand("bun run build")).toBeNull();
    expect(parseInstallCommand("echo hello")).toBeNull();
  });

  test("returns null for bare install with no packages", () => {
    expect(parseInstallCommand("npm install")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkBinshieldGate
// ---------------------------------------------------------------------------

describe("checkBinshieldGate", () => {
  const baseOpts: BinshieldGateOptions = {
    enabled: true,
    apiUrl: "https://api.binshield.dev",
  };

  test("allows when gate is disabled", async () => {
    const r = await checkBinshieldGate("npm install malware-pkg", { enabled: false });
    expect(r.verdict).toBe("allow");
    expect(r.reason).toContain("disabled");
  });

  test("allows non-install commands without scanning", async () => {
    const r = await checkBinshieldGate("git status", baseOpts);
    expect(r.verdict).toBe("allow");
    expect(r.scanned).toHaveLength(0);
  });

  test("blocks on critical risk level", async () => {
    const r = await checkBinshieldGate("npm install evil-pkg", {
      ...baseOpts,
      fetchFn: mockBinshieldFetch("critical"),
    });
    expect(r.verdict).toBe("block");
    expect(r.reason).toContain("BLOCKED");
    expect(r.reason).toContain("evil-pkg");
    expect(r.scanned[0]!.riskLevel).toBe("critical");
  });

  test("blocks on high risk level", async () => {
    const r = await checkBinshieldGate("npm install risky-pkg", {
      ...baseOpts,
      fetchFn: mockBinshieldFetch("high"),
    });
    expect(r.verdict).toBe("block");
    expect(r.scanned[0]!.riskLevel).toBe("high");
  });

  test("allows on medium risk level", async () => {
    const r = await checkBinshieldGate("npm install medium-pkg", {
      ...baseOpts,
      fetchFn: mockBinshieldFetch("medium"),
    });
    expect(r.verdict).toBe("allow");
  });

  test("allows on low risk level", async () => {
    const r = await checkBinshieldGate("npm install safe-pkg", {
      ...baseOpts,
      fetchFn: mockBinshieldFetch("low"),
    });
    expect(r.verdict).toBe("allow");
  });

  test("allows on none risk level", async () => {
    const r = await checkBinshieldGate("npm install safe-pkg", {
      ...baseOpts,
      fetchFn: mockBinshieldFetch("none"),
    });
    expect(r.verdict).toBe("allow");
  });

  test("fail-open when binshield is unreachable (503)", async () => {
    const r = await checkBinshieldGate("npm install some-pkg", {
      ...baseOpts,
      fetchFn: mockBinshieldFetch("none", false /* HTTP 503 */),
    });
    // Should allow (fail-open), not block
    expect(r.verdict).toBe("allow");
    expect(r.scanned[0]!.riskLevel).toBe("unknown");
  });

  test("fail-open when fetch throws (network down)", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkBinshieldGate("npm install some-pkg", {
      ...baseOpts,
      fetchFn: throwingFetch,
    });
    expect(r.verdict).toBe("allow");
  });

  test("blocks only the bad package in a multi-package install", async () => {
    let callCount = 0;
    const selectiveFetch = (async (_url, init) => {
      callCount++;
      const body = JSON.parse((init?.body as string) ?? "{}");
      // First package is critical, second is safe
      const risk = callCount === 1 ? "critical" : "none";
      return new Response(
        JSON.stringify({ id: "j", status: "complete", result: { riskLevel: risk } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const r = await checkBinshieldGate("npm install evil-pkg safe-pkg", {
      ...baseOpts,
      fetchFn: selectiveFetch,
    });
    expect(r.verdict).toBe("block");
    expect(r.reason).toContain("evil-pkg");
    expect(r.scanned).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// applyPhantomSeal
// ---------------------------------------------------------------------------

describe("applyPhantomSeal", () => {
  beforeEach(() => {
    _resetPhantomPathCache();
  });

  test("no-ops when disabled", async () => {
    const r = await applyPhantomSeal("echo hello", { enabled: false, cwd: "/tmp" });
    expect(r.wrapped).toBe(false);
    expect(r.command).toBe("echo hello");
  });

  test("wraps command when phantom is available (test mode)", async () => {
    const result = await runGuardFixture("phantom");
    expect(result.wrapped).toBe(true);
    expect(result.command).toBe('phantom exec -- bash -c "echo fixture-secret"');
    expect(result.networkRequests).toBe(0);
    expect(result.marker).toBeNull();
  });

  test("does not double-wrap already-phantom commands", async () => {
    const r = await applyPhantomSeal("phantom exec -- bash -c 'echo hi'", {
      enabled: true,
      cwd: "/tmp",
    });
    expect(r.wrapped).toBe(false);
    expect(r.command).toBe("phantom exec -- bash -c 'echo hi'");
  });
});

// ---------------------------------------------------------------------------
// bash.ts integration — guard path smoke tests
// ---------------------------------------------------------------------------

describe("bashTool guard integration", () => {
  test("passes through normal command when both guards disabled (default)", async () => {
    const result = await runGuardFixture("disabled");
    expect(result.output).toBe("guards-off\n");
    expect(result.scans).toEqual([]);
    expect(result.networkRequests).toBe(0);
    expect(result.marker).toBeNull();
  });

  test("binshield gate triggers on install command and blocks critical", async () => {
    const result = await runGuardFixture("critical");
    expectFixtureScan(result);
    expect(result.output).toContain("BLOCKED");
    expect(result.output).toContain("synthetic-fixture");
    expect(result.marker).toBeNull();
  });

  test("binshield gate allows safe install command", async () => {
    const result = await runGuardFixture("safe");
    expectFixtureScan(result);
    expect(result.output).toBe("synthetic npm executed\n");
    expect(result.marker).toBe("install synthetic-fixture@1.0.0\n");
  });

  test("binshield fail-open on unreachable API does not block", async () => {
    const result = await runGuardFixture("unreachable");
    expectFixtureScan(result);
    expect(result.output).toBe("synthetic npm executed\n");
    expect(result.marker).toBe("install synthetic-fixture@1.0.0\n");
  });
});
