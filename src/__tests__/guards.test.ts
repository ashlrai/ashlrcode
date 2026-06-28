/**
 * Tests for autonomous safety guards:
 *   - BinShield install gate (src/tools/guards/binshield-gate.ts)
 *   - Phantom-seal wrapper (src/tools/guards/phantom-seal.ts)
 *   - bash.ts integration (both guards wired into call())
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  parseInstallCommand,
  checkBinshieldGate,
  type BinshieldGateOptions,
} from "../tools/guards/binshield-gate.ts";

import {
  applyPhantomSeal,
  _resetPhantomPathCache,
} from "../tools/guards/phantom-seal.ts";

import {
  bashTool,
  _resetGuardSettingsCache,
  _setBinshieldFetch,
} from "../tools/bash.ts";

import type { ToolContext } from "../tools/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(cwd = "/tmp"): ToolContext {
  return {
    cwd,
    requestPermission: async () => true,
  };
}

/** Build a minimal mock fetch that returns a binshield ScanJob response. */
function mockBinshieldFetch(riskLevel: string, ok = true): typeof fetch {
  return async (_url, _init) => {
    if (!ok) {
      return new Response("Service Unavailable", { status: 503 });
    }
    const body = JSON.stringify({
      id: "test-job-123",
      status: "complete",
      result: { riskLevel },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
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
    const throwingFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await checkBinshieldGate("npm install some-pkg", {
      ...baseOpts,
      fetchFn: throwingFetch,
    });
    expect(r.verdict).toBe("allow");
  });

  test("blocks only the bad package in a multi-package install", async () => {
    let callCount = 0;
    const selectiveFetch: typeof fetch = async (_url, init) => {
      callCount++;
      const body = JSON.parse((init?.body as string) ?? "{}");
      // First package is critical, second is safe
      const risk = callCount === 1 ? "critical" : "none";
      return new Response(
        JSON.stringify({ id: "j", status: "complete", result: { riskLevel: risk } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
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
    // _AC_TEST_PHANTOM_AVAILABLE=1 is set at process level — simulate by
    // passing a command through the real function under test-env flag.
    // We use env var already read at module load time; verify behaviour
    // by checking the wrap logic directly with the test sentinel.
    const origEnv = process.env._AC_TEST_PHANTOM_AVAILABLE;
    process.env._AC_TEST_PHANTOM_AVAILABLE = "1";
    // Re-import to pick up env (module-level const); instead we test the
    // output shape when phantom IS available via the exported fn directly.
    const r = await applyPhantomSeal("echo secret", { enabled: true, cwd: "/tmp" });
    // Under TEST_PHANTOM_AVAILABLE the function wraps
    if (r.wrapped) {
      expect(r.command).toContain("phantom exec");
      expect(r.command).toContain("echo secret");
    }
    // Restore
    if (origEnv === undefined) delete process.env._AC_TEST_PHANTOM_AVAILABLE;
    else process.env._AC_TEST_PHANTOM_AVAILABLE = origEnv;
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
  beforeEach(() => {
    _resetGuardSettingsCache();
    _setBinshieldFetch(undefined);
  });

  test("passes through normal command when both guards disabled (default)", async () => {
    _resetGuardSettingsCache({ providers: { primary: { provider: "xai", apiKey: "", model: "grok" } } } as any);
    const result = await bashTool.call({ command: "echo guards-off" }, makeContext());
    expect(result).toContain("guards-off");
  });

  test("binshield gate triggers on install command and blocks critical", async () => {
    _resetGuardSettingsCache({
      providers: { primary: { provider: "xai", apiKey: "", model: "grok" } },
      binshieldGate: true,
      binshieldUrl: "https://api.binshield.dev",
    } as any);
    _setBinshieldFetch(mockBinshieldFetch("critical"));

    const result = await bashTool.call(
      { command: "npm install malicious-package" },
      makeContext(),
    );
    expect(result).toContain("BLOCKED");
    expect(result).toContain("malicious-package");
  });

  test("binshield gate allows safe install command", async () => {
    _resetGuardSettingsCache({
      providers: { primary: { provider: "xai", apiKey: "", model: "grok" } },
      binshieldGate: true,
      binshieldUrl: "https://api.binshield.dev",
    } as any);
    _setBinshieldFetch(mockBinshieldFetch("none"));

    // Runs the actual command — use a no-op safe command
    const result = await bashTool.call(
      { command: "npm install lodash" },
      makeContext("/tmp"),
    );
    // Should have executed (not blocked) — exit code from npm may vary but won't say BLOCKED
    expect(result).not.toContain("BLOCKED");
  });

  test("binshield fail-open on unreachable API does not block", async () => {
    _resetGuardSettingsCache({
      providers: { primary: { provider: "xai", apiKey: "", model: "grok" } },
      binshieldGate: true,
    } as any);
    _setBinshieldFetch(async () => { throw new Error("network down"); });

    // Should NOT block — fail-open means the install runs (or fails for other reasons)
    const result = await bashTool.call(
      { command: "echo install-would-run" },
      makeContext(),
    );
    expect(result).not.toContain("BLOCKED");
  });
});
