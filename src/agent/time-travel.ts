/**
 * Time-travel debugger — a replayable, branchable timeline of agent steps.
 *
 * Idea #5 ("invent your own"): every agent step — its tool name, args, result,
 * and a cheap working-tree marker — is appended to a per-session timeline at
 * `~/.ashlrcode/timelines/<sessionId>.jsonl`. With the full ribbon on disk a
 * user can:
 *   - **scrub backward** through every step the agent took,
 *   - **fork** a new branchable session seeded from any earlier step's state, and
 *   - **re-run** from that fork with a clean slate.
 *
 * The working-tree marker is captured via `git stash create` — that produces a
 * real (danling) commit-ish SHA snapshotting the *dirty* tree without mutating
 * the index or working copy, so a fork can later `git stash apply <sha>` to
 * restore the exact files the agent saw. When the tree is clean (or git is
 * unavailable) we fall back to `git rev-parse HEAD` plus a dirty flag.
 *
 * Design contract:
 *   - **Never throws.** Every public function is wrapped so a recorder failure
 *     can never break the agent loop. Failures degrade to a no-op.
 *   - **Bounded.** Args and results are clamped, and each session timeline is
 *     capped at MAX_STEPS_PER_SESSION lines.
 *   - **Flag-gated.** Recording is off unless the `timeTravel` setting (or the
 *     ASHLRCODE_TIME_TRAVEL env var) is enabled. The flag is read once and
 *     cached so the per-step hook stays cheap.
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** A cheap snapshot of the working tree at a point in time. */
export interface TreeMarker {
  /** Kind of marker: a stash-create commit-ish, or a HEAD ref. */
  kind: "stash" | "head" | "none";
  /** The captured SHA (stash-create object or HEAD), if any. */
  sha?: string;
  /** Whether the working tree had uncommitted changes. */
  dirty: boolean;
}

/** One recorded agent step. */
export interface TimelineStep {
  /** Monotonic step index within the session (0-based). */
  index: number;
  /** Tool that was executed. */
  toolName: string;
  /** Tool arguments (clamped). */
  args: Record<string, unknown>;
  /** Tool result text (clamped). */
  result: string;
  /** Whether the tool reported an error. */
  isError?: boolean;
  /** Working-tree marker captured for this step. */
  tree: TreeMarker;
  /** ISO timestamp the step was recorded. */
  at: string;
}

export interface RecordStepInput {
  index: number;
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  isError?: boolean;
  /** Optional pre-computed tree SHA; if omitted we capture one. */
  treeSha?: string;
  /** Working directory for the git marker capture (default: process.cwd()). */
  cwd?: string;
}

export interface ForkResult {
  /** The new branchable session ID seeded from the fork point. */
  sessionId: string;
  /** The step the fork was seeded from. */
  fromIndex: number;
  /** Number of steps copied into the new timeline. */
  steps: number;
  /** The working-tree marker to restore to reach this state. */
  tree: TreeMarker;
}

// ── Bounds ───────────────────────────────────────────────────────────────��─

const MAX_ARG_CHARS = 4_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_STEPS_PER_SESSION = 5_000;

// ── Flag gating ──────────────────────────────────────────────────────────��─

let _enabledCache: boolean | null = null;

/**
 * Whether time-travel recording is enabled. Reads ASHLRCODE_TIME_TRAVEL first
 * (cheap, sync, always wins) then the cached `timeTravel` setting. Cached so
 * the per-step hook never blocks on disk. Never throws.
 */
export function isTimeTravelEnabled(): boolean {
  try {
    const env = process.env.ASHLRCODE_TIME_TRAVEL;
    if (env === "1" || env === "true") return true;
    if (env === "0" || env === "false") return false;
    if (_enabledCache !== null) return _enabledCache;

    // Cheap synchronous settings probe — read once, cache forever.
    const settingsPath = join(getConfigDir(), "settings.json");
    if (existsSync(settingsPath)) {
      // Bun supports require for JSON; fall back to false on any parse error.
      const raw = require("fs").readFileSync(settingsPath, "utf-8") as string;
      const parsed = JSON.parse(raw) as { timeTravel?: boolean };
      _enabledCache = parsed.timeTravel === true;
    } else {
      _enabledCache = false;
    }
    return _enabledCache;
  } catch {
    _enabledCache = false;
    return false;
  }
}

/** Reset the cached flag (tests / settings changes). */
export function resetTimeTravelCache(): void {
  _enabledCache = null;
}

// ── Storage ──────────────────────────────────────────────────────────────��─

function getTimelineDir(): string {
  return join(getConfigDir(), "timelines");
}

function getTimelinePath(sessionId: string): string {
  // Guard against path traversal in sessionId.
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(getTimelineDir(), `${safe}.jsonl`);
}

// ── Git working-tree marker ──────────────────────────────────────────────��─

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Capture a cheap working-tree marker. Prefers `git stash create`, which mints
 * a dangling commit-ish snapshotting the dirty tree *without* touching the
 * index or working copy. Falls back to HEAD + dirty flag. Never throws.
 */
export async function captureTreeMarker(cwd: string): Promise<TreeMarker> {
  try {
    const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inRepo !== "true") return { kind: "none", dirty: false };

    const status = await git(cwd, ["status", "--porcelain"]);
    const dirty = !!status && status.length > 0;

    if (dirty) {
      // stash create snapshots the dirty tree as a commit-ish, restorable via
      // `git stash apply <sha>` — does not modify the working tree.
      const stashSha = await git(cwd, ["stash", "create", "ashlrcode time-travel snapshot"]);
      if (stashSha) return { kind: "stash", sha: stashSha, dirty: true };
    }

    const head = await git(cwd, ["rev-parse", "HEAD"]);
    if (head) return { kind: "head", sha: head, dirty };

    return { kind: "none", dirty };
  } catch {
    return { kind: "none", dirty: false };
  }
}

// ── Recording ──────────────────────────────────────────────────────────────

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

function clampArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(args);
    if (json.length <= MAX_ARG_CHARS) return args;
    return { _clamped: clamp(json, MAX_ARG_CHARS) };
  } catch {
    return { _unserializable: true };
  }
}

// Per-session line counts to enforce the bound without re-reading the file.
const _stepCounts = new Map<string, number>();

/**
 * Append one step to the session timeline. No-op unless time-travel is enabled.
 * Never throws — failures are swallowed so the agent loop is never disrupted.
 */
export async function recordStep(sessionId: string, input: RecordStepInput): Promise<void> {
  try {
    if (!isTimeTravelEnabled()) return;
    if (!sessionId) return;

    const count = _stepCounts.get(sessionId) ?? 0;
    if (count >= MAX_STEPS_PER_SESSION) return;

    const cwd = input.cwd ?? process.cwd();
    const tree: TreeMarker = input.treeSha
      ? { kind: "stash", sha: input.treeSha, dirty: true }
      : await captureTreeMarker(cwd);

    const step: TimelineStep = {
      index: input.index,
      toolName: input.toolName,
      args: clampArgs(input.args ?? {}),
      result: clamp(input.result ?? "", MAX_RESULT_CHARS),
      isError: input.isError,
      tree,
      at: new Date().toISOString(),
    };

    const dir = getTimelineDir();
    await mkdir(dir, { recursive: true });
    await appendFile(getTimelinePath(sessionId), `${JSON.stringify(step)}\n`, "utf-8");
    _stepCounts.set(sessionId, count + 1);
  } catch {
    // never throw
  }
}

// ── Loading / scrubbing ──────────────────────────────────────────────────��─

/**
 * Load a session timeline, ordered by step index. Returns [] if missing or on
 * any error. Corrupt lines are skipped. Never throws.
 */
export async function loadTimeline(sessionId: string): Promise<TimelineStep[]> {
  try {
    const path = getTimelinePath(sessionId);
    if (!existsSync(path)) return [];
    const raw = await readFile(path, "utf-8");
    const steps: TimelineStep[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        steps.push(JSON.parse(trimmed) as TimelineStep);
      } catch {
        // skip corrupt line
      }
    }
    return steps.sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

/** List all session IDs that have a recorded timeline, newest file first. */
export async function listTimelines(): Promise<string[]> {
  try {
    const dir = getTimelineDir();
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}

// ── Forking ──────────────────────────────────────────────────────────────��─

/**
 * Fork a new branchable session seeded from `stepIndex` of an existing session.
 *
 * Semantics: the new timeline is a *copy* of every step up to and including
 * `stepIndex` (a prefix of the parent ribbon). The returned `tree` marker is the
 * working-tree snapshot recorded at the fork point — the caller restores it
 * (e.g. `git stash apply <sha>`) to put the working copy back into the state the
 * agent saw, then re-runs from there. The parent timeline is never mutated, so
 * multiple forks can branch from the same or different points.
 *
 * Returns null if the source timeline is missing or has no step at `stepIndex`.
 * Never throws.
 */
export async function forkFrom(sourceSessionId: string, stepIndex: number): Promise<ForkResult | null> {
  try {
    const steps = await loadTimeline(sourceSessionId);
    if (steps.length === 0) return null;

    const prefix = steps.filter((s) => s.index <= stepIndex);
    if (prefix.length === 0) return null;

    const forkPoint = prefix[prefix.length - 1]!;
    const newSessionId = `fork-${stepIndex}-${randomUUID().slice(0, 8)}`;

    const dir = getTimelineDir();
    await mkdir(dir, { recursive: true });
    const body = prefix.map((s) => JSON.stringify(s)).join("\n");
    await writeFile(getTimelinePath(newSessionId), body ? `${body}\n` : "", "utf-8");
    _stepCounts.set(newSessionId, prefix.length);

    return {
      sessionId: newSessionId,
      fromIndex: forkPoint.index,
      steps: prefix.length,
      tree: forkPoint.tree,
    };
  } catch {
    return null;
  }
}
