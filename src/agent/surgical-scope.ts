/**
 * Surgical Scope Detection — intent-aware file-count budget for --surgical mode.
 *
 * Parses the goal string for lexical scope signals and returns:
 *   - a `fileBudget`: expected max number of files the run should touch
 *   - a `scopeLabel`: human-readable description of the detected scope
 *   - a `scopeTier`: "narrow" | "medium" | "wide"
 *
 * The FILE-COUNT GUARD uses this budget to decide whether to auto-revert a
 * surgical run that touched more files than expected.
 */

export type ScopeTier = "narrow" | "medium" | "wide";

export interface SurgicalScope {
  fileBudget: number;
  scopeLabel: string;
  scopeTier: ScopeTier;
}

/**
 * Signals that indicate a very narrow, single-file change.
 * Each entry is a lowercased keyword or short phrase.
 */
const NARROW_SIGNALS = [
  "fix typo",
  "typo",
  "fix comment",
  "comment",
  "null check",
  "undefined check",
  "off-by-one",
  "off by one",
  "missing semicolon",
  "missing comma",
  "missing bracket",
  "rename variable",
  "rename parameter",
  "fix bug",
  "fix crash",
  "fix error",
  "fix warning",
  "fix lint",
  "one-line",
  "one line",
  "single line",
  "add a line",
  "delete a line",
  "remove a line",
  "change a line",
  "patch",
];

/**
 * Signals that indicate a medium-scope change (2–3 files).
 * Typically a focused fix that requires touching an impl + test, or two
 * related modules.
 */
const MEDIUM_SIGNALS = [
  "fix test",
  "fix failing test",
  "fix the test",
  "update test",
  "add test",
  "write test",
  "add type",
  "fix type",
  "fix import",
  "update import",
  "add import",
  "fix export",
  "update export",
  "add export",
  "fix interface",
  "update interface",
  "fix function",
  "update function",
  "add function",
  "fix method",
  "update method",
  "add method",
  "fix",
];

/**
 * Signals that indicate a wide, multi-file change.
 */
const WIDE_SIGNALS = [
  "refactor",
  "reorganize",
  "restructure",
  "rewrite",
  "add feature",
  "new feature",
  "implement",
  "migrate",
  "extract",
  "move module",
  "rename module",
  "rename file",
  "across",
  "throughout",
  "all files",
  "everywhere",
  "update all",
  "replace all",
];

/**
 * Detect the surgical scope from a goal string.
 *
 * Strategy:
 *   1. Normalize the goal to lowercase.
 *   2. Check WIDE signals first — if any match, return wide immediately
 *      (a wide signal dominates regardless of other words).
 *   3. Check NARROW signals next — sorted longest-first so multi-word phrases
 *      beat single-word fallbacks ("fix typo" > "fix").
 *   4. Check MEDIUM signals.
 *   5. Default to medium if nothing matches.
 */
export function detectSurgicalScope(goal: string): SurgicalScope {
  const normalized = goal.toLowerCase();

  // Wide check first — these override everything
  for (const signal of WIDE_SIGNALS) {
    if (normalized.includes(signal)) {
      return {
        fileBudget: 6,
        scopeLabel: `wide (matched: "${signal}")`,
        scopeTier: "wide",
      };
    }
  }

  // Narrow check — sort longest phrases first so "fix typo" beats "fix"
  const narrowSorted = [...NARROW_SIGNALS].sort((a, b) => b.length - a.length);
  for (const signal of narrowSorted) {
    if (normalized.includes(signal)) {
      return {
        fileBudget: 1,
        scopeLabel: `narrow (matched: "${signal}")`,
        scopeTier: "narrow",
      };
    }
  }

  // Medium check — sort longest phrases first
  const mediumSorted = [...MEDIUM_SIGNALS].sort((a, b) => b.length - a.length);
  for (const signal of mediumSorted) {
    if (normalized.includes(signal)) {
      return {
        fileBudget: 3,
        scopeLabel: `medium (matched: "${signal}")`,
        scopeTier: "medium",
      };
    }
  }

  // Default: medium
  return {
    fileBudget: 3,
    scopeLabel: "medium (default — no strong scope signal detected)",
    scopeTier: "medium",
  };
}

/* ── File-count guard ─────────────────────────────────────────────── */

export interface FileCountGuardResult {
  /** true if the run stayed within budget */
  withinBudget: boolean;
  /** number of files touched */
  filesChanged: number;
  /** budget that was in effect */
  fileBudget: number;
  /** scope that was detected */
  scope: SurgicalScope;
}

/**
 * Count the number of unique files changed between two git states.
 * Uses `git diff --name-only HEAD` to enumerate all changed paths.
 * Returns 0 on any error (non-git dir, git unavailable, etc.).
 */
export async function countChangedFiles(cwd: string): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const paths = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return paths.length;
  } catch {
    return 0;
  }
}

/**
 * Check whether a surgical run stayed within the detected file-count budget.
 */
export async function checkFileCountGuard(
  cwd: string,
  scope: SurgicalScope,
): Promise<FileCountGuardResult> {
  const filesChanged = await countChangedFiles(cwd);
  return {
    withinBudget: filesChanged <= scope.fileBudget,
    filesChanged,
    fileBudget: scope.fileBudget,
    scope,
  };
}

/**
 * Attempt to revert all uncommitted changes via `git stash`.
 * Returns true if stash succeeded, false otherwise.
 *
 * NOTE: Caller is responsible for deciding whether to pop or drop the stash.
 * The stash message is set so it can be identified later:
 *   "surgical-scope-revert: <goal>"
 */
export async function revertToPreSurgicalSnapshot(
  cwd: string,
  goal: string,
): Promise<boolean> {
  try {
    const label = `surgical-scope-revert: ${goal.slice(0, 60)}`;
    const proc = Bun.spawn(["git", "stash", "push", "-m", label], {
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
