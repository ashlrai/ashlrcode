/**
 * Plain-text progress reporter for autonomous (non-interactive) mode.
 * No Ink, no React — just formatted stdout with ANSI colors.
 * Respects NO_COLOR env var per https://no-color.org.
 */

import { join } from "path";
import { homedir } from "os";
import { appendFile, mkdir } from "fs/promises";

const NO_COLOR = !!process.env.NO_COLOR;

/* ── ANSI helpers (no-op when NO_COLOR is set) ────────────────────── */

const ansi = {
  reset: NO_COLOR ? "" : "\x1b[0m",
  dim: NO_COLOR ? "" : "\x1b[2m",
  bold: NO_COLOR ? "" : "\x1b[1m",
  green: NO_COLOR ? "" : "\x1b[32m",
  cyan: NO_COLOR ? "" : "\x1b[36m",
  yellow: NO_COLOR ? "" : "\x1b[33m",
  red: NO_COLOR ? "" : "\x1b[31m",
  magenta: NO_COLOR ? "" : "\x1b[35m",
};

function c(color: string, text: string): string {
  return `${color}${text}${ansi.reset}`;
}

/* ── Session log (best-effort JSONL append) ───────────────────────── */

const SESSION_LOG_DIR = join(homedir(), ".ashlr");
const SESSION_LOG_PATH = join(SESSION_LOG_DIR, "session-log.jsonl");

async function logEvent(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(SESSION_LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n";
    await appendFile(SESSION_LOG_PATH, line, "utf-8");
  } catch {
    // Never fail — session log is optional
  }
}

/* ── Reporter ─────────────────────────────────────────────────────── */

export class AutonomousReporter {
  private startTime = Date.now();

  /** Called at each phase transition */
  phase(name: string, message: string): void {
    const tag = c(ansi.cyan, `[${name}]`);
    console.log(`${tag} ${message}`);
    logEvent({ type: "phase", name, message });
  }

  /** Called when a file is created/modified/deleted */
  fileAction(action: "created" | "modified" | "deleted", path: string, lines?: number): void {
    const arrow = c(ansi.dim, "  \u2192");
    const lineInfo = lines !== undefined ? c(ansi.dim, ` (${lines} lines)`) : "";
    const verb = action.charAt(0).toUpperCase() + action.slice(1);
    console.log(`${arrow} ${verb} ${path}${lineInfo}`);
    logEvent({ type: "file_action", action, path, lines });
  }

  /** Called when a commit happens */
  commit(message: string): void {
    const check = c(ansi.green, "  \u2713");
    console.log(`${check} Committed: ${c(ansi.dim, message)}`);
    logEvent({ type: "commit", message });
  }

  /** Called when tests run */
  tests(passed: number, failed: number): void {
    const icon = failed > 0 ? c(ansi.red, "  \u2717") : c(ansi.green, "  \u2713");
    console.log(`${icon} Tests: ${passed} passed, ${failed} failed`);
    logEvent({ type: "tests", passed, failed });
  }

  /** Called when a milestone completes */
  milestone(current: number, total: number, name: string): void {
    const tag = c(ansi.magenta, `[${current}/${total}]`);
    console.log(`${c(ansi.cyan, "[autopilot]")} ${tag} ${name}`);
    logEvent({ type: "milestone", current, total, name });
  }

  /** Final summary */
  summary(stats: {
    filesCreated: number;
    testsPass: number;
    testsFail: number;
    commits: number;
    duration: number;
    milestones: { done: number; total: number };
  }): void {
    const durationStr = formatDuration(stats.duration);
    const status = stats.testsFail === 0 ? c(ansi.green, "\u2713") : c(ansi.yellow, "\u26A0");

    console.log("");
    console.log(`${c(ansi.cyan, "[complete]")} ${status} Build finished in ${c(ansi.bold, durationStr)}`);
    console.log(c(ansi.dim, `  Milestones: ${stats.milestones.done}/${stats.milestones.total}`));
    console.log(c(ansi.dim, `  Files created: ${stats.filesCreated}`));
    console.log(c(ansi.dim, `  Tests: ${stats.testsPass} passed, ${stats.testsFail} failed`));
    console.log(c(ansi.dim, `  Commits: ${stats.commits}`));

    logEvent({ type: "summary", ...stats, durationStr });
  }

  /** Warn or error messages */
  warn(message: string): void {
    console.log(`${c(ansi.yellow, "  \u26A0")} ${message}`);
    logEvent({ type: "warn", message });
  }

  error(message: string): void {
    console.log(`${c(ansi.red, "  \u2717")} ${message}`);
    logEvent({ type: "error", message });
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remainS = s % 60;
  if (m < 60) return `${m}m ${remainS}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
