/**
 * Tool Execution Replay & Debug Harness
 *
 * Provides deterministic replay of tool call sequences for diagnosing agent
 * failures. Records every tool invocation with full fidelity, serializes
 * capture logs as .replay JSON files, and re-runs captured sequences with
 * diff highlighting on divergence.
 *
 * Design contract:
 *   - **Never throws.** Capture hooks are wrapped so a recorder failure can
 *     never break the agent loop. Failures degrade to a no-op.
 *   - **Zero perf impact when disabled.** The capture flag is read once and
 *     cached; the hot path is a single boolean check.
 *   - **Flag-gated.** Recording is off unless ASHLRCODE_REPLAY=1 or
 *     the `replay` setting in settings.json is true.
 *   - **Bounded.** Each replay session is capped at MAX_CAPTURES_PER_SESSION
 *     invocations to avoid unbounded disk growth.
 */

import { existsSync } from "fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_INPUT_CHARS = 8_000;
export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_CAPTURES_PER_SESSION = 2_000;
/** Last N captures surfaced by /replay debug */
export const DEBUG_WINDOW = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

/** One recorded tool invocation. */
export interface ToolReplayCapture {
  /** Sequential index within the session (0-based). */
  index: number;
  /** Tool name (e.g. "bash", "read", "edit"). */
  name: string;
  /** Serialized tool input (clamped). */
  input: Record<string, unknown>;
  /** Tool output string (clamped). */
  output: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the tool reported an error result. */
  isError: boolean;
  /** Error message if the tool threw (distinct from isError result). */
  error?: string;
  /** Optional git state hash at invocation time (HEAD or stash SHA). */
  gitStateHash?: string;
  /** ISO timestamp the invocation was recorded. */
  at: string;
}

/** Persisted replay session file format. */
export interface ReplaySession {
  /** Unique session identifier (matches the agent session id). */
  sessionId: string;
  /** ISO timestamp of first capture in this session. */
  startedAt: string;
  /** ISO timestamp of last capture written. */
  lastUpdatedAt: string;
  /** Total capture count at time of last write. */
  captureCount: number;
  /** The ordered list of captures. */
  captures: ToolReplayCapture[];
}

/** Result of replaying one capture against a live executor. */
export interface ReplayStepResult {
  index: number;
  toolName: string;
  /** Whether replay output matched the recorded output exactly. */
  matched: boolean;
  /** Recorded (expected) output. */
  expected: string;
  /** Live (actual) output, or null if execution was skipped/errored. */
  actual: string | null;
  /** Unified diff of expected vs actual when diverged. */
  diff: string | null;
  /** Error thrown during replay execution, if any. */
  replayError?: string;
  /** Duration of the replay execution in ms. */
  replayDurationMs: number;
}

/** Result of running a full replay session. */
export interface ReplayResult {
  sessionId: string;
  totalSteps: number;
  matchedSteps: number;
  divergedSteps: number;
  stepResults: ReplayStepResult[];
  /** True when every step matched. */
  allMatched: boolean;
}

/** Event emitted during /replay debug step-through. */
export type ReplayDebugEvent =
  | { type: "header"; sessionId: string; totalCaptures: number; showingLast: number }
  | { type: "step"; capture: ToolReplayCapture; stepNumber: number; totalShown: number }
  | { type: "done"; summary: string };

// ── Flag gating ───────────────────────────────────────────────────────────────

let _enabledCache: boolean | null = null;

/**
 * Whether replay capture is enabled. Reads ASHLRCODE_REPLAY first (cheap,
 * sync, always wins) then the cached `replay` setting. Never throws.
 */
export function isReplayCaptureEnabled(): boolean {
  try {
    const env = process.env.ASHLRCODE_REPLAY;
    if (env === "1" || env === "true") return true;
    if (env === "0" || env === "false") return false;
    if (_enabledCache !== null) return _enabledCache;

    const settingsPath = join(getConfigDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const raw = require("fs").readFileSync(settingsPath, "utf-8") as string;
      const parsed = JSON.parse(raw) as { replay?: boolean };
      _enabledCache = parsed.replay === true;
    } else {
      _enabledCache = false;
    }
    return _enabledCache;
  } catch {
    _enabledCache = false;
    return false;
  }
}

/** Reset the cached flag (for tests / settings hot-reload). */
export function resetReplayCaptureCache(): void {
  _enabledCache = null;
}

// ── Storage paths ─────────────────────────────────────────────────────────────

export function getReplaysDir(): string {
  return join(getConfigDir(), "replays");
}

function getReplayPath(sessionId: string): string {
  // Guard against path traversal.
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(getReplaysDir(), `${safe}.replay`);
}

// ── Per-session in-memory capture buffers ─────────────────────────────────────

/**
 * In-memory ring buffer per session. Avoids re-reading the file on each
 * append; flushed to disk periodically or on explicit flush().
 */
const _sessionBuffers = new Map<
  string,
  { captures: ToolReplayCapture[]; dirty: boolean; startedAt: string }
>();

/** Capture counts per session (to enforce the bound without re-reading). */
const _captureCounts = new Map<string, number>();

// ── Clamping helpers ──────────────────────────────────────────────────────────

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars truncated]`;
}

function clampInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(input);
    if (json.length <= MAX_INPUT_CHARS) return input;
    return { _clamped: clamp(json, MAX_INPUT_CHARS) };
  } catch {
    return { _unserializable: true };
  }
}

// ── Capture API ───────────────────────────────────────────────────────────────

/**
 * Record one tool invocation into the session's replay buffer.
 *
 * This is the hot-path hook injected into tool-executor.ts. It is:
 *   - Synchronous for the in-memory write (no await in the hot path).
 *   - Async background flush for the disk write (fire-and-forget, never throws).
 *   - A no-op when capture is disabled (single boolean check).
 */
export function captureToolInvocation(
  sessionId: string,
  capture: Omit<ToolReplayCapture, "index" | "at">
): void {
  if (!isReplayCaptureEnabled()) return;
  if (!sessionId) return;

  try {
    const count = _captureCounts.get(sessionId) ?? 0;
    if (count >= MAX_CAPTURES_PER_SESSION) return;

    const buf = _sessionBuffers.get(sessionId) ?? {
      captures: [],
      dirty: false,
      startedAt: new Date().toISOString(),
    };

    const entry: ToolReplayCapture = {
      index: count,
      name: capture.name,
      input: clampInput(capture.input),
      output: clamp(capture.output, MAX_OUTPUT_CHARS),
      durationMs: capture.durationMs,
      isError: capture.isError,
      error: capture.error,
      gitStateHash: capture.gitStateHash,
      at: new Date().toISOString(),
    };

    buf.captures.push(entry);
    buf.dirty = true;
    _sessionBuffers.set(sessionId, buf);
    _captureCounts.set(sessionId, count + 1);
    // Background flush is intentionally omitted here to avoid write races.
    // Callers should invoke flushSession() explicitly (e.g. at session end).
  } catch {
    // never throw from hot path
  }
}

// ── Flush / persistence ───────────────────────────────────────────────────────

/**
 * Flush the in-memory buffer for a session to disk as a .replay JSON file.
 * Idempotent — safe to call multiple times. Never throws.
 */
export async function flushSession(sessionId: string): Promise<void> {
  try {
    const buf = _sessionBuffers.get(sessionId);
    if (!buf || !buf.dirty) return;

    const session: ReplaySession = {
      sessionId,
      startedAt: buf.startedAt,
      lastUpdatedAt: new Date().toISOString(),
      captureCount: buf.captures.length,
      captures: buf.captures,
    };

    const dir = getReplaysDir();
    await mkdir(dir, { recursive: true });
    await writeFile(getReplayPath(sessionId), JSON.stringify(session, null, 2), "utf-8");

    buf.dirty = false;
  } catch {
    // never throw
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load a persisted replay session from disk. Returns null if missing or
 * corrupt. Never throws.
 */
export async function loadReplaySession(sessionId: string): Promise<ReplaySession | null> {
  try {
    const path = getReplayPath(sessionId);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as ReplaySession;
  } catch {
    return null;
  }
}

/** List all session IDs that have a .replay file, newest first. */
export async function listReplaySessions(): Promise<string[]> {
  try {
    const dir = getReplaysDir();
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".replay"))
      .map((f) => f.slice(0, -".replay".length));
  } catch {
    return [];
  }
}

/** Get all captures for a session from the in-memory buffer (faster than disk). */
export function getSessionCaptures(sessionId: string): ToolReplayCapture[] {
  const buf = _sessionBuffers.get(sessionId);
  return buf ? [...buf.captures] : [];
}

/** Return the last N captures for a session (from memory or disk). */
export async function getLastCaptures(
  sessionId: string,
  n = DEBUG_WINDOW
): Promise<ToolReplayCapture[]> {
  // Prefer the in-memory buffer (fast, always current).
  const mem = _sessionBuffers.get(sessionId);
  if (mem && mem.captures.length > 0) {
    return mem.captures.slice(-n);
  }

  // Fall back to disk.
  const session = await loadReplaySession(sessionId);
  if (!session) return [];
  return session.captures.slice(-n);
}

// ── Diff generation ───────────────────────────────────────────────────────────

/**
 * Generate a simple unified diff between two strings (line-based).
 * Returns null when the strings are identical.
 */
export function generateDiff(expected: string, actual: string): string | null {
  if (expected === actual) return null;

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");

  const lines: string[] = ["--- expected", "+++ actual"];

  const maxLen = Math.max(expectedLines.length, actualLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const exp = expectedLines[i];
    const act = actualLines[i];

    if (exp === act) {
      lines.push(` ${exp ?? ""}`);
    } else {
      hasChanges = true;
      if (exp !== undefined) lines.push(`-${exp}`);
      if (act !== undefined) lines.push(`+${act}`);
    }
  }

  return hasChanges ? lines.join("\n") : null;
}

// ── Replay executor ───────────────────────────────────────────────────────────

/**
 * Executor function signature used during replay. Receives the tool name and
 * input, returns the output string. Callers supply a real or stub executor.
 */
export type ReplayExecutorFn = (
  name: string,
  input: Record<string, unknown>
) => Promise<string>;

/**
 * Re-run a captured replay session deterministically, comparing each step's
 * actual output against the recorded expected output.
 *
 * @param session  - The replay session to re-run.
 * @param executor - Function that executes a tool by name + input.
 * @param options  - Optional replay options.
 * @returns        - Full replay result with per-step divergence details.
 */
export async function replaySession(
  session: ReplaySession,
  executor: ReplayExecutorFn,
  options: {
    /** Stop after the first divergence. Default: false (replay all steps). */
    stopOnDivergence?: boolean;
    /** Only replay steps with these indices. Default: replay all. */
    stepFilter?: number[];
  } = {}
): Promise<ReplayResult> {
  const stepResults: ReplayStepResult[] = [];
  let matchedSteps = 0;
  let divergedSteps = 0;

  const captures = options.stepFilter
    ? session.captures.filter((c) => options.stepFilter!.includes(c.index))
    : session.captures;

  for (const capture of captures) {
    const replayStart = performance.now();
    let actual: string | null = null;
    let replayError: string | undefined;
    let matched = false;
    let diff: string | null = null;

    try {
      actual = await executor(capture.name, capture.input);
      diff = generateDiff(capture.output, actual);
      matched = diff === null;
    } catch (err: unknown) {
      replayError = err instanceof Error ? err.message : String(err);
      matched = false;
      diff = generateDiff(capture.output, replayError ?? "");
    }

    const replayDurationMs = performance.now() - replayStart;

    const stepResult: ReplayStepResult = {
      index: capture.index,
      toolName: capture.name,
      matched,
      expected: capture.output,
      actual,
      diff,
      replayError,
      replayDurationMs,
    };

    stepResults.push(stepResult);

    if (matched) {
      matchedSteps++;
    } else {
      divergedSteps++;
      if (options.stopOnDivergence) break;
    }
  }

  return {
    sessionId: session.sessionId,
    totalSteps: stepResults.length,
    matchedSteps,
    divergedSteps,
    stepResults,
    allMatched: divergedSteps === 0 && (stepResults.length === 0 || stepResults.length === captures.length),
  };
}

// ── Debug step-through (/replay debug) ────────────────────────────────────────

/**
 * Async generator that yields structured events for the /replay debug
 * step-through UI. Surfaces the last DEBUG_WINDOW captures with context.
 *
 * Usage:
 *   for await (const event of replayDebug(sessionId)) {
 *     if (event.type === "step") renderStep(event.capture);
 *   }
 */
export async function* replayDebug(
  sessionId: string,
  windowSize = DEBUG_WINDOW
): AsyncGenerator<ReplayDebugEvent> {
  const captures = await getLastCaptures(sessionId, windowSize);
  const total = _captureCounts.get(sessionId) ?? captures.length;

  yield {
    type: "header",
    sessionId,
    totalCaptures: total,
    showingLast: captures.length,
  };

  for (let i = 0; i < captures.length; i++) {
    yield {
      type: "step",
      capture: captures[i]!,
      stepNumber: i + 1,
      totalShown: captures.length,
    };
  }

  yield {
    type: "done",
    summary:
      captures.length === 0
        ? `No captures found for session "${sessionId}"`
        : `Showed ${captures.length} of ${total} total captures`,
  };
}

// ── /replay command formatter ─────────────────────────────────────────────────

/** Format a single capture for display in the terminal. */
export function formatCapture(capture: ToolReplayCapture, index?: number): string {
  const stepLabel = index !== undefined ? `Step ${index + 1}` : `#${capture.index}`;
  const errFlag = capture.isError ? " [ERROR]" : "";
  const errMsg = capture.error ? `\n  throw: ${capture.error}` : "";
  const inputStr = JSON.stringify(capture.input, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  const outputPreview =
    capture.output.length > 300
      ? capture.output.slice(0, 300) + `…[+${capture.output.length - 300} chars]`
      : capture.output;
  const outputLines = outputPreview
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

  return [
    `${stepLabel}: ${capture.name}${errFlag}  (${capture.durationMs.toFixed(1)}ms  ${capture.at})`,
    `  input:`,
    inputStr,
    `  output:`,
    outputLines,
    errMsg,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Format a full ReplayResult for terminal display. */
export function formatReplayResult(result: ReplayResult): string {
  const lines: string[] = [
    `Replay: ${result.sessionId}`,
    `  Steps: ${result.totalSteps} | Matched: ${result.matchedSteps} | Diverged: ${result.divergedSteps}`,
    `  Status: ${result.allMatched ? "ALL MATCHED" : "DIVERGENCE DETECTED"}`,
    "",
  ];

  for (const step of result.stepResults) {
    const status = step.matched ? "MATCH" : "DIVERGE";
    lines.push(
      `  [${status}] step ${step.index}: ${step.toolName} (${step.replayDurationMs.toFixed(1)}ms)`
    );
    if (!step.matched && step.diff) {
      const diffLines = step.diff.split("\n").slice(0, 20);
      for (const dl of diffLines) {
        lines.push(`    ${dl}`);
      }
      if (step.diff.split("\n").length > 20) {
        lines.push(`    ...(diff truncated)`);
      }
    }
    if (step.replayError) {
      lines.push(`    error: ${step.replayError}`);
    }
  }

  return lines.join("\n");
}

// ── Reset helpers (for tests) ─────────────────────────────────────────────────

/** Clear all in-memory state. Used in tests. */
export function resetReplayEngine(): void {
  _sessionBuffers.clear();
  _captureCounts.clear();
  _enabledCache = null;
}
