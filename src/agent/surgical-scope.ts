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
 *
 * Also exports `analyzeScopeFromIntent` — a higher-level analyzer that combines
 * intent signals with codebase context signals to produce a suggested tier with
 * confidence score and human-readable reasoning. Used by the REPL's /surgical
 * command to auto-detect tier before the user has to manually cycle narrow/medium/wide.
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

/* ── Smart Tier Auto-Detection (SurgicalScopeAnalyzer) ───────────────────── */

/**
 * Result returned by `analyzeScopeFromIntent`.
 *
 * - `suggestedTier`: the recommended scope tier based on intent + codebase signals
 * - `confidence`:    0–1 float; higher = more signals agreed on the tier
 * - `reasoning`:     human-readable explanation shown to the user before they confirm/override
 */
export interface ScopeAnalysisResult {
  suggestedTier: ScopeTier;
  confidence: number;
  reasoning: string;
}

/**
 * Codebase-context signals extracted by scanning the context string passed in.
 * Each boolean flag increases or decreases tier confidence.
 */
interface CodebaseSignals {
  /** Number of distinct file extensions referenced in the context (proxy for breadth) */
  fileTypeCount: number;
  /** True if context mentions multiple distinct directories */
  multipleDirectories: boolean;
  /** True if context mentions test files */
  hasTestFiles: boolean;
  /** True if context mentions config/schema/migration files */
  hasSchemaFiles: boolean;
  /** Estimated total file count referenced */
  estimatedFileCount: number;
}

/**
 * Parse codebase context string for structural signals that affect scope.
 * The context is free-form text — typically a git diff, file listing, or
 * summary produced by the caller. We extract heuristic signals from it.
 */
function parseCodebaseSignals(context: string): CodebaseSignals {
  const normalized = context.toLowerCase();

  // Count distinct file extensions
  const extMatches = context.match(/\.\w{1,6}(?=[\s,\n"'\])]|$)/g) ?? [];
  const extSet = new Set(extMatches.map((e) => e.toLowerCase()));
  const fileTypeCount = extSet.size;

  // Detect multiple directories (two or more path separators in different prefixes)
  const dirMatches = context.match(/(?:^|\s|")([\w./\\-]+\/[\w./\\-]+)/gm) ?? [];
  const dirPrefixes = new Set(
    dirMatches
      .map((m) => m.trim().replace(/^["']/, "").split("/")[0] ?? "")
      .filter((d) => d.length > 0 && d !== "." && d !== ".."),
  );
  const multipleDirectories = dirPrefixes.size > 2;

  // Test file signal
  const hasTestFiles =
    normalized.includes(".test.") ||
    normalized.includes(".spec.") ||
    normalized.includes("__tests__") ||
    normalized.includes("/test/");

  // Schema/config/migration signal — these often require wide changes
  const hasSchemaFiles =
    normalized.includes("schema") ||
    normalized.includes("migration") ||
    normalized.includes("config.") ||
    normalized.includes(".env");

  // Rough file count estimate from lines that look like file paths
  const fileLineMatches = context.match(/\b\w[\w./\\-]*\.\w{1,6}\b/g) ?? [];
  const uniqueFilePaths = new Set(fileLineMatches);
  const estimatedFileCount = uniqueFilePaths.size;

  return { fileTypeCount, multipleDirectories, hasTestFiles, hasSchemaFiles, estimatedFileCount };
}

/**
 * Intelligently analyze a user's message to auto-detect the appropriate
 * surgical scope tier (narrow / medium / wide).
 *
 * Combines two signal sources:
 *   1. **Intent signals** — lexical patterns in the user message itself
 *      (same signals used by `detectSurgicalScope`, but mapped to a confidence score)
 *   2. **Codebase context signals** — structural hints from the codebase
 *      context string (file counts, directory depth, schema files, tests)
 *
 * The final `confidence` is a 0–1 float:
 *   - 0.9+ = very strong signal (e.g. "fix typo" + single small file context)
 *   - 0.7–0.89 = strong signal (unambiguous intent, no conflicting context)
 *   - 0.5–0.69 = moderate signal (intent clear but context adds uncertainty)
 *   - < 0.5 = weak / conflicting signals — caller should ask for confirmation
 *
 * @param userMessage     The raw message the user typed (e.g. "fix typo in login")
 * @param codebaseContext Free-form context about touched files (may be empty string)
 */
export function analyzeScopeFromIntent(
  userMessage: string,
  codebaseContext: string,
): ScopeAnalysisResult {
  const msg = userMessage.toLowerCase().trim();

  // ── Step 1: Intent-tier detection via existing signal arrays ──────────────
  // We reuse detectSurgicalScope for the primary intent match, then adjust
  // confidence based on how "strong" the matched signal was.

  const intentScope = detectSurgicalScope(userMessage);
  const intentTier = intentScope.scopeTier;

  // Base confidence: narrow/wide signals are more specific → higher base;
  // medium default gets lowest base confidence.
  let confidence: number;
  const isDefaultFallback = intentScope.scopeLabel.includes("default");

  if (isDefaultFallback) {
    confidence = 0.4; // No explicit signal — we're guessing
  } else if (intentTier === "narrow") {
    // Narrow signals are very specific (typo, null check, etc.)
    confidence = 0.85;
  } else if (intentTier === "wide") {
    // Wide signals like "refactor" are fairly clear
    confidence = 0.80;
  } else {
    // Medium signals are somewhat ambiguous
    confidence = 0.65;
  }

  // ── Step 2: Amplify/reduce confidence from explicit scope words ───────────
  // Words like "entire", "whole", "all" push toward wide with high confidence.
  const wholeSystemWords = ["entire", "whole system", "whole codebase", "all modules", "every file", "everywhere"];
  const singleTargetWords = ["in the file", "on line", "in this function", "this one"];

  for (const w of wholeSystemWords) {
    if (msg.includes(w)) {
      confidence = Math.min(1.0, confidence + 0.15);
    }
  }
  for (const w of singleTargetWords) {
    if (msg.includes(w)) {
      confidence = Math.min(1.0, confidence + 0.10);
    }
  }

  // ── Step 3: Codebase context signals ──────────────────────────────────────
  const ctx = parseCodebaseSignals(codebaseContext);
  const reasonParts: string[] = [];

  // Build the primary reasoning line
  const matchedSignal = isDefaultFallback
    ? "no strong intent signal"
    : intentScope.scopeLabel;

  reasonParts.push(`Intent: ${matchedSignal}`);

  // Context adjustments
  if (codebaseContext.trim().length > 0) {
    if (ctx.estimatedFileCount > 0) {
      reasonParts.push(`Context references ~${ctx.estimatedFileCount} file(s)`);
    }

    if (ctx.estimatedFileCount >= 6 && intentTier !== "wide") {
      // Many files touched — bump toward wide
      confidence = Math.max(0.3, confidence - 0.15);
      reasonParts.push("context spans many files (nudging toward wider scope)");
    } else if (ctx.estimatedFileCount === 1 && intentTier === "narrow") {
      // Single file + narrow intent = high confidence narrow
      confidence = Math.min(1.0, confidence + 0.10);
      reasonParts.push("single file in context (reinforces narrow)");
    }

    if (ctx.multipleDirectories && intentTier === "narrow") {
      confidence = Math.max(0.3, confidence - 0.20);
      reasonParts.push("context spans multiple directories (conflicts with narrow)");
    }

    if (ctx.hasSchemaFiles && intentTier !== "wide") {
      confidence = Math.max(0.3, confidence - 0.10);
      reasonParts.push("schema/config files in context (may require wider changes)");
    }

    if (ctx.hasTestFiles && intentTier === "medium") {
      // Test files expected for medium scope — reinforces confidence
      confidence = Math.min(1.0, confidence + 0.05);
      reasonParts.push("test files present (consistent with medium scope)");
    }

    if (ctx.fileTypeCount >= 4 && intentTier === "narrow") {
      confidence = Math.max(0.3, confidence - 0.15);
      reasonParts.push(`${ctx.fileTypeCount} file types in context (conflicts with narrow)`);
    }
  }

  // Clamp confidence to [0.1, 1.0]
  confidence = Math.max(0.1, Math.min(1.0, confidence));
  // Round to 2 decimal places
  confidence = Math.round(confidence * 100) / 100;

  const reasoning = reasonParts.join("; ");

  return {
    suggestedTier: intentTier,
    confidence,
    reasoning,
  };
}

/**
 * SurgicalScopeAnalyzer — class wrapper around `analyzeScopeFromIntent` for
 * consumers that prefer an object-oriented API or want to batch multiple analyses.
 *
 * Also integrates with SurgicalCostOptimizer to gate tier promotion decisions
 * on cost/quality scoring.  When a SurgicalCostOptimizer instance is attached
 * via `setCostOptimizer()`, the `shouldPromoteTier()` helper delegates to it so
 * that every promotion decision is cost-aware.
 */
export class SurgicalScopeAnalyzer {
  private costOptimizer?: import("./surgical-cost-optimizer.ts").SurgicalCostOptimizer;

  /**
   * Attach a SurgicalCostOptimizer.  When attached, `shouldPromoteTier()` feeds
   * the current confidence score into the optimizer's promotion scoring logic.
   */
  setCostOptimizer(
    optimizer: import("./surgical-cost-optimizer.ts").SurgicalCostOptimizer,
  ): void {
    this.costOptimizer = optimizer;
  }

  /**
   * Evaluate whether a tier promotion is advisable by consulting the attached
   * cost optimizer.  Returns `true` (promote) when no optimizer is attached —
   * this preserves backward-compatible behavior for callers that have not opted
   * in to cost-aware promotion.
   *
   * @param fromTier  Numeric tier (1–4) currently active.
   * @param toTier    Numeric tier (1–4) being proposed.
   * @param confidence Current intent-analysis confidence (0–1).
   */
  shouldPromoteTier(
    fromTier: 1 | 2 | 3 | 4,
    toTier: 1 | 2 | 3 | 4,
    confidence: number,
  ): boolean {
    if (!this.costOptimizer) return true; // no optimizer → always allow

    this.costOptimizer.setConfidence(confidence);
    const result = this.costOptimizer.scorePromotion(fromTier, toTier);
    return result.shouldPromote;
  }

  /**
   * Analyze a user message and optional codebase context, returning a tier
   * suggestion with confidence and human-readable reasoning.
   */
  analyze(userMessage: string, codebaseContext = ""): ScopeAnalysisResult {
    return analyzeScopeFromIntent(userMessage, codebaseContext);
  }

  /**
   * Format the analysis result as a short human-readable string suitable for
   * displaying in the REPL before the user confirms or overrides the tier.
   *
   * Example output:
   *   Suggested tier: narrow (confidence: 85%)
   *   Reasoning: Intent: narrow (matched: "fix typo"); single file in context (reinforces narrow)
   *   Override with: /surgical narrow | /surgical medium | /surgical wide
   */
  formatSuggestion(result: ScopeAnalysisResult): string {
    const pct = Math.round(result.confidence * 100);
    return [
      `  Suggested tier: ${result.suggestedTier} (confidence: ${pct}%)`,
      `  Reasoning: ${result.reasoning}`,
      `  Override: /surgical narrow | /surgical medium | /surgical wide`,
    ].join("\n");
  }
}
