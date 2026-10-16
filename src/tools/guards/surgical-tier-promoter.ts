/**
 * Surgical Tier Promoter — confidence-based tier promotion/demotion within a goal.
 *
 * Implements the 4-tier surgical mode system:
 *
 *   Tier 1 (micro):    Read, Glob, Grep, LS only — pure exploration, no writes
 *   Tier 2 (fine):     + Edit (single file), still no Bash
 *   Tier 3 (balanced): + Bash (safe patterns), + multi-file Edit
 *   Tier 4 (broad):    All tools (equivalent to previous "wide" mode)
 *
 * Key behaviors:
 *   - analyzeScopeFromIntent() maps a user message → suggested tier + confidence
 *   - Users can override via `/surgical set <tier>` (handled by callers)
 *   - After a successful tool call on tier N → auto-promote to tier N+1 for next call
 *   - After an error on tier N → demote to tier N-1
 *   - Tier-success ratios are tracked per user+codebase for telemetry
 *
 * The promoter is stateful per goal session. Create a new instance for each
 * surgical goal, or call reset() to start a new goal on an existing instance.
 */

import type { ScopeTier } from "../../agent/surgical-scope.ts";

// ---------------------------------------------------------------------------
// 4-tier type
// ---------------------------------------------------------------------------

export type SurgicalTier = 1 | 2 | 3 | 4;

export interface TierDescriptor {
  tier: SurgicalTier;
  name: string;
  label: string;
  description: string;
}

export const TIER_DESCRIPTORS: Record<SurgicalTier, TierDescriptor> = {
  1: {
    tier: 1,
    name: "micro",
    label: "Tier 1 (micro)",
    description: "Read-only exploration: Read, Glob, Grep, LS",
  },
  2: {
    tier: 2,
    name: "fine",
    label: "Tier 2 (fine)",
    description: "Single-file edits: + Edit (single file), no Bash",
  },
  3: {
    tier: 3,
    name: "balanced",
    label: "Tier 3 (balanced)",
    description: "Controlled writes: + Bash (safe patterns), multi-file Edit",
  },
  4: {
    tier: 4,
    name: "broad",
    label: "Tier 4 (broad)",
    description: "All tools allowed (same as normal mode)",
  },
};

// ---------------------------------------------------------------------------
// Mapping between legacy ScopeTier and new SurgicalTier
// ---------------------------------------------------------------------------

/**
 * Map legacy 3-tier ScopeTier strings to the new 4-tier numeric system.
 * Used so existing callers that pass ScopeTier still work.
 */
export function scopeTierToSurgicalTier(tier: ScopeTier): SurgicalTier {
  switch (tier) {
    case "narrow": return 1;
    // Legacy "medium" allows Bash with safe patterns — maps to Tier 3 (balanced)
    // which also permits Bash safe patterns. Tier 2 (fine) blocks Bash entirely.
    case "medium": return 3;
    case "wide":   return 4;
  }
}

/** Map a SurgicalTier back to the closest ScopeTier for backward-compat. */
export function surgicalTierToScopeTier(tier: SurgicalTier): ScopeTier {
  switch (tier) {
    case 1: return "narrow";
    case 2: return "narrow"; // fine (no Bash) is closest to narrow in restrictions
    case 3: return "medium"; // balanced (safe Bash) matches legacy medium behavior
    case 4: return "wide";
  }
}

// ---------------------------------------------------------------------------
// Tier suggestion from intent
// ---------------------------------------------------------------------------

export interface TierSuggestion {
  suggestedTier: SurgicalTier;
  confidence: number;
  reasoning: string;
}

/**
 * Analyze a user message and optional codebase context to suggest an
 * appropriate SurgicalTier (1–4) with a confidence score.
 *
 * Strategy:
 *   - Very narrow single-token/single-line signals → Tier 1 (micro)
 *   - Focused single-file edit signals → Tier 2 (fine)
 *   - Multi-file or test/function add signals → Tier 3 (balanced)
 *   - Wide/refactor/implement signals → Tier 4 (broad)
 *
 * @param userMessage     Raw goal string from the user
 * @param codebaseContext Optional free-form context (file listing, diff summary, etc.)
 */
export function analyzeScopeFromIntent(
  userMessage: string,
  codebaseContext = "",
): TierSuggestion {
  const msg = userMessage.toLowerCase().trim();

  // ── Tier 4 (broad) signals — wide changes ──────────────────────────────
  const tier4Patterns = [
    "refactor", "reorganize", "restructure", "rewrite", "add feature",
    "new feature", "implement", "migrate", "extract", "move module",
    "rename module", "rename file", "across", "throughout", "all files",
    "everywhere", "update all", "replace all",
  ];

  for (const pattern of tier4Patterns) {
    if (msg.includes(pattern)) {
      return {
        suggestedTier: 4,
        confidence: 0.80,
        reasoning: `Wide-scope signal matched: "${pattern}" → Tier 4 (broad)`,
      };
    }
  }

  // ── Tier 1 (micro) signals — pure read-only exploration ────────────────
  // Very specific: "show me", "what is", "find", "search", "look at", "read"
  const tier1Patterns = [
    "show me", "what is", "what are", "find where", "search for",
    "look at", "read the", "read this", "list all", "grep for",
    "check if", "does this file", "what does",
  ];

  for (const pattern of tier1Patterns) {
    if (msg.includes(pattern)) {
      return {
        suggestedTier: 1,
        confidence: 0.85,
        reasoning: `Read-only intent matched: "${pattern}" → Tier 1 (micro)`,
      };
    }
  }

  // ── Tier 1 (micro) narrow edit signals — single token fixes ────────────
  const tier1NarrowPatterns = [
    "fix typo", "typo", "fix comment", "null check", "undefined check",
    "off-by-one", "off by one", "missing semicolon", "missing comma",
    "missing bracket", "rename variable", "rename parameter",
    "one-line", "one line", "single line",
    "fix lint", "fix warning",
  ];

  // Sort longest first so multi-word phrases beat single-word fallbacks
  const tier1Sorted = [...tier1NarrowPatterns].sort((a, b) => b.length - a.length);
  for (const pattern of tier1Sorted) {
    if (msg.includes(pattern)) {
      return {
        suggestedTier: 1,
        confidence: 0.88,
        reasoning: `Micro-scope signal matched: "${pattern}" → Tier 1 (micro)`,
      };
    }
  }

  // ── Tier 2 (fine) signals — single-file edits ──────────────────────────
  const tier2Patterns = [
    "fix bug", "fix crash", "fix error", "fix a bug",
    "add a line", "delete a line", "remove a line", "change a line",
    "patch", "update this function", "change this method",
    "in this file", "on line", "this function", "this method",
    "fix this", "add null",
  ];

  const tier2Sorted = [...tier2Patterns].sort((a, b) => b.length - a.length);
  for (const pattern of tier2Sorted) {
    if (msg.includes(pattern)) {
      return {
        suggestedTier: 2,
        confidence: 0.78,
        reasoning: `Fine-scope signal matched: "${pattern}" → Tier 2 (fine)`,
      };
    }
  }

  // ── Tier 3 (balanced) signals — multi-file, tests, functions ───────────
  const tier3Patterns = [
    "fix test", "fix failing test", "fix the test",
    "update test", "add test", "write test",
    "add type", "fix type", "fix import", "update import", "add import",
    "fix export", "update export", "add export",
    "fix interface", "update interface",
    "fix function", "update function", "add function",
    "fix method", "update method", "add method",
    "fix",
  ];

  const tier3Sorted = [...tier3Patterns].sort((a, b) => b.length - a.length);
  for (const pattern of tier3Sorted) {
    if (msg.includes(pattern)) {
      // Adjust confidence based on codebase context size
      let confidence = 0.65;
      if (codebaseContext.trim().length > 0) {
        const fileCount = (codebaseContext.match(/\b\w[\w./\\-]*\.\w{1,6}\b/g) ?? []).length;
        if (fileCount > 5) confidence = Math.max(0.40, confidence - 0.15);
        if (fileCount === 1) confidence = Math.min(0.80, confidence + 0.10);
      }
      return {
        suggestedTier: 3,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: `Balanced-scope signal matched: "${pattern}" → Tier 3 (balanced)`,
      };
    }
  }

  // ── Default: Tier 3 (balanced) — no strong signal ──────────────────────
  return {
    suggestedTier: 3,
    confidence: 0.40,
    reasoning: "No strong scope signal detected; defaulting to Tier 3 (balanced)",
  };
}

// ---------------------------------------------------------------------------
// Per-goal tier telemetry
// ---------------------------------------------------------------------------

export interface TierTelemetryEntry {
  tier: SurgicalTier;
  successes: number;
  errors: number;
}

export interface TierTelemetryRecord {
  /** Key: "<userId>:<codebaseId>" */
  key: string;
  tiers: Record<SurgicalTier, TierTelemetryEntry>;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/** In-memory store keyed by "<userId>:<codebaseId>" */
const _telemetryStore = new Map<string, TierTelemetryRecord>();

function makeTelemetryKey(userId: string, codebaseId: string): string {
  return `${userId}:${codebaseId}`;
}

function getOrCreateRecord(userId: string, codebaseId: string): TierTelemetryRecord {
  const key = makeTelemetryKey(userId, codebaseId);
  if (!_telemetryStore.has(key)) {
    _telemetryStore.set(key, {
      key,
      tiers: {
        1: { tier: 1, successes: 0, errors: 0 },
        2: { tier: 2, successes: 0, errors: 0 },
        3: { tier: 3, successes: 0, errors: 0 },
        4: { tier: 4, successes: 0, errors: 0 },
      },
      updatedAt: new Date().toISOString(),
    });
  }
  return _telemetryStore.get(key)!;
}

/** Record a successful tool execution on a tier for the given user+codebase. */
export function recordTierSuccess(userId: string, codebaseId: string, tier: SurgicalTier): void {
  const record = getOrCreateRecord(userId, codebaseId);
  record.tiers[tier].successes++;
  record.updatedAt = new Date().toISOString();
}

/** Record a failed tool execution on a tier for the given user+codebase. */
export function recordTierError(userId: string, codebaseId: string, tier: SurgicalTier): void {
  const record = getOrCreateRecord(userId, codebaseId);
  record.tiers[tier].errors++;
  record.updatedAt = new Date().toISOString();
}

/** Get success ratio (0–1) for a tier. Returns null if no data. */
export function getTierSuccessRatio(
  userId: string,
  codebaseId: string,
  tier: SurgicalTier,
): number | null {
  const record = _telemetryStore.get(makeTelemetryKey(userId, codebaseId));
  if (!record) return null;
  const entry = record.tiers[tier];
  const total = entry.successes + entry.errors;
  return total === 0 ? null : entry.successes / total;
}

/** Get full telemetry record for a user+codebase. Returns null if no data. */
export function getTierTelemetry(userId: string, codebaseId: string): TierTelemetryRecord | null {
  return _telemetryStore.get(makeTelemetryKey(userId, codebaseId)) ?? null;
}

/** Reset telemetry store (for testing). */
export function resetTierTelemetry(): void {
  _telemetryStore.clear();
}

// ---------------------------------------------------------------------------
// SurgicalTierPromoter — stateful per-goal promotion/demotion
// ---------------------------------------------------------------------------

export interface PromoterState {
  currentTier: SurgicalTier;
  consecutiveSuccesses: number;
  consecutiveErrors: number;
  promotions: number;
  demotions: number;
  /** Whether the current tier was set by an explicit user override */
  userOverride: boolean;
}

export interface PromoterConfig {
  /** Starting tier (auto-detected or user-set). Default: 3. */
  initialTier?: SurgicalTier;
  /** Successes needed to auto-promote. Default: 1. */
  successesRequiredForPromotion?: number;
  /** Errors needed to auto-demote. Default: 1. */
  errorsRequiredForDemotion?: number;
  /** User id for telemetry tracking. Default: "anonymous". */
  userId?: string;
  /** Codebase id (e.g. repo name) for telemetry tracking. Default: "default". */
  codebaseId?: string;
}

/**
 * Stateful per-goal manager for surgical tier promotion and demotion.
 *
 * Usage:
 *   const promoter = new SurgicalTierPromoter({ initialTier: 2 });
 *   promoter.onSuccess();  // promote tier
 *   promoter.onError();    // demote tier
 *   promoter.setUserOverride(3); // lock tier to 3 (user-driven)
 *   const tier = promoter.currentTier();
 */
export class SurgicalTierPromoter {
  private state: PromoterState;
  private config: Required<PromoterConfig>;

  constructor(config: PromoterConfig = {}) {
    this.config = {
      initialTier: config.initialTier ?? 3,
      successesRequiredForPromotion: config.successesRequiredForPromotion ?? 1,
      errorsRequiredForDemotion: config.errorsRequiredForDemotion ?? 1,
      userId: config.userId ?? "anonymous",
      codebaseId: config.codebaseId ?? "default",
    };
    this.state = {
      currentTier: this.config.initialTier,
      consecutiveSuccesses: 0,
      consecutiveErrors: 0,
      promotions: 0,
      demotions: 0,
      userOverride: false,
    };
  }

  /** Get the current active tier. */
  currentTier(): SurgicalTier {
    return this.state.currentTier;
  }

  /** Get the full state snapshot (for debugging/display). */
  getState(): Readonly<PromoterState> {
    return { ...this.state };
  }

  /**
   * Record a successful tool call at the current tier.
   * May promote the tier by one step if successesRequiredForPromotion is met.
   * Returns the new tier (may be unchanged if already at max or user-overridden).
   */
  onSuccess(): SurgicalTier {
    const tier = this.state.currentTier;
    recordTierSuccess(this.config.userId, this.config.codebaseId, tier);

    this.state.consecutiveErrors = 0;
    this.state.consecutiveSuccesses++;

    // User override locks the tier — no auto-promotion
    if (this.state.userOverride) {
      return tier;
    }

    if (
      this.state.consecutiveSuccesses >= this.config.successesRequiredForPromotion &&
      tier < 4
    ) {
      this.state.currentTier = (tier + 1) as SurgicalTier;
      this.state.consecutiveSuccesses = 0;
      this.state.promotions++;
    }

    return this.state.currentTier;
  }

  /**
   * Record a failed tool call at the current tier.
   * May demote the tier by one step if errorsRequiredForDemotion is met.
   * Returns the new tier (may be unchanged if already at Tier 1 or user-overridden).
   */
  onError(): SurgicalTier {
    const tier = this.state.currentTier;
    recordTierError(this.config.userId, this.config.codebaseId, tier);

    this.state.consecutiveSuccesses = 0;
    this.state.consecutiveErrors++;

    // User override locks the tier — no auto-demotion
    if (this.state.userOverride) {
      return tier;
    }

    if (
      this.state.consecutiveErrors >= this.config.errorsRequiredForDemotion &&
      tier > 1
    ) {
      this.state.currentTier = (tier - 1) as SurgicalTier;
      this.state.consecutiveErrors = 0;
      this.state.demotions++;
    }

    return this.state.currentTier;
  }

  /**
   * Set the tier explicitly (e.g. from `/surgical set <tier>` command).
   * Sets userOverride = true to prevent auto-promotion/demotion from overriding it.
   */
  setUserOverride(tier: SurgicalTier): void {
    this.state.currentTier = tier;
    this.state.consecutiveSuccesses = 0;
    this.state.consecutiveErrors = 0;
    this.state.userOverride = true;
  }

  /**
   * Clear the user override, re-enabling auto-promotion/demotion.
   */
  clearUserOverride(): void {
    this.state.userOverride = false;
  }

  /**
   * Reset the promoter to its initial state for a new goal within the same
   * user+codebase context. Telemetry is not reset (it accumulates).
   */
  reset(newInitialTier?: SurgicalTier): void {
    this.state = {
      currentTier: newInitialTier ?? this.config.initialTier,
      consecutiveSuccesses: 0,
      consecutiveErrors: 0,
      promotions: 0,
      demotions: 0,
      userOverride: false,
    };
  }

  /** Format a human-readable status summary. */
  formatStatus(): string {
    const { currentTier, promotions, demotions, userOverride } = this.state;
    const desc = TIER_DESCRIPTORS[currentTier];
    const overrideTag = userOverride ? " [user override]" : "";
    return [
      `  Active tier: ${desc.label}${overrideTag}`,
      `  Description: ${desc.description}`,
      `  Promotions this goal: ${promotions}, Demotions: ${demotions}`,
    ].join("\n");
  }

  /** Get success ratio for the current tier from historical telemetry. */
  currentTierSuccessRatio(): number | null {
    return getTierSuccessRatio(this.config.userId, this.config.codebaseId, this.state.currentTier);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton promoter (for use in the registry/executor)
// ---------------------------------------------------------------------------

let _globalPromoter: SurgicalTierPromoter | null = null;

/** Get or create the module-level promoter. */
export function getGlobalTierPromoter(config?: PromoterConfig): SurgicalTierPromoter {
  if (!_globalPromoter) {
    _globalPromoter = new SurgicalTierPromoter(config);
  }
  return _globalPromoter;
}

/** Replace the module-level promoter (e.g. on new goal start). */
export function setGlobalTierPromoter(promoter: SurgicalTierPromoter): void {
  _globalPromoter = promoter;
}

/** Reset the module-level promoter (for testing). */
export function resetGlobalTierPromoter(): void {
  _globalPromoter = null;
}
