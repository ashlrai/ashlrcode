/**
 * Self-Bisecting Verifier (idea #6).
 *
 * When ac's verification detects a break (e.g. a test that was passing now
 * fails) after a run of autonomous edits, we don't want to blow away the whole
 * turn with a full revert, nor re-run a broad fix pass that may thrash. Instead
 * we bisect ac's OWN recorded edit sequence against the failing check to
 * pinpoint the single culprit edit, then propose a *surgical* revert: the
 * inverse hunk of just that one edit.
 *
 * The strategy mirrors `git bisect`, but over the agent's in-memory edit log
 * rather than commits:
 *
 *   - Edits are recorded in apply-order, each with the file and its before/after
 *     content (the same shape ac already keeps for time-travel / checkpoints).
 *   - We binary-search the smallest *prefix length* k such that applying edits
 *     [0..k) and running the check yields a FAILURE. That k-th edit (index k-1)
 *     is the first edit that flips the check from pass→fail: the culprit.
 *   - We assume monotonicity (once broken, staying broken) — the standard
 *     bisect assumption. If the check is non-monotonic the result is still a
 *     valid failing point, just not provably minimal.
 *
 * Everything here is PURE and INJECTABLE: the caller supplies `apply` (revert
 * the working tree to the state after a given prefix of edits) and `check`
 * (returns pass/fail). That keeps the module testable with no filesystem or
 * test-runner dependency, and lets the real hook wire in `detectAndRunTests`.
 *
 * Hard guarantees:
 *   - NEVER throws. Any thrown error from `apply` or `check` is swallowed and
 *     treated as a failure (conservative: a crashing check counts as "broken").
 *   - BOUNDED: at most O(log n) check invocations plus the final culprit probe;
 *     a `maxProbes` cap hard-limits total check calls regardless.
 */

/**
 * A single recorded edit. Mirrors ac's existing edit-record shape: a file path
 * plus the before/after content of that file for this edit.
 */
export interface Edit {
  /** File this edit touched (absolute or repo-relative — caller's choice). */
  filePath: string;
  /** Full file content immediately BEFORE this edit was applied. */
  before: string;
  /** Full file content immediately AFTER this edit was applied. */
  after: string;
  /** Optional human label (tool name, hunk summary) for reporting. */
  label?: string;
}

export interface BisectInput {
  /** The agent's recorded edits, in the order they were applied. */
  edits: Edit[];
  /**
   * Run the verification check against the CURRENT working-tree state.
   * Returns true = passing, false = broken. May be async. May throw — a throw
   * is treated as a failure.
   */
  check: () => boolean | Promise<boolean>;
  /**
   * Materialize the working tree to the state produced by applying exactly the
   * first `prefixLen` edits (0 = the pristine pre-edit state, edits.length =
   * the final/current state). Injected so the module stays pure & testable.
   * May be async. May throw — a throw aborts that probe (treated as failure).
   */
  apply: (prefixLen: number) => void | Promise<void>;
  /**
   * Hard cap on the number of `check` invocations. Defaults to a safe bound of
   * 2*ceil(log2(n))+4 which always covers the binary search plus slack.
   */
  maxProbes?: number;
}

export interface BisectResult {
  /** The first edit (in apply-order) that makes the check fail, if found. */
  culprit?: Edit;
  /** Zero-based index of the culprit within the input `edits` array. */
  culpritIndex?: number;
  /**
   * A minimal surgical-revert description for the culprit: a unified-diff-style
   * hunk that returns the culprit's file from `after` back to `before`.
   * Undefined when no culprit was isolated.
   */
  surgicalRevert?: string;
  /** Number of `check` invocations actually performed. */
  probes: number;
  /**
   * Why bisect concluded as it did — useful for surfacing to the operator.
   * One of: "isolated" | "no-edits" | "already-passing" | "no-culprit" |
   * "exhausted".
   */
  reason: "isolated" | "no-edits" | "already-passing" | "no-culprit" | "exhausted";
}

/** Conservative cap: binary search needs ~log2(n) probes; double it + slack. */
function defaultMaxProbes(n: number): number {
  if (n <= 0) return 4;
  return 2 * Math.ceil(Math.log2(n + 1)) + 4;
}

/**
 * Run `check` against the current tree, swallowing any throw as a failure.
 * Returns true only when the check explicitly passes.
 */
async function safeCheck(check: BisectInput["check"]): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

/** Apply a prefix, swallowing throws (a failed apply makes the probe a failure). */
async function safeApply(apply: BisectInput["apply"], prefixLen: number): Promise<boolean> {
  try {
    await apply(prefixLen);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a minimal unified-diff-style surgical revert hunk that takes the
 * culprit's file from its `after` state back to its `before` state. This is the
 * inverse of the culprit edit — applying it surgically undoes only that one
 * edit's change, leaving every other edit intact.
 *
 * We compute a coarse line-level diff (common prefix/suffix trimmed) so the
 * hunk is as small as possible rather than replacing the whole file.
 */
export function buildSurgicalRevert(edit: Edit): string {
  const afterLines = edit.after.split("\n");
  const beforeLines = edit.before.split("\n");

  // Trim the common leading lines.
  let start = 0;
  while (
    start < afterLines.length &&
    start < beforeLines.length &&
    afterLines[start] === beforeLines[start]
  ) {
    start++;
  }

  // Trim the common trailing lines (without overlapping the leading region).
  let endA = afterLines.length;
  let endB = beforeLines.length;
  while (
    endA > start &&
    endB > start &&
    afterLines[endA - 1] === beforeLines[endB - 1]
  ) {
    endA--;
    endB--;
  }

  const removed = afterLines.slice(start, endA); // lines to remove (current/after)
  const added = beforeLines.slice(start, endB); // lines to restore (before)

  const header = `--- a/${edit.filePath}\n+++ b/${edit.filePath}`;
  // 1-based line numbers for the hunk header.
  const oldStart = removed.length === 0 ? start : start + 1;
  const newStart = added.length === 0 ? start : start + 1;
  const hunkHeader = `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`;

  const body = [
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

  const label = edit.label ? `  (revert: ${edit.label})` : "";
  return `${header}${label}\n${hunkHeader}\n${body}`;
}

/**
 * Bisect a recorded edit sequence against a failing check to find the first
 * edit that breaks it, and propose a surgical revert for that edit.
 *
 * Algorithm (monotonic binary search over prefix length):
 *   1. Verify the pristine state (prefix 0) PASSES and the full state
 *      (prefix n) FAILS — these are bisect's preconditions. If prefix 0 already
 *      fails, the breakage predates the recorded edits (no culprit). If the
 *      full state passes, there's nothing to bisect (already-passing).
 *   2. Invariant: prefix `lo` passes, prefix `hi` fails (lo < hi). Probe the
 *      midpoint; narrow lo/hi until hi == lo+1. Then edit at index `lo` (the
 *      hi-th edit, i.e. the one whose inclusion flipped pass→fail) is the
 *      culprit.
 *   3. Emit the culprit + its inverse hunk as the surgical revert.
 *
 * Never throws; bounded by `maxProbes`.
 */
export async function bisectEdits(input: BisectInput): Promise<BisectResult> {
  const { edits, check, apply } = input;
  const n = edits.length;
  const maxProbes = input.maxProbes ?? defaultMaxProbes(n);
  let probes = 0;

  // A probe = apply(prefix) then check. Counts toward maxProbes only on check.
  const probe = async (prefixLen: number): Promise<boolean> => {
    if (probes >= maxProbes) return false; // exhausted — conservatively "fail"
    const applied = await safeApply(apply, prefixLen);
    probes++;
    if (!applied) return false;
    return safeCheck(check);
  };

  if (n === 0) {
    return { probes, reason: "no-edits" };
  }

  // Precondition A: pristine state (no edits) must pass; otherwise the break is
  // pre-existing and not attributable to any recorded edit.
  const pristinePasses = await probe(0);
  if (probes >= maxProbes && !pristinePasses) {
    return { probes, reason: "exhausted" };
  }
  if (!pristinePasses) {
    // Break predates the edit sequence — nothing here to revert.
    return { probes, reason: "no-culprit" };
  }

  // Precondition B: full state (all edits) must fail; otherwise nothing broke.
  const fullFails = !(await probe(n));
  if (!fullFails) {
    // Restore the full state (best-effort) and report nothing to do.
    await safeApply(apply, n);
    return { probes, reason: "already-passing" };
  }

  // Invariant: prefix `lo` passes, prefix `hi` fails.
  let lo = 0; // known-passing prefix length
  let hi = n; // known-failing prefix length

  while (hi - lo > 1) {
    if (probes >= maxProbes) {
      // Out of budget — fall back to the tightest known failing edit (hi-1).
      const idx = hi - 1;
      const culprit = edits[idx]!;
      // Restore full state before returning.
      await safeApply(apply, n);
      return {
        culprit,
        culpritIndex: idx,
        surgicalRevert: buildSurgicalRevert(culprit),
        probes,
        reason: "exhausted",
      };
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    const midPasses = await probe(mid);
    if (midPasses) {
      lo = mid; // still good up to mid
    } else {
      hi = mid; // broken by mid
    }
  }

  // hi == lo + 1: the edit at index `lo` (the hi-th edit) is the culprit.
  const culpritIndex = lo;
  const culprit = edits[culpritIndex]!;

  // Restore the full/current working-tree state — bisect must not leave the
  // tree in a probed intermediate state.
  await safeApply(apply, n);

  return {
    culprit,
    culpritIndex,
    surgicalRevert: buildSurgicalRevert(culprit),
    probes,
    reason: "isolated",
  };
}
