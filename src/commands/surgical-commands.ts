/**
 * Surgical Audit Commands — /surgical replay [turn] and /surgical audit
 *
 * Provide full visibility into why tools were allowed or blocked during
 * surgical mode, closing the explainability gap.
 *
 * Commands:
 *   /surgical replay [turn#]  — show chronological tool decisions for a turn
 *                               (defaults to the most-recent turn when omitted)
 *   /surgical audit           — summary stats: tiers used, allowed/blocked
 *                               counts, reason/suggestion frequency
 */

import { theme } from "../ui/theme.ts";
import type { Command, CommandContext } from "./types.ts";
import {
  warmupTierScoreCache,
  getTierEvalPerfStats,
  resetTierEvalPerfStats,
} from "../agent/surgical-proposer.ts";
import { getPromotionScoreCache } from "../agent/promotion-score-cache.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the session ID from the command context.
 * Falls back to a predictable default so commands work even when no explicit
 * session is tracked.
 */
function resolveSessionId(ctx: CommandContext): string {
  const s = ctx.state.session as { id?: string } | undefined;
  return s?.id ?? "default";
}

// ── Command: /surgical replay [turn#] ─────────────────────────────────────

/**
 * Handle /surgical replay [turn#].
 *
 * Shows every tool-gate decision recorded for the requested turn.
 * When no turn number is supplied, uses the highest turn seen in the log
 * (i.e. the most recent turn that had tool calls).
 */
export async function handleSurgicalReplay(
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const { SurgicalAuditTrail, formatReplay } = await import("../agent/surgical-audit-trail.ts");

  const sessionId = resolveSessionId(ctx);
  const trail = new SurgicalAuditTrail(sessionId);
  const all = await trail.loadAll();

  if (all.length === 0) {
    ctx.addOutput(
      "\n" +
      theme.warning("  No surgical audit events recorded yet.\n") +
      theme.muted(
        "  Events are captured automatically when surgical mode is active and\n" +
        "  the gate's `audit` context is wired in. Run /surgical narrow (or similar)\n" +
        "  then make tool calls to start populating the log.\n",
      ),
    );
    return true;
  }

  // Determine the turn to display
  const maxTurn = Math.max(...all.map((e) => e.turn));
  let turn = maxTurn;

  const trimmed = args.trim();
  if (trimmed !== "") {
    const parsed = parseInt(trimmed, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      ctx.addOutput(
        theme.warning(`\n  Invalid turn number: "${trimmed}". Usage: /surgical replay [turn#]\n`),
      );
      return true;
    }
    turn = parsed;
  }

  const events = all.filter((e) => e.turn === turn);
  ctx.addOutput(formatReplay(events, turn));

  if (trimmed === "") {
    // Hint about other turns
    const turns = [...new Set(all.map((e) => e.turn))].sort((a, b) => a - b);
    if (turns.length > 1) {
      ctx.addOutput(
        theme.muted(
          `  (Showing latest turn ${turn}. ` +
          `All turns: ${turns.join(", ")} — pass a turn# to /surgical replay)\n`,
        ),
      );
    }
  }

  return true;
}

// ── Command: /surgical audit ──────────────────────────────────────────────

/**
 * Handle /surgical audit.
 *
 * Displays aggregate statistics across all tool-gate decisions for the
 * current session: tiers used, allowed/blocked counts, per-tool breakdown,
 * and reason/suggestion frequency.
 */
export async function handleSurgicalAudit(
  _args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const { SurgicalAuditTrail, formatAuditSummary } = await import("../agent/surgical-audit-trail.ts");

  const sessionId = resolveSessionId(ctx);
  const trail = new SurgicalAuditTrail(sessionId);
  const stats = await trail.computeStats();

  ctx.addOutput(
    theme.accentBold("\n  Surgical Audit Trail") + formatAuditSummary(stats),
  );

  if (stats.toolsBlocked > 0) {
    ctx.addOutput(
      theme.muted(
        "  Tip: Run /surgical replay <turn#> to see decisions for a specific turn.\n" +
        "  To allow a blocked tool, promote the tier: /surgical medium or /surgical wide.\n",
      ),
    );
  }

  return true;
}

// ── Command: /surgical warmup ─────────────────────────────────────────────

/**
 * Handle /surgical warmup.
 *
 * Pre-computes tier scores for a set of representative goals using the
 * current codebase context, storing results in the PromotionScoreCache.
 * This primes the cache so the first agent-loop tick returns instantly.
 *
 * Also reports current cache stats and perf counters so the user can see
 * whether warmup has already been run.
 */
export async function handleSurgicalWarmup(
  _args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const t0 = Date.now();

  // Build a lightweight CodebaseContext from whatever the session knows
  const cwd = (ctx.state.cwd as string | undefined) ?? process.cwd();
  const codebaseCtx = { cwd };

  let computed = 0;
  try {
    computed = await warmupTierScoreCache(codebaseCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.addOutput(
      theme.warning(`\n  /surgical warmup failed: ${msg}\n`),
    );
    return true;
  }

  const elapsed = Date.now() - t0;
  const cache = getPromotionScoreCache();
  const cacheStats = cache.stats();
  const perfStats = getTierEvalPerfStats();

  const hitRatePct = Math.round(cacheStats.hitRate * 100);

  ctx.addOutput(
    [
      "",
      theme.accentBold("  Surgical Tier Cache Warmup"),
      `  Pre-computed entries: ${computed}`,
      `  Cache size now:       ${cacheStats.size} entries`,
      `  Warmup duration:      ${elapsed}ms`,
      "",
      theme.accentBold("  Cache Stats"),
      `  Hits:        ${cacheStats.hits}`,
      `  Misses:      ${cacheStats.misses}`,
      `  Hit rate:    ${hitRatePct}%`,
      `  Evictions:   ${cacheStats.evictions}`,
      "",
      theme.accentBold("  Perf Stats (since last reset)"),
      `  Total evaluations:    ${perfStats.totalEvaluations}`,
      `  Fast-path hits:       ${perfStats.fastPathHits}`,
      `  Cache hits:           ${perfStats.cacheHits}`,
      `  Timeout fallbacks:    ${perfStats.timeoutFallbacks}`,
      `  Avg eval duration:    ${perfStats.avgDurationMs.toFixed(1)}ms`,
      "",
      theme.muted("  Tip: run /surgical warmup again after large commits to refresh the cache."),
      "",
    ].join("\n"),
  );

  return true;
}

// ── Command: /surgical perf ───────────────────────────────────────────────

/**
 * Handle /surgical perf.
 *
 * Displays current tier evaluation performance stats and cache metrics.
 * Pass "reset" to reset the perf counters.
 */
export async function handleSurgicalPerf(
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const trimmed = args.trim().toLowerCase();

  if (trimmed === "reset") {
    resetTierEvalPerfStats();
    getPromotionScoreCache().resetStats();
    ctx.addOutput(theme.muted("\n  Surgical perf stats reset.\n"));
    return true;
  }

  const perfStats = getTierEvalPerfStats();
  const cache = getPromotionScoreCache();
  const cacheStats = cache.stats();
  const hitRatePct = Math.round(cacheStats.hitRate * 100);

  ctx.addOutput(
    [
      "",
      theme.accentBold("  Surgical Tier Evaluation — Perf Stats"),
      `  Total evaluations:  ${perfStats.totalEvaluations}`,
      `  Fast-path hits:     ${perfStats.fastPathHits}`,
      `  Cache hits:         ${perfStats.cacheHits}`,
      `  Timeout fallbacks:  ${perfStats.timeoutFallbacks}`,
      `  Avg eval duration:  ${perfStats.avgDurationMs.toFixed(1)}ms`,
      `  Total duration:     ${perfStats.totalDurationMs.toFixed(0)}ms`,
      "",
      theme.accentBold("  Cache Stats"),
      `  Size:       ${cacheStats.size} entries`,
      `  Hits:       ${cacheStats.hits}`,
      `  Misses:     ${cacheStats.misses}`,
      `  Hit rate:   ${hitRatePct}%`,
      `  Evictions:  ${cacheStats.evictions}`,
      "",
      theme.muted("  Use '/surgical perf reset' to clear counters."),
      "",
    ].join("\n"),
  );

  return true;
}

// ── Command registry ───────────────────────────────────────────────────────

/**
 * Return Command definitions for the surgical audit trail commands.
 * These are routed from the /surgical handler in agent.ts by matching
 * the "replay" and "audit" sub-command prefixes.
 */
export function surgicalAuditCommands(): Command[] {
  return [
    {
      name: "/surgical replay",
      description: "Show chronological tool decisions for a turn (default: latest)",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalReplay(args, ctx);
      },
    },
    {
      name: "/surgical audit",
      description: "Summary stats: tiers used, tools allowed/blocked, block reasons",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalAudit(args, ctx);
      },
    },
    {
      name: "/surgical warmup",
      description: "Pre-compute tier scores for current codebase (warms the promotion cache)",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalWarmup(args, ctx);
      },
    },
    {
      name: "/surgical perf",
      description: "Show tier evaluation perf stats and cache metrics (pass 'reset' to clear)",
      category: "agent",
      handler: async (args, ctx) => {
        return handleSurgicalPerf(args, ctx);
      },
    },
  ];
}
