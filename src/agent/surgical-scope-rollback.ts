/**
 * SurgicalScopeRollbackManager — auto-rollback when narrow/medium scope hits dead-ends.
 *
 * Problem: When a surgical session starts at Tier 1 (micro) or Tier 2 (fine),
 * tool calls that need wider capabilities are blocked. If ≥2 distinct tools are
 * blocked in the same turn, the agent is stuck — it cannot make progress without
 * widening scope. This module detects that condition, proposes a widening, and
 * logs the rollback reason to ~/.ashlrcode/surgical-rollbacks.jsonl.
 *
 * Key behaviors:
 *   - trackBlockedTool() records each blocked-tool event during a turn
 *   - shouldProposewiden() returns true when ≥2 distinct tools blocked this turn
 *   - proposeWiden() picks the minimum sufficient tier and emits a proposal
 *   - acceptWiden() / rejectWiden() resolve the pending proposal
 *   - capabilityAnalysis() maps a goal string → required tools + recommended tier
 *   - costDeltaForWiden() integrates with cost-estimator to show cost impact
 *   - All rollback events are appended to ~/.ashlrcode/surgical-rollbacks.jsonl
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { SurgicalTier } from "../tools/guards/surgical-tier-promoter.ts";
import { TIER_DESCRIPTORS } from "../tools/guards/surgical-tier-promoter.ts";
import type { CostEstimate } from "./cost-estimator.ts";
import { estimateGoalCost } from "./cost-estimator.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlockedToolEvent {
  /** Tool that was blocked (e.g. "Bash", "LSP") */
  toolName: string;
  /** Reason from the gate result */
  reason: string;
  /** Active tier at time of block */
  tier: SurgicalTier;
  /** Turn number (1-based) */
  turn: number;
  /** ISO timestamp */
  timestamp: string;
}

export interface RollbackProposal {
  /** Session/goal this proposal applies to */
  sessionId: string;
  /** Turn on which the proposal was generated */
  turn: number;
  /** Tier that triggered the rollback */
  fromTier: SurgicalTier;
  /** Recommended wider tier */
  toTier: SurgicalTier;
  /** Human-readable explanation */
  reason: string;
  /** Tools that were blocked, triggering the proposal */
  blockedTools: string[];
  /** ISO timestamp */
  timestamp: string;
  /** Whether the user has accepted/rejected/pending */
  status: "pending" | "accepted" | "rejected";
}

export interface RollbackLogEntry extends RollbackProposal {
  /** Final disposition timestamp */
  resolvedAt?: string;
}

export interface CapabilityAnalysisResult {
  /** The goal that was analyzed */
  goal: string;
  /** Tools expected to be needed */
  requiredTools: string[];
  /** Minimum tier to serve all required tools */
  recommendedTier: SurgicalTier;
  /** Reasoning for recommendation */
  reasoning: string[];
  /** Cost estimate at recommended tier */
  costAtRecommendedTier: CostEstimate;
  /** Cost estimate at Tier 4 (broad) for comparison */
  costAtBroadTier: CostEstimate;
}

export interface WidenCostDelta {
  fromTier: SurgicalTier;
  toTier: SurgicalTier;
  costAtCurrentTier: CostEstimate;
  costAtWidenedTier: CostEstimate;
  /** Absolute USD delta (positive = more expensive) */
  deltaUSD: number;
  /** Formatted string for display */
  formatted: string;
}

// ---------------------------------------------------------------------------
// Tool-capability mapping
// ---------------------------------------------------------------------------

/**
 * For each SurgicalTier, which tools are available?
 * Used by capabilityAnalysis to reason about minimum tier requirements.
 */
const TOOLS_AVAILABLE_BY_TIER: Record<SurgicalTier, ReadonlySet<string>> = {
  1: new Set(["Read", "Grep", "Glob", "LS", "Ls", "Diff"]),
  2: new Set(["Read", "Grep", "Glob", "LS", "Ls", "Diff", "Edit"]),
  3: new Set(["Read", "Grep", "Glob", "LS", "Ls", "Diff", "Edit", "Write", "Test", "Bash"]),
  4: new Set([
    "Read", "Grep", "Glob", "LS", "Ls", "Diff", "Edit", "Write", "Test",
    "Bash", "Agent", "Coordinate", "LSP", "WebFetch", "WebSearch",
  ]),
};

/**
 * Goal keyword → set of tools that goal type typically requires.
 * Used by capabilityAnalysis() to map a goal to expected tool needs.
 */
const GOAL_TO_TOOLS: Array<{ patterns: string[]; tools: string[] }> = [
  // Pure read / exploration
  { patterns: ["show", "read", "list", "grep", "search", "find", "what", "check"], tools: ["Read", "Grep", "Glob", "LS"] },
  // Single-file edits
  { patterns: ["fix typo", "fix comment", "rename variable", "rename parameter", "one-line", "single line"], tools: ["Read", "Edit"] },
  // Bug fixes needing bash
  { patterns: ["fix bug", "fix crash", "fix test", "run test", "test"], tools: ["Read", "Edit", "Bash", "Test"] },
  // Analysis requiring bash
  { patterns: ["analyze", "profile", "benchmark", "measure", "lint"], tools: ["Read", "Bash"] },
  // Multi-file changes
  { patterns: ["refactor", "rename module", "extract", "migrate"], tools: ["Read", "Edit", "Write", "Bash"] },
  // New feature / implement
  { patterns: ["add feature", "implement", "new feature", "write"], tools: ["Read", "Edit", "Write", "Bash"] },
  // Language-server features
  { patterns: ["types", "type check", "lsp", "go to definition", "hover"], tools: ["Read", "LSP"] },
  // Web / network tasks
  { patterns: ["fetch", "api", "http", "url", "web"], tools: ["Read", "WebFetch"] },
  // Wide-open
  { patterns: ["everything", "all files", "entire", "rewrite", "restructure"], tools: ["Read", "Edit", "Write", "Bash", "Agent"] },
];

/**
 * Given a set of required tools, return the minimum SurgicalTier that provides
 * all of them. Returns 4 if no lower tier suffices.
 */
function minimumTierForTools(tools: string[]): SurgicalTier {
  for (const tier of [1, 2, 3, 4] as SurgicalTier[]) {
    const available = TOOLS_AVAILABLE_BY_TIER[tier];
    if (tools.every((t) => available.has(t))) return tier;
  }
  return 4;
}

// ---------------------------------------------------------------------------
// Rollback log path
// ---------------------------------------------------------------------------

function rollbackLogPath(): string {
  return join(homedir(), ".ashlrcode", "surgical-rollbacks.jsonl");
}

/**
 * Append a rollback log entry to the JSONL file.
 * Fire-and-forget — never throws to the caller.
 */
async function appendRollbackLog(entry: RollbackLogEntry): Promise<void> {
  try {
    const dir = join(homedir(), ".ashlrcode");
    const path = rollbackLogPath();
    // Ensure directory exists
    await Bun.write(dir + "/.keep", ""); // creates dir if needed
    const line = JSON.stringify(entry) + "\n";
    const file = Bun.file(path);
    let existing = "";
    try {
      existing = await file.text();
    } catch {
      // file doesn't exist yet
    }
    await Bun.write(path, existing + line);
  } catch {
    // silently ignore — rollback logging must never break the main UX
  }
}

/**
 * Read all rollback log entries from JSONL.
 * Returns empty array on any error.
 */
export async function readRollbackLog(): Promise<RollbackLogEntry[]> {
  try {
    const file = Bun.file(rollbackLogPath());
    const text = await file.text();
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RollbackLogEntry);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// SurgicalScopeRollbackManager
// ---------------------------------------------------------------------------

export class SurgicalScopeRollbackManager {
  private sessionId: string;
  /** Blocked events accumulated during the current turn */
  private currentTurnBlocks: BlockedToolEvent[] = [];
  /** Current turn number */
  private currentTurn = 1;
  /** Active pending proposal (if any) */
  private pendingProposal: RollbackProposal | null = null;
  /** History of all proposals across turns */
  private proposalHistory: RollbackProposal[] = [];
  /** Minimum distinct tools blocked in a turn to trigger proposal */
  private readonly blockThreshold: number;
  /** Whether rollback logging to disk is enabled */
  private readonly logToDisk: boolean;

  constructor(
    sessionId: string,
    options: {
      /** How many distinct tools need to be blocked before proposing widen. Default: 2 */
      blockThreshold?: number;
      /** Whether to write rollback events to disk. Default: true */
      logToDisk?: boolean;
    } = {},
  ) {
    this.sessionId = sessionId;
    this.blockThreshold = options.blockThreshold ?? 2;
    this.logToDisk = options.logToDisk ?? true;
  }

  // ── Turn lifecycle ──────────────────────────────────────────────────────

  /** Call at the start of each new turn to reset the per-turn block tracker. */
  beginTurn(turn: number): void {
    this.currentTurn = turn;
    this.currentTurnBlocks = [];
  }

  /** Current turn number. */
  turn(): number {
    return this.currentTurn;
  }

  // ── Block tracking ──────────────────────────────────────────────────────

  /**
   * Record a blocked-tool event.
   * Call this from the gate's block path so the manager accumulates events.
   *
   * Returns true if this event pushed the distinct-tool count over the threshold
   * (i.e. a proposal should now be generated via proposeWiden()).
   */
  trackBlockedTool(toolName: string, reason: string, tier: SurgicalTier): boolean {
    const event: BlockedToolEvent = {
      toolName,
      reason,
      tier,
      turn: this.currentTurn,
      timestamp: new Date().toISOString(),
    };
    this.currentTurnBlocks.push(event);
    return this.shouldProposeWiden();
  }

  /**
   * True when ≥ blockThreshold distinct tools have been blocked this turn.
   */
  shouldProposeWiden(): boolean {
    const distinctTools = new Set(this.currentTurnBlocks.map((e) => e.toolName));
    return distinctTools.size >= this.blockThreshold;
  }

  /**
   * Return the set of distinct tool names blocked in the current turn.
   */
  blockedToolsThisTurn(): Set<string> {
    return new Set(this.currentTurnBlocks.map((e) => e.toolName));
  }

  /** All block events for the current turn. */
  currentTurnBlockEvents(): BlockedToolEvent[] {
    return [...this.currentTurnBlocks];
  }

  // ── Proposal generation ─────────────────────────────────────────────────

  /**
   * Generate a widen proposal for the current turn.
   *
   * Picks the minimum tier that would have allowed all blocked tools.
   * The proposal is stored as pending and optionally written to disk.
   *
   * @returns The generated RollbackProposal.
   */
  async proposeWiden(currentTier: SurgicalTier): Promise<RollbackProposal> {
    const blocked = Array.from(this.blockedToolsThisTurn());

    // Find minimum tier that provides all blocked tools
    let toTier: SurgicalTier = currentTier;
    for (const tier of [1, 2, 3, 4] as SurgicalTier[]) {
      if (tier <= currentTier) continue;
      const available = TOOLS_AVAILABLE_BY_TIER[tier];
      if (blocked.every((t) => available.has(t))) {
        toTier = tier;
        break;
      }
    }
    // If blocked tools include something only available at Tier 4, default to 4
    if (toTier === currentTier) toTier = 4;

    const fromDesc = TIER_DESCRIPTORS[currentTier];
    const toDesc = TIER_DESCRIPTORS[toTier];

    const proposal: RollbackProposal = {
      sessionId: this.sessionId,
      turn: this.currentTurn,
      fromTier: currentTier,
      toTier,
      reason:
        `${blocked.length} tool(s) blocked at ${fromDesc.label}: ${blocked.join(", ")}. ` +
        `Widening to ${toDesc.label} would unblock all of them.`,
      blockedTools: blocked,
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    this.pendingProposal = proposal;
    this.proposalHistory.push(proposal);

    if (this.logToDisk) {
      await appendRollbackLog({ ...proposal });
    }

    return proposal;
  }

  // ── Proposal resolution ─────────────────────────────────────────────────

  /** The currently pending proposal, or null if none. */
  getPendingProposal(): RollbackProposal | null {
    return this.pendingProposal;
  }

  /**
   * Accept the pending widen proposal (user ran /surgical widen).
   * Returns the accepted tier, or null if no proposal was pending.
   */
  async acceptWiden(): Promise<SurgicalTier | null> {
    if (!this.pendingProposal) return null;
    this.pendingProposal.status = "accepted";
    const toTier = this.pendingProposal.toTier;

    if (this.logToDisk) {
      await appendRollbackLog({
        ...this.pendingProposal,
        resolvedAt: new Date().toISOString(),
      });
    }

    this.pendingProposal = null;
    return toTier;
  }

  /**
   * Reject the pending widen proposal (user chose to stay constrained).
   * Returns false when no proposal was pending.
   */
  async rejectWiden(): Promise<boolean> {
    if (!this.pendingProposal) return false;
    this.pendingProposal.status = "rejected";

    if (this.logToDisk) {
      await appendRollbackLog({
        ...this.pendingProposal,
        resolvedAt: new Date().toISOString(),
      });
    }

    this.pendingProposal = null;
    return true;
  }

  /** Full proposal history (all turns). */
  getProposalHistory(): RollbackProposal[] {
    return [...this.proposalHistory];
  }

  // ── Capability analysis ─────────────────────────────────────────────────

  /**
   * Analyze a goal string and return a CapabilityAnalysisResult:
   *   - Which tools are likely needed
   *   - Minimum tier that covers all those tools
   *   - Cost estimates at recommended tier vs. Tier 4
   *
   * This backs the `/surgical capability-analysis <goal>` command.
   */
  capabilityAnalysis(goal: string): CapabilityAnalysisResult {
    const lower = goal.toLowerCase();
    const toolSet = new Set<string>();
    const reasoning: string[] = [];

    // Match goal patterns to required tools
    for (const { patterns, tools } of GOAL_TO_TOOLS) {
      for (const pattern of patterns) {
        if (lower.includes(pattern)) {
          tools.forEach((t) => toolSet.add(t));
          reasoning.push(`"${pattern}" → needs ${tools.join(", ")}`);
          break; // one match per pattern group is sufficient
        }
      }
    }

    // Default: if no patterns matched, assume basic read + edit
    if (toolSet.size === 0) {
      toolSet.add("Read");
      toolSet.add("Edit");
      reasoning.push("(no strong signals — assuming Read + Edit)");
    }

    const requiredTools = Array.from(toolSet);
    const recommendedTier = minimumTierForTools(requiredTools);

    const costAtRecommendedTier = estimateGoalCost(goal);
    const costAtBroadTier = estimateGoalCost(goal);

    // Cost delta: narrower tier = fewer turns (heuristic: each tier step saves ~15%)
    // We apply a simple multiplier based on tier distance to provide a plausible delta.
    const tierDelta = 4 - recommendedTier;
    const adjustedCostUSD = costAtBroadTier.costUSD * Math.pow(0.85, tierDelta);
    const recommendedCost: CostEstimate = {
      ...costAtRecommendedTier,
      costUSD: adjustedCostUSD,
    };

    return {
      goal,
      requiredTools,
      recommendedTier,
      reasoning,
      costAtRecommendedTier: recommendedCost,
      costAtBroadTier,
    };
  }

  // ── Cost delta for widen ────────────────────────────────────────────────

  /**
   * Calculate the cost impact of widening from currentTier to toTier for a given goal.
   * Integrates with cost-estimator to show a dollar delta before the user accepts.
   */
  costDeltaForWiden(goal: string, fromTier: SurgicalTier, toTier: SurgicalTier): WidenCostDelta {
    const baseCost = estimateGoalCost(goal);

    // Narrow tiers are cheaper because fewer tools = fewer turns heuristically.
    // Model: each tier step up from tier 1 adds ~15% to cost (compound).
    function tierCostMultiplier(tier: SurgicalTier): number {
      return Math.pow(1.15, tier - 1);
    }

    const fromMultiplier = tierCostMultiplier(fromTier);
    const toMultiplier = tierCostMultiplier(toTier);

    const costAtFromTier: CostEstimate = {
      ...baseCost,
      costUSD: baseCost.costUSD * fromMultiplier,
    };
    const costAtToTier: CostEstimate = {
      ...baseCost,
      costUSD: baseCost.costUSD * toMultiplier,
    };

    const deltaUSD = costAtToTier.costUSD - costAtFromTier.costUSD;

    function fmtCost(usd: number): string {
      if (usd < 0.001) return "<$0.001";
      if (usd < 1) return `$${usd.toFixed(3)}`;
      return `$${usd.toFixed(2)}`;
    }

    const fromDesc = TIER_DESCRIPTORS[fromTier];
    const toDesc = TIER_DESCRIPTORS[toTier];
    const deltaSign = deltaUSD >= 0 ? "+" : "";
    const formatted =
      `Widening from ${fromDesc.label} → ${toDesc.label}: ` +
      `${fmtCost(costAtFromTier.costUSD)} → ${fmtCost(costAtToTier.costUSD)} ` +
      `(${deltaSign}${fmtCost(Math.abs(deltaUSD))})`;

    return {
      fromTier,
      toTier,
      costAtCurrentTier: costAtFromTier,
      costAtWidenedTier: costAtToTier,
      deltaUSD,
      formatted,
    };
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  /**
   * Format a RollbackProposal as a human-readable prompt for the user.
   * Includes the reason, proposed widen tier, and /surgical widen shortcut.
   */
  formatProposal(proposal: RollbackProposal, goal?: string): string {
    const fromDesc = TIER_DESCRIPTORS[proposal.fromTier];
    const toDesc = TIER_DESCRIPTORS[proposal.toTier];
    const lines: string[] = [
      "",
      "  [Surgical Rollback Proposal]",
      `  ${proposal.reason}`,
      "",
      `  From: ${fromDesc.label} — ${fromDesc.description}`,
      `  To:   ${toDesc.label} — ${toDesc.description}`,
    ];

    if (goal) {
      const delta = this.costDeltaForWiden(goal, proposal.fromTier, proposal.toTier);
      lines.push(`  Cost: ${delta.formatted}`);
    }

    lines.push(
      "",
      "  Accept: /surgical widen    Reject: /surgical stay",
      "",
    );

    return lines.join("\n");
  }

  /**
   * Format capability analysis as a human-readable report.
   */
  formatCapabilityAnalysis(result: CapabilityAnalysisResult): string {
    const tierDesc = TIER_DESCRIPTORS[result.recommendedTier];
    const lines: string[] = [
      "",
      `  Capability Analysis: "${result.goal.slice(0, 70)}${result.goal.length > 70 ? "..." : ""}"`,
      "",
      "  Required tools:",
    ];

    for (const tool of result.requiredTools) {
      lines.push(`    · ${tool}`);
    }

    lines.push("", "  Reasoning:");
    for (const r of result.reasoning) {
      lines.push(`    · ${r}`);
    }

    function fmtCost(usd: number): string {
      if (usd < 0.001) return "<$0.001";
      if (usd < 1) return `$${usd.toFixed(3)}`;
      return `$${usd.toFixed(2)}`;
    }

    lines.push(
      "",
      `  Recommended minimum tier: ${tierDesc.label}`,
      `  Description: ${tierDesc.description}`,
      `  Estimated cost at ${tierDesc.name}: ${fmtCost(result.costAtRecommendedTier.costUSD)}`,
      `  Estimated cost at broad (Tier 4): ${fmtCost(result.costAtBroadTier.costUSD)}`,
      "",
    );

    return lines.join("\n");
  }

  // ── State reset ─────────────────────────────────────────────────────────

  /** Reset all per-session state (for testing or new goal start). */
  reset(): void {
    this.currentTurnBlocks = [];
    this.currentTurn = 1;
    this.pendingProposal = null;
    this.proposalHistory = [];
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _globalRollbackManager: SurgicalScopeRollbackManager | null = null;

export function getGlobalRollbackManager(
  sessionId = "default",
  options?: ConstructorParameters<typeof SurgicalScopeRollbackManager>[1],
): SurgicalScopeRollbackManager {
  if (!_globalRollbackManager) {
    _globalRollbackManager = new SurgicalScopeRollbackManager(sessionId, options);
  }
  return _globalRollbackManager;
}

export function setGlobalRollbackManager(manager: SurgicalScopeRollbackManager): void {
  _globalRollbackManager = manager;
}

export function resetGlobalRollbackManager(): void {
  _globalRollbackManager = null;
}
