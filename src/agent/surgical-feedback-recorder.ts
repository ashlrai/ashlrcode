/**
 * Surgical Feedback Recorder — closed-loop outcome tracking for surgical-mode
 * tier proposals.
 *
 * Records (goal, proposedTier, actualTier, filesTouched, duration, testsPassed)
 * to ~/.ashlrcode/surgical-feedback.jsonl on run completion.
 *
 * This complements the lightweight ProposalFeedback already written by
 * surgical-proposer.ts (which tracks user tier overrides). SurgicalRunRecord
 * captures the full run outcome — actual scope used vs. proposed, files touched,
 * duration, and test results — enabling the ProposalRetrainer to measure whether
 * the *chosen* tier was objectively correct, not just accepted by the user.
 *
 * Feature-gated by FEATURE_SURGICAL_RETRAINING (AC_FEATURE_SURGICAL_RETRAINING=true).
 */

import { join } from "path";
import { homedir } from "os";
import type { ScopeTier } from "./surgical-scope.ts";
import type { SurgicalTier } from "../tools/guards/surgical-tier-promoter.ts";

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Full run-outcome record written on surgical run completion.
 *
 * Captures everything needed to evaluate whether the proposed tier was correct:
 *   - What the system proposed vs. what tier was actually executed
 *   - How many files were touched (vs. budget)
 *   - How long the run took
 *   - Whether tests passed (null = no test suite run)
 */
export interface SurgicalRunRecord {
  /** ISO timestamp of run completion. */
  timestamp: string;
  /** The user's stated goal. */
  goal: string;
  /** The tier the system proposed (from surgical-proposer). */
  proposedTier: ScopeTier;
  /** The tier the user actually ran with. */
  actualTier: ScopeTier;
  /** Numeric value of the proposed tier (1=narrow, 2–3=medium, 4=wide). */
  proposedNumericTier: SurgicalTier;
  /** Numeric value of the actual tier. */
  actualNumericTier: SurgicalTier;
  /** Number of files touched during the run. */
  filesTouched: number;
  /** File budget allowed by the actual tier. */
  fileBudget: number;
  /** Run duration in milliseconds. */
  durationMs: number;
  /** Whether tests passed after the run (null = not run). */
  testsPassed: boolean | null;
  /** Whether the run stayed within the file budget. */
  withinBudget: boolean;
  /**
   * Outcome classification:
   *   "correct"    — proposed tier matched actual tier
   *   "under"      — system proposed too narrow; user needed wider
   *   "over"       — system proposed too wide; user ran narrower
   *   "accepted"   — proposed == actual (user accepted the proposal)
   */
  outcome: "correct" | "under" | "over" | "accepted";
  /** Confidence the proposer had at proposal time. */
  proposalConfidence: number;
}

/**
 * Input to SurgicalFeedbackRecorder.record().
 * All fields except testsPassed are required.
 */
export interface RunCompletionEvent {
  goal: string;
  proposedTier: ScopeTier;
  actualTier: ScopeTier;
  proposedNumericTier: SurgicalTier;
  actualNumericTier: SurgicalTier;
  filesTouched: number;
  fileBudget: number;
  startedAt: number; // Date.now() at run start
  testsPassed?: boolean | null;
  proposalConfidence: number;
}

// ── File path ──────────────────────────────────────────────────────────────────

/** Path to the run-record JSONL file. */
export function getRunRecordFilePath(): string {
  return join(homedir(), ".ashlrcode", "surgical-feedback.jsonl");
}

// ── Outcome classifier ────────────────────────────────────────────────────────

/**
 * Classify the run outcome by comparing proposed vs actual tier.
 *
 * Tier ordering: narrow(1) < medium(3) < wide(4)
 * "correct" / "accepted" both mean the proposal was accurate.
 */
function classifyOutcome(
  proposed: ScopeTier,
  actual: ScopeTier,
): SurgicalRunRecord["outcome"] {
  if (proposed === actual) return "accepted";

  const order: Record<ScopeTier, number> = { narrow: 1, medium: 2, wide: 3 };
  const pRank = order[proposed];
  const aRank = order[actual];

  if (aRank > pRank) return "under"; // proposed too narrow, needed wider
  return "over"; // proposed too wide, ran narrower
}

// ── SurgicalFeedbackRecorder ──────────────────────────────────────────────────

/**
 * Records surgical run outcomes to the feedback JSONL file.
 *
 * Usage:
 *   const recorder = new SurgicalFeedbackRecorder();
 *   await recorder.record(event);
 *
 * Errors are silently swallowed — recording must never break the main UX.
 */
export class SurgicalFeedbackRecorder {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getRunRecordFilePath();
  }

  /**
   * Build a SurgicalRunRecord from a run-completion event and append it to
   * the JSONL file. Creates the parent directory if needed.
   *
   * @param event  Run completion data gathered at the end of a surgical run.
   */
  async record(event: RunCompletionEvent): Promise<void> {
    const record: SurgicalRunRecord = {
      timestamp: new Date().toISOString(),
      goal: event.goal,
      proposedTier: event.proposedTier,
      actualTier: event.actualTier,
      proposedNumericTier: event.proposedNumericTier,
      actualNumericTier: event.actualNumericTier,
      filesTouched: event.filesTouched,
      fileBudget: event.fileBudget,
      durationMs: Date.now() - event.startedAt,
      testsPassed: event.testsPassed ?? null,
      withinBudget: event.filesTouched <= event.fileBudget,
      outcome: classifyOutcome(event.proposedTier, event.actualTier),
      proposalConfidence: event.proposalConfidence,
    };

    await this._append(record);
  }

  /** Load all run records from the JSONL file. Returns [] on missing/empty file. */
  async loadAll(): Promise<SurgicalRunRecord[]> {
    try {
      const { readFile } = await import("fs/promises");
      const raw = await readFile(this.filePath, { encoding: "utf8" });
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const records: SurgicalRunRecord[] = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          // Only include full run records (they have filesTouched field)
          if (parsed && typeof parsed === "object" && "filesTouched" in parsed && parsed.goal) {
            records.push(parsed as SurgicalRunRecord);
          }
        } catch {
          // Skip malformed lines
        }
      }

      return records;
    } catch {
      return [];
    }
  }

  /**
   * Load the most recent N run records.
   * @param n  Window size (default: 50, matching the retrainer's rolling window).
   */
  async loadRecent(n = 50): Promise<SurgicalRunRecord[]> {
    const all = await this.loadAll();
    return all.slice(-n);
  }

  /**
   * Format recent records as a human-readable feedback report.
   * Used by `/surgical feedback`.
   */
  formatReport(records: SurgicalRunRecord[]): string {
    if (records.length === 0) {
      return [
        "",
        "  ── Surgical Feedback Report ─────────────────────────────",
        "  No run records yet.",
        "  Records are saved automatically when surgical runs complete.",
        "  Enable with: AC_FEATURE_SURGICAL_RETRAINING=true",
        "",
      ].join("\n");
    }

    const correct = records.filter((r) => r.outcome === "accepted" || r.outcome === "correct").length;
    const under = records.filter((r) => r.outcome === "under").length;
    const over = records.filter((r) => r.outcome === "over").length;
    const accuracy = Math.round((correct / records.length) * 100);
    const avgConfidence = Math.round(
      (records.reduce((s, r) => s + r.proposalConfidence, 0) / records.length) * 100,
    );
    const avgFiles = (records.reduce((s, r) => s + r.filesTouched, 0) / records.length).toFixed(1);
    const withinBudget = records.filter((r) => r.withinBudget).length;
    const withTests = records.filter((r) => r.testsPassed !== null);
    const testPassRate =
      withTests.length > 0
        ? Math.round((withTests.filter((r) => r.testsPassed).length / withTests.length) * 100)
        : null;

    const lines = [
      "",
      "  ── Surgical Feedback Report ─────────────────────────────",
      `  Records (window):   ${records.length}`,
      `  Proposal accuracy:  ${accuracy}% (${correct}/${records.length} matched)`,
      `  Avg confidence:     ${avgConfidence}%`,
      `  Under-proposed:     ${under} (system too narrow, user widened)`,
      `  Over-proposed:      ${over} (system too wide, user narrowed)`,
      `  Avg files touched:  ${avgFiles}`,
      `  Within budget:      ${withinBudget}/${records.length}`,
      testPassRate !== null ? `  Test pass rate:     ${testPassRate}%` : "",
      "",
      "  Recent runs (newest first):",
    ].filter(Boolean);

    const recent = [...records].reverse().slice(0, 10);
    for (const r of recent) {
      const date = r.timestamp.slice(0, 16).replace("T", " ");
      const icon = r.outcome === "accepted" || r.outcome === "correct" ? "✓" : r.outcome === "under" ? "↑" : "↓";
      const conf = Math.round(r.proposalConfidence * 100);
      const tests = r.testsPassed === null ? "" : r.testsPassed ? " tests:pass" : " tests:fail";
      lines.push(
        `    ${icon} ${date}  ${r.proposedTier}→${r.actualTier}  conf:${conf}%  files:${r.filesTouched}/${r.fileBudget}${tests}`,
      );
      lines.push(`      goal: ${r.goal.slice(0, 70)}`);
    }

    lines.push("");
    return lines.join("\n");
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _append(record: SurgicalRunRecord): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    try {
      const { mkdir, appendFile } = await import("fs/promises");
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify(record) + "\n";
      await appendFile(this.filePath, line, { encoding: "utf8" });
    } catch {
      // Silently ignore — feedback recording must never break the main UX
    }
  }
}

/** Module-level singleton recorder. */
let _globalRecorder: SurgicalFeedbackRecorder | null = null;

/** Get (or lazily create) the global SurgicalFeedbackRecorder. */
export function getGlobalFeedbackRecorder(): SurgicalFeedbackRecorder {
  if (!_globalRecorder) {
    _globalRecorder = new SurgicalFeedbackRecorder();
  }
  return _globalRecorder;
}
