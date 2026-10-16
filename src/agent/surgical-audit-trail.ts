/**
 * Surgical Audit Trail — persistent per-session log of every tool-gate verdict.
 *
 * Every call to checkSurgicalToolGate() that emits via emitAuditEvent() writes a
 * structured JSONL record to:
 *
 *   ~/.ashlrcode/surgical-audit/<session-id>.jsonl
 *
 * Records are auto-cleaned after 30 days. The audit trail powers two commands:
 *   /surgical replay [turn#]  — chronological tool decisions for a turn
 *   /surgical audit           — summary stats (tiers used, allow/block counts, reasons)
 *
 * Design goals:
 *   - Never throws. Every write failure is silently swallowed.
 *   - Session-isolated: each session gets its own JSONL file.
 *   - Append-only: records are never mutated.
 *   - Lightweight: no index, no DB — just JSONL append + sequential scan.
 */

import { join } from "path";
import { homedir } from "os";
import type { ScopeTier } from "./surgical-scope.ts";
import type { SurgicalTier } from "../tools/guards/surgical-tier-promoter.ts";
import type { SurgicalVerdict } from "../tools/guards/surgical-tool-gate.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single tool-gate decision event written to the audit log.
 */
export interface AuditEvent {
  /** ISO timestamp when the gate was evaluated. */
  timestamp: string;
  /** Monotonically-increasing turn counter (1-based). */
  turn: number;
  /** The tool name evaluated (e.g. "Bash", "Write"). */
  toolName: string;
  /**
   * Active tier at evaluation time.
   * Either a legacy ScopeTier string or a numeric SurgicalTier.
   */
  tier: ScopeTier | SurgicalTier;
  /** Gate verdict. */
  verdict: SurgicalVerdict;
  /**
   * Human-readable explanation when verdict is "block".
   * May also be present for "allow" if a noteworthy condition was flagged.
   */
  reason?: string;
  /** Suggested alternative action when verdict is "block". */
  suggestion?: string;
  /** Session ID that owns this event (matches the filename stem). */
  sessionId: string;
}

/**
 * Summary statistics produced by /surgical audit.
 */
export interface AuditStats {
  /** All distinct tiers observed in this session. */
  tiersUsed: Array<ScopeTier | SurgicalTier>;
  /** Total tools allowed across all turns. */
  toolsAllowed: number;
  /** Total tools blocked across all turns. */
  toolsBlocked: number;
  /** Per-tool allow/block counts. */
  byTool: Record<string, { allowed: number; blocked: number }>;
  /** Per-tier allow/block counts. */
  byTier: Record<string, { allowed: number; blocked: number }>;
  /** Block reason frequency map. */
  reasons: Record<string, number>;
  /** Block suggestion frequency map. */
  suggestions: Record<string, number>;
  /** Total events in the log. */
  totalEvents: number;
  /** Number of distinct turns observed. */
  totalTurns: number;
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

/** Root directory for audit logs. */
export function getAuditDir(): string {
  return join(homedir(), ".ashlrcode", "surgical-audit");
}

/** Full path to a session's audit JSONL file. */
export function getAuditFilePath(sessionId: string): string {
  return join(getAuditDir(), `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Auto-cleanup (30-day TTL)
// ---------------------------------------------------------------------------

/**
 * Remove audit JSONL files older than 30 days.
 * Runs asynchronously; errors are silently ignored.
 */
export async function pruneOldAuditFiles(maxAgeDays = 30): Promise<void> {
  try {
    const { readdir, stat, unlink } = await import("fs/promises");
    const dir = getAuditDir();
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // directory doesn't exist yet — nothing to prune
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      try {
        const s = await stat(join(dir, entry));
        if (s.mtimeMs < cutoff) {
          await unlink(join(dir, entry));
        }
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // outer guard — never throw
  }
}

// ---------------------------------------------------------------------------
// SurgicalAuditTrail
// ---------------------------------------------------------------------------

/**
 * Appends tool-gate decision events to a per-session JSONL file.
 *
 * Usage:
 *   const trail = new SurgicalAuditTrail(sessionId);
 *   await trail.emit(event);
 *
 * All I/O errors are swallowed — the audit trail must never break the main UX.
 */
export class SurgicalAuditTrail {
  private readonly filePath: string;
  private readonly sessionId: string;

  constructor(sessionId: string, filePath?: string) {
    this.sessionId = sessionId;
    this.filePath = filePath ?? getAuditFilePath(sessionId);
  }

  /**
   * Append a single audit event to the JSONL file.
   * Creates the parent directory if it does not exist.
   */
  async emit(event: AuditEvent): Promise<void> {
    try {
      const { mkdir, appendFile } = await import("fs/promises");
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify(event) + "\n";
      await appendFile(this.filePath, line, { encoding: "utf8" });
    } catch {
      // silently ignore — audit trail must never break main UX
    }
  }

  /**
   * Load all events from this session's JSONL file.
   * Returns [] if the file is missing, empty, or contains only malformed lines.
   */
  async loadAll(): Promise<AuditEvent[]> {
    try {
      const { readFile } = await import("fs/promises");
      const raw = await readFile(this.filePath, { encoding: "utf8" });
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const events: AuditEvent[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (
            parsed &&
            typeof parsed === "object" &&
            "toolName" in parsed &&
            "verdict" in parsed &&
            "sessionId" in parsed
          ) {
            events.push(parsed as AuditEvent);
          }
        } catch {
          // skip malformed lines
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  /**
   * Load events for a specific turn number.
   * Returns [] if no events exist for that turn.
   */
  async loadTurn(turn: number): Promise<AuditEvent[]> {
    const all = await this.loadAll();
    return all.filter((e) => e.turn === turn);
  }

  /**
   * Compute summary statistics across all events in this session.
   */
  async computeStats(): Promise<AuditStats> {
    const events = await this.loadAll();
    return aggregateStats(events);
  }

  /**
   * Return the session ID this trail is scoped to.
   */
  getSessionId(): string {
    return this.sessionId;
  }
}

// ---------------------------------------------------------------------------
// Stats aggregation (pure function — also used in tests)
// ---------------------------------------------------------------------------

/**
 * Aggregate a flat array of audit events into summary statistics.
 * Pure function — does not touch the filesystem.
 */
export function aggregateStats(events: AuditEvent[]): AuditStats {
  const tiersSet = new Set<ScopeTier | SurgicalTier>();
  const byTool: Record<string, { allowed: number; blocked: number }> = {};
  const byTier: Record<string, { allowed: number; blocked: number }> = {};
  const reasons: Record<string, number> = {};
  const suggestions: Record<string, number> = {};
  const turnsSet = new Set<number>();

  let toolsAllowed = 0;
  let toolsBlocked = 0;

  for (const ev of events) {
    const tierKey = String(ev.tier);
    tiersSet.add(ev.tier);
    turnsSet.add(ev.turn);

    // byTool
    if (!byTool[ev.toolName]) byTool[ev.toolName] = { allowed: 0, blocked: 0 };
    // byTier
    if (!byTier[tierKey]) byTier[tierKey] = { allowed: 0, blocked: 0 };

    if (ev.verdict === "allow") {
      toolsAllowed++;
      byTool[ev.toolName].allowed++;
      byTier[tierKey].allowed++;
    } else {
      toolsBlocked++;
      byTool[ev.toolName].blocked++;
      byTier[tierKey].blocked++;
      if (ev.reason) {
        reasons[ev.reason] = (reasons[ev.reason] ?? 0) + 1;
      }
      if (ev.suggestion) {
        suggestions[ev.suggestion] = (suggestions[ev.suggestion] ?? 0) + 1;
      }
    }
  }

  return {
    tiersUsed: Array.from(tiersSet),
    toolsAllowed,
    toolsBlocked,
    byTool,
    byTier,
    reasons,
    suggestions,
    totalEvents: events.length,
    totalTurns: turnsSet.size,
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton (keyed by session ID)
// ---------------------------------------------------------------------------

const _trails = new Map<string, SurgicalAuditTrail>();

/**
 * Get (or lazily create) a SurgicalAuditTrail for the given session ID.
 */
export function getAuditTrail(sessionId: string): SurgicalAuditTrail {
  let trail = _trails.get(sessionId);
  if (!trail) {
    trail = new SurgicalAuditTrail(sessionId);
    _trails.set(sessionId, trail);
  }
  return trail;
}

// ---------------------------------------------------------------------------
// Formatting helpers for /surgical replay and /surgical audit
// ---------------------------------------------------------------------------

/**
 * Format a list of AuditEvents (for one turn) into a human-readable string
 * suitable for /surgical replay output.
 */
export function formatReplay(events: AuditEvent[], turn: number): string {
  if (events.length === 0) {
    return `\n  No tool-gate events recorded for turn ${turn}.\n`;
  }

  const lines: string[] = [
    "",
    `  ── Surgical Replay — Turn ${turn} (${events.length} decision${events.length === 1 ? "" : "s"}) ──`,
  ];

  for (const ev of events) {
    const time = ev.timestamp.slice(11, 19); // HH:MM:SS
    const tierLabel = String(ev.tier);
    const verdict = ev.verdict === "allow" ? "ALLOW" : "BLOCK";
    const verdictStr = ev.verdict === "allow" ? `  ${verdict}` : `  ${verdict}`;
    lines.push(`    ${time}  ${ev.toolName.padEnd(14)} tier:${tierLabel.padEnd(8)} ${verdictStr}`);
    if (ev.reason) {
      // Trim the [surgical-tool-gate] prefix for cleaner display
      const trimmed = ev.reason.replace(/^\[surgical-tool-gate\]\s*/, "");
      lines.push(`             reason: ${trimmed}`);
    }
    if (ev.suggestion) {
      lines.push(`             suggestion: ${ev.suggestion}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format AuditStats into a human-readable summary string for /surgical audit.
 */
export function formatAuditSummary(stats: AuditStats): string {
  if (stats.totalEvents === 0) {
    return [
      "",
      "  ── Surgical Audit Summary ──────────────────────────────",
      "  No audit events recorded yet.",
      "  Events are captured automatically when surgical mode is active.",
      "",
    ].join("\n");
  }

  const tierLabels = stats.tiersUsed.map(String).join(", ") || "none";
  const blockRate =
    stats.totalEvents > 0
      ? Math.round((stats.toolsBlocked / stats.totalEvents) * 100)
      : 0;

  const lines: string[] = [
    "",
    "  ── Surgical Audit Summary ──────────────────────────────",
    `  Total events:    ${stats.totalEvents}`,
    `  Turns covered:   ${stats.totalTurns}`,
    `  Tiers used:      ${tierLabels}`,
    `  Tools allowed:   ${stats.toolsAllowed}`,
    `  Tools blocked:   ${stats.toolsBlocked}  (${blockRate}% of decisions)`,
    "",
    "  By tool:",
  ];

  for (const [tool, counts] of Object.entries(stats.byTool).sort((a, b) => {
    // Sort by total calls descending
    return (b[1].allowed + b[1].blocked) - (a[1].allowed + a[1].blocked);
  })) {
    const total = counts.allowed + counts.blocked;
    const blockPct = total > 0 ? Math.round((counts.blocked / total) * 100) : 0;
    lines.push(
      `    ${tool.padEnd(16)} allow:${String(counts.allowed).padStart(4)}  block:${String(counts.blocked).padStart(4)}  (${blockPct}% blocked)`,
    );
  }

  if (Object.keys(stats.byTier).length > 0) {
    lines.push("", "  By tier:");
    for (const [tier, counts] of Object.entries(stats.byTier)) {
      const total = counts.allowed + counts.blocked;
      lines.push(
        `    ${tier.padEnd(10)} allow:${String(counts.allowed).padStart(4)}  block:${String(counts.blocked).padStart(4)}  of ${total}`,
      );
    }
  }

  if (Object.keys(stats.reasons).length > 0) {
    lines.push("", "  Block reasons (top 5):");
    const sorted = Object.entries(stats.reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [reason, count] of sorted) {
      const trimmed = reason.replace(/^\[surgical-tool-gate\]\s*/, "").slice(0, 70);
      lines.push(`    ×${count}  ${trimmed}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
