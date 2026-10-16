/**
 * Guard: Phantom-sealed secrets
 *
 * When `phantomSealed` is enabled in settings, routes autonomous bash calls
 * through `phantom exec -- <cmd>` so real credentials are injected at the
 * network edge and never appear in prompts, transcripts, or the bridge server.
 *
 * Detection: `phantom` must be on PATH and the project must have an
 * initialized Phantom vault (`.phantom/` or `phantom.json` present in cwd,
 * OR `phantom status` exits 0).
 *
 * Degrades gracefully: if phantom is unavailable or the project is not
 * initialized the command runs as-is with a logged warning.
 *
 * Flag-gated: `phantomSealed` in settings (default off).
 */

import { existsSync } from "fs";
import { join } from "path";

export interface PhantomSealOptions {
  enabled: boolean;
  /** cwd of the running command */
  cwd: string;
}

export interface PhantomSealResult {
  /** Final command to execute (possibly wrapped) */
  command: string;
  /** Whether phantom wrapping was applied */
  wrapped: boolean;
  /** Human-readable note for logging */
  note: string;
}

/** Sentinel env-var injected in tests so we can verify wrapping without a real phantom binary. */
const TEST_PHANTOM_AVAILABLE = process.env._AC_TEST_PHANTOM_AVAILABLE === "1";

/**
 * Check whether `phantom` binary is on PATH.
 * Cached per-process for perf.
 */
let _phantomOnPath: boolean | undefined;

async function isPhantomOnPath(): Promise<boolean> {
  if (TEST_PHANTOM_AVAILABLE) return true;
  if (_phantomOnPath !== undefined) return _phantomOnPath;
  try {
    const proc = Bun.spawn(["which", "phantom"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    _phantomOnPath = code === 0;
  } catch {
    _phantomOnPath = false;
  }
  return _phantomOnPath;
}

/** Reset the PATH cache — for tests only. */
export function _resetPhantomPathCache(): void {
  _phantomOnPath = undefined;
}

/**
 * Check whether the project at `cwd` has a Phantom vault initialized.
 * Fast path: look for on-disk markers before spawning `phantom status`.
 */
async function isPhantomInitialized(cwd: string): Promise<boolean> {
  if (TEST_PHANTOM_AVAILABLE) return true;

  // Fast path: .phantom/ directory or phantom.json marker
  if (existsSync(join(cwd, ".phantom")) || existsSync(join(cwd, "phantom.json"))) {
    return true;
  }

  // Slow path: `phantom status` exit code
  try {
    const proc = Bun.spawn(["phantom", "status"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Apply phantom-seal wrapping to a bash command.
 *
 * Returns the (possibly wrapped) command and metadata.
 * Never throws — always returns a safe fallback.
 */
export async function applyPhantomSeal(
  command: string,
  opts: PhantomSealOptions,
): Promise<PhantomSealResult> {
  if (!opts.enabled) {
    return { command, wrapped: false, note: "phantomSealed disabled" };
  }

  // Don't double-wrap if already phantom-exec'd
  if (command.trimStart().startsWith("phantom exec")) {
    return { command, wrapped: false, note: "already phantom-wrapped" };
  }

  try {
    const onPath = await isPhantomOnPath();
    if (!onPath) {
      console.error(
        "[phantom-seal] phantom not found on PATH — running command without secret injection",
      );
      return { command, wrapped: false, note: "phantom not on PATH (degraded)" };
    }

    const initialized = await isPhantomInitialized(opts.cwd);
    if (!initialized) {
      console.error(
        "[phantom-seal] phantom not initialized in project — running command without secret injection",
      );
      return { command, wrapped: false, note: "phantom not initialized (degraded)" };
    }

    const wrapped = `phantom exec -- bash -c ${JSON.stringify(command)}`;
    console.error(`[phantom-seal] wrapping command through phantom exec`);
    return { command: wrapped, wrapped: true, note: "phantom-sealed" };
  } catch (err) {
    // Never-throw guarantee
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[phantom-seal] error during seal check (degraded): ${msg}`);
    return { command, wrapped: false, note: `phantom-seal error: ${msg}` };
  }
}
