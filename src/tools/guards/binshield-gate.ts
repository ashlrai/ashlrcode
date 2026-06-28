/**
 * Guard: BinShield install gate
 *
 * During autonomous mode, intercepts dependency-install commands
 * (npm/bun/pnpm/yarn/pip install <pkg>) in the Bash tool and scans the
 * resolved package(s) via binshield's public scan API before execution.
 *
 * Verdict mapping:
 *   critical / high  → BLOCK (refuse the command, return error string)
 *   medium / low / none → ALLOW (log a note, proceed)
 *
 * Degrades gracefully: if binshield is unreachable, logs a warning and
 * ALLOWS the command (fail-open so the agent is never bricked).
 *
 * Flag-gated: `binshieldGate` in settings (default off).
 * Config: `binshieldUrl` (default "https://api.binshield.dev") and
 *         `binshieldKey` (optional, for authenticated endpoint).
 */

/** Subset of riskLevel values we care about. */
type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface BinshieldGateOptions {
  enabled: boolean;
  /** Base URL for binshield API. Default: https://api.binshield.dev */
  apiUrl?: string;
  /** Optional API key for authenticated requests. */
  apiKey?: string;
  /** Fetch override — inject in tests. */
  fetchFn?: typeof fetch;
}

export type GateVerdict = "allow" | "block";

export interface GateResult {
  verdict: GateVerdict;
  /** Human-readable explanation */
  reason: string;
  /** Packages that were scanned */
  scanned: ScannedPackage[];
}

interface ScannedPackage {
  name: string;
  version: string;
  ecosystem: string;
  riskLevel: RiskLevel | "unknown";
}

// ---------------------------------------------------------------------------
// Install command parsing
// ---------------------------------------------------------------------------

const INSTALL_PATTERN =
  /^\s*(?:sudo\s+)?(?:(npm|bun|pnpm|yarn)\s+(?:add|install|i)|(?:pip|pip3)\s+install)\s+(.+)/;

interface ParsedInstall {
  ecosystem: "npm" | "pip";
  packages: Array<{ name: string; version: string }>;
}

/** Parse an install command into ecosystem + package list. Returns null if not an install. */
export function parseInstallCommand(command: string): ParsedInstall | null {
  // Normalise: take only the first line (in case of chained commands)
  const firstLine = command.split(/[;&|]|&&|\|\|/)[0]?.trim() ?? "";

  const match = INSTALL_PATTERN.exec(firstLine);
  if (!match) return null;

  const manager = match[1]; // npm | bun | pnpm | yarn | undefined (pip)
  const rest = match[2]!.trim();

  // Strip common flags (-D, --save-dev, --global, -g, --no-save, etc.)
  const tokens = rest
    .split(/\s+/)
    .filter((t) => !t.startsWith("-") && t.length > 0);

  if (tokens.length === 0) return null;

  const ecosystem: "npm" | "pip" = manager === undefined ? "pip" : "npm";

  const packages = tokens.map((token) => {
    // npm: pkg@version, pkg@^1.2.3, @scope/pkg@version
    // pip: pkg==1.2, pkg>=1.2
    const npmMatch = token.match(/^(@?[^@]+)@(.+)$/);
    const pipMatch = token.match(/^([A-Za-z0-9_\-\.]+)[=><~!]+(.+)$/);

    if (npmMatch) return { name: npmMatch[1]!, version: npmMatch[2]! };
    if (pipMatch) return { name: pipMatch[1]!, version: pipMatch[2]! };
    return { name: token, version: "latest" };
  });

  return { ecosystem, packages };
}

// ---------------------------------------------------------------------------
// Scan a single package via binshield /public/scan
// ---------------------------------------------------------------------------

interface ScanJobPartial {
  id: string;
  status: string;
  result?: {
    riskLevel?: RiskLevel;
    [k: string]: unknown;
  };
  error?: string;
}

async function scanPackage(
  pkg: { name: string; version: string; ecosystem: string },
  opts: BinshieldGateOptions,
): Promise<RiskLevel | "unknown"> {
  const base = (opts.apiUrl ?? "https://api.binshield.dev").replace(/\/$/, "");
  const url = `${base}/public/scan`;
  const fetchFn = opts.fetchFn ?? fetch;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "AshlrCode-BinshieldGate/1.0",
  };
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

  const body = JSON.stringify({
    ecosystem: pkg.ecosystem,
    packageName: pkg.name,
    version: pkg.version,
  });

  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`binshield HTTP ${res.status}`);
  }

  const job = (await res.json()) as ScanJobPartial;

  // If the result is already inlined (synchronous response), use it
  if (job.result?.riskLevel) return job.result.riskLevel;

  // Otherwise, the scan is async — we can't block indefinitely in a tool call.
  // Return "unknown" and let the gate decide (configured to allow on unknown).
  return "unknown";
}

// ---------------------------------------------------------------------------
// Gate entry point
// ---------------------------------------------------------------------------

const BLOCKING_RISK_LEVELS: ReadonlySet<string> = new Set(["critical", "high"]);

/**
 * Check whether a bash command should be blocked by the BinShield install gate.
 *
 * Returns { verdict: "allow" } for non-install commands or safe packages.
 * Returns { verdict: "block", reason } for critical/high risk packages.
 * Never throws.
 */
export async function checkBinshieldGate(
  command: string,
  opts: BinshieldGateOptions,
): Promise<GateResult> {
  if (!opts.enabled) {
    return { verdict: "allow", reason: "binshieldGate disabled", scanned: [] };
  }

  const parsed = parseInstallCommand(command);
  if (!parsed) {
    return { verdict: "allow", reason: "not an install command", scanned: [] };
  }

  const { ecosystem, packages } = parsed;
  const scanned: ScannedPackage[] = [];
  const blocked: string[] = [];

  for (const pkg of packages) {
    let riskLevel: RiskLevel | "unknown" = "unknown";
    try {
      riskLevel = await scanPackage({ ...pkg, ecosystem }, opts);
      console.error(
        `[binshield-gate] ${pkg.name}@${pkg.version} → ${riskLevel}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[binshield-gate] scan failed for ${pkg.name} (fail-open): ${msg}`,
      );
      riskLevel = "unknown"; // fail-open
    }

    scanned.push({ name: pkg.name, version: pkg.version, ecosystem, riskLevel });

    if (BLOCKING_RISK_LEVELS.has(riskLevel)) {
      blocked.push(`${pkg.name}@${pkg.version} (${riskLevel})`);
    }
  }

  if (blocked.length > 0) {
    return {
      verdict: "block",
      reason: `[binshield-gate] BLOCKED — package(s) flagged as critical/high risk: ${blocked.join(", ")}`,
      scanned,
    };
  }

  return { verdict: "allow", reason: "all packages passed binshield scan", scanned };
}
