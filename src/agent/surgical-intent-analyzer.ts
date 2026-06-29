/**
 * Surgical Mode Intent-Based Tier Auto-Promotion with Semantic Analysis.
 *
 * Builds on the existing surgical scope/tier infrastructure to provide:
 *
 *   1. Intent scope classification: narrow / medium / wide from goal + tool history
 *   2. Semantic keyword–driven tier auto-promotion:
 *        'install', 'build', 'test'    → min tier 3
 *        'write new', 'create file'    → min tier 2
 *        read-only patterns            → tier 1
 *   3. Session-scoped tool call history tracking with scope-creep detection
 *      (tier degradation when user switches from a fix intent to an install intent)
 *   4. `analyzeIntent(goal, history)` → { tier: 1–4, confidence, reasoning }
 *
 * The returned `tier` is always 1–4 aligned with SurgicalTier in surgical-tier-promoter.ts.
 * The `confidence` is a 0–1 float. `reasoning` is a human-readable JSON-serialisable string.
 *
 * Integration points:
 *   - `/surgical status` — enhanced display via `formatIntentStatus()`
 *   - cli.ts startup — `autoPromoteTierFromGoal()` applies tier before first turn
 */

import type { SurgicalTier } from "../tools/guards/surgical-tier-promoter.ts";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A recorded tool call in the session history. Callers populate this from the
 * tool-executor pipeline. Only `name` is required; `args` is optional context.
 */
export interface ToolCall {
  /** Tool name as registered, e.g. "Bash", "Edit", "Read" */
  name: string;
  /** Optional serialised arguments for richer signal extraction */
  args?: Record<string, unknown>;
  /** Millisecond timestamp (Date.now()) — used for recency weighting */
  at?: number;
}

/** Inferred intent scope — mirrors ScopeTier but explicit about derivation. */
export type IntentScope = "narrow" | "medium" | "wide";

/** Full analysis result returned by `analyzeIntent`. */
export interface IntentAnalysisResult {
  /** Recommended surgical tier (1–4). */
  tier: SurgicalTier;
  /** Confidence in [0, 1]. Values below 0.8 trigger a UI prompt. */
  confidence: number;
  /** Human-readable explanation of why this tier was chosen. */
  reasoning: string;
  /** Inferred intent scope label (narrow / medium / wide). */
  scope: IntentScope;
  /**
   * Whether scope creep was detected from the tool history.
   * True when recent history shows a shift toward wider operations than the
   * stated goal implies.
   */
  scopeCreepDetected: boolean;
}

// ── Keyword signal tables ─────────────────────────────────────────────────────

/**
 * Keywords/phrases that force a MINIMUM of Tier 3 (balanced).
 * Rationale: these operations mutate system state (package manager, build
 * artefacts, test runner) and need at least safe-Bash access.
 */
const MIN_TIER3_KEYWORDS: string[] = [
  "install",
  "npm install",
  "bun install",
  "yarn install",
  "pnpm install",
  "pip install",
  "cargo install",
  "brew install",
  "apt install",
  "build",
  "compile",
  "bundle",
  "transpile",
  "run tests",
  "run test",
  "execute tests",
  "bun test",
  "npm test",
  "jest",
  "vitest",
  "mocha",
  "deploy",
  "publish",
  "release",
  "run script",
  "execute script",
  "run command",
  "shell",
  "bash",
  "terminal",
  "run lint",
  "run format",
  "lint and format",
  "format the",
  "typecheck",
  "type check",
  "type-check",
];

/**
 * Keywords/phrases that force a MINIMUM of Tier 2 (fine).
 * Rationale: these create or write new files but don't need broad shell access.
 */
const MIN_TIER2_KEYWORDS: string[] = [
  "write new",
  "create file",
  "create a file",
  "new file",
  "add file",
  "create component",
  "create class",
  "create module",
  "write file",
  "generate file",
  "scaffold",
  "create test",
  "write test",
  "add test file",
  "new test",
  "create config",
  "add config",
  "write config",
  "create type",
  "add type",
  "write interface",
  "create interface",
];

/**
 * Patterns that strongly suggest READ-ONLY intent → Tier 1.
 * Must be checked before the tier-2/3 tables.
 */
const READ_ONLY_KEYWORDS: string[] = [
  "show me",
  "what is",
  "what are",
  "find where",
  "search for",
  "look at",
  "read the",
  "read this",
  "list all",
  "grep for",
  "check if",
  "does this file",
  "what does",
  "explain",
  "describe",
  "summarise",
  "summarize",
  "how does",
  "where is",
  "show the",
  "view the",
  "print the",
  "output the",
  "display the",
  "inspect",
  "analyze",
  "analyse",
];

/**
 * Wide-scope patterns → Tier 4 (broad), same set as surgical-tier-promoter.
 */
const WIDE_SCOPE_KEYWORDS: string[] = [
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
  "large change",
  "major change",
  "overhaul",
];

// ── Tool-call history signals ─────────────────────────────────────────────────

/** Tools that indicate a narrow, read-only session. */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "Diff"]);

/** Tools that indicate single-file write scope. */
const SINGLE_FILE_TOOLS = new Set(["Edit"]);

/** Tools that indicate broader shell/build scope. */
const SHELL_TOOLS = new Set(["Bash", "Powershell"]);

/** Tools that indicate wide multi-agent scope. */
const WIDE_TOOLS = new Set(["Agent", "Coordinate", "Write"]);

// ── Core analysis logic ───────────────────────────────────────────────────────

/**
 * Infer the intent scope from the goal string alone.
 * Returns { scope, baseTier, baseConfidence, matchedSignal }.
 */
function inferScopeFromGoal(goal: string): {
  scope: IntentScope;
  baseTier: SurgicalTier;
  baseConfidence: number;
  matchedSignal: string;
} {
  const normalized = goal.toLowerCase().trim();

  // Wide first — dominates all others
  for (const kw of WIDE_SCOPE_KEYWORDS) {
    if (normalized.includes(kw)) {
      return { scope: "wide", baseTier: 4, baseConfidence: 0.82, matchedSignal: kw };
    }
  }

  // Min-tier-3 keywords (build/install/test): medium scope, tier 3
  const tier3Sorted = [...MIN_TIER3_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const kw of tier3Sorted) {
    if (normalized.includes(kw)) {
      return { scope: "medium", baseTier: 3, baseConfidence: 0.80, matchedSignal: kw };
    }
  }

  // Read-only: narrow scope, tier 1
  for (const kw of READ_ONLY_KEYWORDS) {
    if (normalized.includes(kw)) {
      return { scope: "narrow", baseTier: 1, baseConfidence: 0.88, matchedSignal: kw };
    }
  }

  // Narrow: single-token fixes
  const narrowFixPatterns = [
    "fix typo", "typo", "fix comment", "null check", "undefined check",
    "off-by-one", "off by one", "missing semicolon", "missing comma",
    "missing bracket", "rename variable", "rename parameter",
    "one-line", "one line", "single line", "fix lint", "fix warning",
  ];
  const narrowSorted = [...narrowFixPatterns].sort((a, b) => b.length - a.length);
  for (const kw of narrowSorted) {
    if (normalized.includes(kw)) {
      return { scope: "narrow", baseTier: 1, baseConfidence: 0.88, matchedSignal: kw };
    }
  }

  // Min-tier-2 keywords (create file / write new): narrow→medium scope, tier 2
  const tier2Sorted = [...MIN_TIER2_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const kw of tier2Sorted) {
    if (normalized.includes(kw)) {
      return { scope: "narrow", baseTier: 2, baseConfidence: 0.78, matchedSignal: kw };
    }
  }

  // Single-file fix signals → tier 2
  const tier2FixPatterns = [
    "fix bug", "fix crash", "fix error", "fix a bug",
    "add a line", "delete a line", "remove a line", "change a line",
    "patch", "update this function", "change this method",
    "in this file", "on line", "this function", "this method",
    "fix this", "add null",
  ];
  const tier2FixSorted = [...tier2FixPatterns].sort((a, b) => b.length - a.length);
  for (const kw of tier2FixSorted) {
    if (normalized.includes(kw)) {
      return { scope: "narrow", baseTier: 2, baseConfidence: 0.75, matchedSignal: kw };
    }
  }

  // Medium-scope signals (test/function/import fixes): tier 3
  const tier3FixPatterns = [
    "fix failing test", "fix the test", "fix test",
    "update test", "add test", "write test",
    "add type", "fix type", "fix import", "update import", "add import",
    "fix export", "update export", "add export",
    "fix interface", "update interface",
    "fix function", "update function", "add function",
    "fix method", "update method", "add method",
    "fix",
  ];
  const tier3FixSorted = [...tier3FixPatterns].sort((a, b) => b.length - a.length);
  for (const kw of tier3FixSorted) {
    if (normalized.includes(kw)) {
      return { scope: "medium", baseTier: 3, baseConfidence: 0.65, matchedSignal: kw };
    }
  }

  // Default: medium, tier 3, low confidence
  return { scope: "medium", baseTier: 3, baseConfidence: 0.40, matchedSignal: "(default)" };
}

/**
 * Analyse tool call history to determine the "observed" tier and whether
 * scope creep has occurred relative to the stated goal tier.
 *
 * Returns:
 *   observedTier    — the tier implied by the actual tools used
 *   scopeCreep      — true if observed tier > stated goal tier
 *   historyReasonPart — fragment added to reasoning string
 */
function analyzeHistory(
  history: ToolCall[],
  goalTier: SurgicalTier,
): {
  observedTier: SurgicalTier;
  scopeCreep: boolean;
  historyReasonPart: string;
} {
  if (history.length === 0) {
    return { observedTier: goalTier, scopeCreep: false, historyReasonPart: "no history" };
  }

  // Take the last 20 tool calls for recency bias
  const recent = history.slice(-20);

  let maxObservedTier: SurgicalTier = 1;
  const toolNames = recent.map((t) => t.name);
  const toolCounts: Record<string, number> = {};
  for (const name of toolNames) {
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
  }

  for (const name of toolNames) {
    if (WIDE_TOOLS.has(name)) {
      maxObservedTier = Math.max(maxObservedTier, 4) as SurgicalTier;
    } else if (SHELL_TOOLS.has(name)) {
      maxObservedTier = Math.max(maxObservedTier, 3) as SurgicalTier;
    } else if (SINGLE_FILE_TOOLS.has(name)) {
      maxObservedTier = Math.max(maxObservedTier, 2) as SurgicalTier;
    } else if (READ_ONLY_TOOLS.has(name)) {
      maxObservedTier = Math.max(maxObservedTier, 1) as SurgicalTier;
    }
  }

  // Check for Bash commands that imply install/build/test
  for (const tc of recent) {
    if (tc.name === "Bash" && tc.args) {
      const cmd = String(tc.args.command ?? "").toLowerCase();
      for (const kw of MIN_TIER3_KEYWORDS) {
        if (cmd.includes(kw)) {
          maxObservedTier = Math.max(maxObservedTier, 3) as SurgicalTier;
        }
      }
    }
  }

  const scopeCreep = maxObservedTier > goalTier;

  // Build a short summary of distinct tools seen
  const distinctTools = [...new Set(toolNames)];
  const topTools = distinctTools.slice(0, 4).join(", ");
  const historyReasonPart = `history (${recent.length} calls: ${topTools}${distinctTools.length > 4 ? ", ..." : ""}) → observed Tier ${maxObservedTier}`;

  return { observedTier: maxObservedTier, scopeCreep, historyReasonPart };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse a user goal + session tool-call history to produce a recommended
 * SurgicalTier (1–4) with confidence and JSON-serialisable reasoning.
 *
 * Auto-promotion rules:
 *   - 'install' / 'build' / 'test' keywords → min tier 3 (even if goal says narrow)
 *   - 'write new' / 'create file' keywords → min tier 2
 *   - read-only patterns → tier 1
 *   - Scope creep in history → bump tier to observed max, reduce confidence 15%
 *   - Scope regression (switching from 'install' back to 'fix typo') → demote
 *     with confidence penalty
 *
 * @param goal    The user's stated goal string.
 * @param history Ordered list of tool calls executed so far in this session.
 */
export function analyzeIntent(goal: string, history: ToolCall[]): IntentAnalysisResult {
  // Step 1: infer from goal
  const { scope, baseTier, baseConfidence, matchedSignal } = inferScopeFromGoal(goal);

  // Step 2: analyse tool history
  const { observedTier, scopeCreep, historyReasonPart } = analyzeHistory(history, baseTier);

  // Step 3: reconcile goal tier vs observed tier
  let finalTier: SurgicalTier = baseTier;
  let confidence = baseConfidence;
  const reasonParts: string[] = [];

  if (matchedSignal === "(default)") {
    reasonParts.push("Goal: no strong scope signal → default Tier 3");
  } else {
    reasonParts.push(`Goal: "${matchedSignal}" → Tier ${baseTier}`);
  }

  if (history.length > 0) {
    reasonParts.push(historyReasonPart);
  }

  if (scopeCreep) {
    // History shows wider operations than goal implies → auto-promote
    finalTier = observedTier;
    confidence = Math.max(0.30, confidence - 0.15);
    reasonParts.push(
      `scope creep: goal implied Tier ${baseTier} but history reached Tier ${observedTier} → promoted`,
    );
  } else if (observedTier < baseTier && history.length >= 3) {
    // History shows narrower operations than goal — mild confidence boost
    confidence = Math.min(1.0, confidence + 0.05);
    reasonParts.push("history confirms narrower-than-goal operations (confidence +5%)");
  }

  // Step 4: enforce keyword-based minimum tiers regardless of history
  const normalizedGoal = goal.toLowerCase();

  // Min tier 3: install/build/test keywords override everything below
  const tier3Match = MIN_TIER3_KEYWORDS.find((kw) => normalizedGoal.includes(kw));
  if (tier3Match && finalTier < 3) {
    finalTier = 3;
    reasonParts.push(`keyword "${tier3Match}" forces min Tier 3 (install/build/test scope)`);
  }

  // Min tier 2: create-file/write-new keywords override tier 1
  const tier2Match = MIN_TIER2_KEYWORDS.find((kw) => normalizedGoal.includes(kw));
  if (tier2Match && finalTier < 2) {
    finalTier = 2;
    reasonParts.push(`keyword "${tier2Match}" forces min Tier 2 (file-creation scope)`);
  }

  // Step 5: clamp and round
  finalTier = Math.max(1, Math.min(4, finalTier)) as SurgicalTier;
  confidence = Math.max(0.10, Math.min(1.0, confidence));
  confidence = Math.round(confidence * 100) / 100;

  return {
    tier: finalTier,
    confidence,
    reasoning: reasonParts.join("; "),
    scope,
    scopeCreepDetected: scopeCreep,
  };
}

// ── Session history tracker ───────────────────────────────────────────────────

/**
 * Session-scoped tool call history tracker.
 *
 * Maintains an ordered log of tool calls per session, enforcing a configurable
 * maximum size with a sliding-window eviction strategy. Thread-safe for a
 * single-threaded Bun environment (no concurrent mutations).
 */
export class SessionIntentTracker {
  private history: ToolCall[] = [];
  private readonly maxSize: number;
  private sessionGoal: string = "";

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  /** Set or update the current session goal. */
  setGoal(goal: string): void {
    this.sessionGoal = goal;
  }

  /** Record a tool call. Oldest entries are evicted once maxSize is reached. */
  record(call: ToolCall): void {
    this.history.push({ ...call, at: call.at ?? Date.now() });
    if (this.history.length > this.maxSize) {
      this.history.shift();
    }
  }

  /** Return a shallow copy of the full history. */
  getHistory(): ToolCall[] {
    return [...this.history];
  }

  /** Return the last N tool calls. */
  getRecent(n = 20): ToolCall[] {
    return this.history.slice(-n);
  }

  /** Analyse the current session goal against accumulated history. */
  analyzeCurrentIntent(): IntentAnalysisResult {
    return analyzeIntent(this.sessionGoal, this.history);
  }

  /** Clear history (e.g. on new goal or session reset). */
  reset(): void {
    this.history = [];
    this.sessionGoal = "";
  }

  /** Return the number of recorded tool calls. */
  size(): number {
    return this.history.length;
  }
}

// ── Module-level singleton tracker ───────────────────────────────────────────

let _globalTracker: SessionIntentTracker | null = null;

/** Get or create the module-level session tracker. */
export function getGlobalIntentTracker(): SessionIntentTracker {
  if (!_globalTracker) {
    _globalTracker = new SessionIntentTracker();
  }
  return _globalTracker;
}

/** Replace the module-level tracker (e.g. on session start). */
export function setGlobalIntentTracker(tracker: SessionIntentTracker): void {
  _globalTracker = tracker;
}

/** Reset the module-level tracker (for testing). */
export function resetGlobalIntentTracker(): void {
  _globalTracker = null;
}

// ── `/surgical status` enhancement ───────────────────────────────────────────

/**
 * Format a rich status string for the `/surgical status` enhancement.
 *
 * Shows:
 *   - Current tier (from the surgical gate)
 *   - Confidence %
 *   - Suggested tier from intent analysis
 *   - Whether a UI prompt is recommended (confidence < 80%)
 *   - Override options
 *
 * @param currentTier   The tier currently set in the surgical gate (1–4 or legacy string).
 * @param analysis      Result from `analyzeIntent()`.
 */
export function formatIntentStatus(
  currentTier: SurgicalTier | "narrow" | "medium" | "wide" | null,
  analysis: IntentAnalysisResult,
): string {
  const pct = Math.round(analysis.confidence * 100);
  const shouldPrompt = analysis.confidence < 0.8;

  const tierLabel = currentTier === null ? "off" : String(currentTier);
  const suggestedLabel = `Tier ${analysis.tier} (${analysis.scope})`;

  const lines: string[] = [
    "",
    "  ── Surgical Intent Status ──────────────────────────────",
    `  Current tier:   ${tierLabel}`,
    `  Suggested tier: ${suggestedLabel}`,
    `  Confidence:     ${pct}%${shouldPrompt ? " ⚠ low — manual override recommended" : ""}`,
    `  Scope:          ${analysis.scope}${analysis.scopeCreepDetected ? " (scope creep detected)" : ""}`,
    `  Reasoning:      ${analysis.reasoning}`,
    "",
    "  Override options:",
    "    /surgical narrow   — Tier 1: read-only exploration",
    "    /surgical medium   — Tier 3: balanced (Bash safe patterns)",
    "    /surgical wide     — Tier 4: all tools",
    "    /surgical off      — disable surgical gate",
    "",
  ];

  return lines.join("\n");
}

// ── cli.ts startup helper ─────────────────────────────────────────────────────

/**
 * Auto-promote the surgical tier on CLI startup based on the initial task goal.
 *
 * Returns the recommended tier and whether a UI prompt should be shown.
 * Callers (cli.ts) decide whether to apply the tier or ask the user.
 *
 * Confidence threshold for silent auto-apply: 80% (matches existing gate logic).
 *
 * @param goal    The --goal flag value from CLI args (or first REPL message).
 * @param history Any existing tool call history (usually empty on startup).
 */
export function autoPromoteTierFromGoal(
  goal: string,
  history: ToolCall[] = [],
): {
  analysis: IntentAnalysisResult;
  shouldAutoApply: boolean;
  shouldPromptUser: boolean;
} {
  const analysis = analyzeIntent(goal, history);
  const shouldAutoApply = analysis.confidence >= 0.8;
  const shouldPromptUser = !shouldAutoApply && analysis.confidence >= 0.5;

  return { analysis, shouldAutoApply, shouldPromptUser };
}
