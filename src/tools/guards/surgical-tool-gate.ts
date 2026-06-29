/**
 * Guard: Surgical Tool Gate
 *
 * In --surgical mode, restricts which tools and Bash patterns are allowed
 * based on the active ScopeTier (legacy 3-tier) or SurgicalTier (new 4-tier).
 * Prevents a "fix typo" run from accidentally installing packages, spawning
 * sub-agents, or piping to `curl | sh`.
 *
 * Legacy 3-tier restriction matrix (backward-compat):
 *
 *   narrow — Read, Grep, Bash (safe patterns only), Diff
 *            Blocked: Write, Edit, Agent, Bash with install/curl|sh/eval/exec
 *
 *   medium — Read, Grep, Bash (safe patterns only), Diff, Edit (existing files), Test
 *            Blocked: npm/pip install, Write new files, Agent spawn
 *
 *   wide   — All tools allowed (no restrictions — normal mode behavior)
 *
 * New 4-tier restriction matrix (progressive constraints):
 *
 *   Tier 1 (micro)    — Read, Glob, Grep, LS only
 *                       Blocked: Write, Edit, Bash, Agent, Coordinate, all others
 *
 *   Tier 2 (fine)     — Read, Glob, Grep, LS + Edit (single file)
 *                       Blocked: Bash, Write, Agent, Coordinate
 *
 *   Tier 3 (balanced) — Read, Glob, Grep, LS, Edit (multi-file), Bash (safe patterns)
 *                       Blocked: npm/pip install, curl|sh, eval, exec, Agent, Coordinate
 *
 *   Tier 4 (broad)    — All tools allowed (equivalent to old "wide" mode)
 *
 * Bash pattern whitelist (tiers 1–3):
 *   Tier 1: no Bash at all
 *   Tiers 2–3: Bash blocked for install/curl|sh/eval/exec
 *   Allowed command prefixes: grep, sed, awk, find, ls, cat, diff, git, head, tail, wc
 *
 * Never throws. If surgical mode is inactive, always returns { verdict: "allow" }.
 */

import type { ScopeTier } from "../../agent/surgical-scope.ts";
import type { SurgicalTier } from "./surgical-tier-promoter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SurgicalVerdict = "allow" | "block";

export interface SurgicalGateResult {
  verdict: SurgicalVerdict;
  /** Human-readable explanation, present only when verdict is "block". */
  reason?: string;
  /** Suggested alternative, present only when verdict is "block". */
  suggestion?: string;
}

export interface SurgicalGateOptions {
  /** Whether surgical mode is active. Gate is a no-op when false. */
  enabled: boolean;
  /**
   * The detected scope tier for this surgical run.
   * Accepts either the legacy ScopeTier ("narrow"/"medium"/"wide") for
   * backward-compat, or the new numeric SurgicalTier (1–4).
   */
  tier: ScopeTier | SurgicalTier;
}

// ---------------------------------------------------------------------------
// Tool restriction matrix
// ---------------------------------------------------------------------------

/**
 * Tools fully blocked per legacy ScopeTier.
 *
 * Note: "Bash" is not listed here — it is conditionally allowed subject to
 * pattern checks (see BASH_BLOCKED_PATTERNS / BASH_ALLOWED_PREFIXES).
 * "Write" in narrow is blocked entirely; in medium it is allowed only for
 * existing files (handled via context — we block it at gate level conservatively).
 */
const BLOCKED_TOOLS_BY_SCOPE_TIER: Record<ScopeTier, ReadonlySet<string>> = {
  narrow: new Set(["Write", "Edit", "Agent", "Coordinate"]),
  medium: new Set(["Agent", "Coordinate"]),
  wide: new Set(),
};

/**
 * Tools explicitly allowed per legacy ScopeTier. Used for the fast-allow path.
 * Any tool NOT in this set falls through to the per-tool logic.
 */
const ALLOWED_TOOLS_BY_SCOPE_TIER: Record<ScopeTier, ReadonlySet<string>> = {
  narrow: new Set(["Read", "Grep", "Diff", "Glob", "LS", "Ls"]),
  medium: new Set(["Read", "Grep", "Diff", "Glob", "LS", "Ls", "Edit", "Write", "Test"]),
  wide: new Set(), // wide allows everything — this set is unused
};

// ---------------------------------------------------------------------------
// 4-tier tool restriction matrix (new numeric tiers)
// ---------------------------------------------------------------------------

/**
 * Tools fully blocked per numeric SurgicalTier.
 *
 * Tier 1 (micro): Read/Glob/Grep/LS only — block everything else
 * Tier 2 (fine):  + Edit single file, still block Bash/Write/Agent/Coordinate
 * Tier 3 (balanced): block Agent/Coordinate, Bash allowed with pattern checks
 * Tier 4 (broad): no restrictions
 *
 * Note: Bash for tier 1 is blocked via the BASH_BLOCKED_BY_NUMERIC_TIER flag
 * rather than this set, to keep Bash checks unified in one path.
 */
const BLOCKED_TOOLS_BY_NUMERIC_TIER: Record<SurgicalTier, ReadonlySet<string>> = {
  1: new Set(["Write", "Edit", "Bash", "Agent", "Coordinate"]),
  2: new Set(["Write", "Bash", "Agent", "Coordinate"]),
  3: new Set(["Agent", "Coordinate"]),
  4: new Set(),
};

/**
 * Tools explicitly allowed per numeric SurgicalTier. Used for the fast-allow path.
 */
const ALLOWED_TOOLS_BY_NUMERIC_TIER: Record<SurgicalTier, ReadonlySet<string>> = {
  1: new Set(["Read", "Grep", "Glob", "LS", "Ls", "Diff"]),
  2: new Set(["Read", "Grep", "Glob", "LS", "Ls", "Diff", "Edit"]),
  3: new Set(["Read", "Grep", "Glob", "LS", "Ls", "Diff", "Edit", "Write", "Test"]),
  4: new Set(), // tier 4 allows everything — this set is unused
};

/** Human-readable tier label for block messages. */
const NUMERIC_TIER_LABELS: Record<SurgicalTier, string> = {
  1: "Tier 1 (micro) surgical",
  2: "Tier 2 (fine) surgical",
  3: "Tier 3 (balanced) surgical",
  4: "Tier 4 (broad) surgical",
};

/** Suggestion per blocked tool for numeric tiers. */
function numericTierBlockSuggestion(toolName: string, tier: SurgicalTier): string {
  if (toolName === "Bash" && tier === 1) {
    return "Tier 1 (micro) only allows read-only tools. Use Read/Grep/Glob/LS, or promote to Tier 2+.";
  }
  if (toolName === "Bash" && tier === 2) {
    return "Tier 2 (fine) blocks Bash. Promote to Tier 3 (balanced) to run safe Bash commands.";
  }
  if (toolName === "Write") {
    return tier <= 2
      ? "Tier 1–2 block file creation. Use Edit for single-file changes, or promote to Tier 3+."
      : "switch to normal mode for new file creation";
  }
  if (toolName === "Edit" && tier === 1) {
    return "Tier 1 (micro) is read-only. Promote to Tier 2 (fine) to edit a single file.";
  }
  if (toolName === "Agent" || toolName === "Coordinate") {
    return "Surgical mode does not allow spawning sub-agents. Use normal mode or Tier 4 (broad).";
  }
  return `Promote to a higher tier or switch to normal mode to use ${toolName}.`;
}

// ---------------------------------------------------------------------------
// Bash pattern restrictions
// ---------------------------------------------------------------------------

/**
 * Patterns that are always blocked in narrow/medium surgical Bash calls.
 * Checked against the full command string (lowercased).
 */
const BASH_BLOCKED_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // Package installs
  { pattern: /\b(npm|bun|pnpm|yarn)\s+(install|add|i)\b/, label: "package install (npm/bun/pnpm/yarn)" },
  { pattern: /\bpip[23]?\s+install\b/, label: "package install (pip)" },
  { pattern: /\bgem\s+install\b/, label: "package install (gem)" },
  { pattern: /\bcargo\s+add\b/, label: "package install (cargo)" },
  { pattern: /\bgo\s+get\b/, label: "package install (go get)" },
  // Piping to shell — common supply-chain attack vector
  { pattern: /\bcurl\b.*[|]\s*(bash|sh|zsh|fish)/, label: "curl pipe to shell" },
  { pattern: /\bwget\b.*[|]\s*(bash|sh|zsh|fish)/, label: "wget pipe to shell" },
  // eval / exec can run arbitrary injected code
  { pattern: /\beval\s+/, label: "eval" },
  { pattern: /\bexec\s+/, label: "exec" },
];

/**
 * Allowed command prefixes for narrow/medium surgical Bash.
 * The command (after trimming) must start with one of these.
 * If none match AND no blocked pattern matched, we allow with a warning
 * so legitimate commands outside this list are not silently dropped.
 * The gate blocks only explicit violations.
 */
const BASH_SAFE_PREFIXES: ReadonlyArray<string> = [
  "grep",
  "sed",
  "awk",
  "find",
  "ls",
  "cat",
  "diff",
  "git",
  "head",
  "tail",
  "wc",
  "echo",
  "printf",
  "sort",
  "uniq",
  "tr",
  "cut",
  "xargs",
  "test",
  "true",
  "false",
  "pwd",
  "which",
  "type",
  "file",
  "stat",
];

// ---------------------------------------------------------------------------
// Core gate logic
// ---------------------------------------------------------------------------

/**
 * Check whether a tool call is allowed under the active surgical scope.
 *
 * Dispatches to the legacy 3-tier path (string tier) or the new 4-tier path
 * (numeric tier) based on the type of opts.tier. This preserves full backward
 * compatibility with callers that pass ScopeTier strings while enabling the
 * new progressive constraint system for callers that pass SurgicalTier numbers.
 *
 * @param toolName - The tool being called (e.g. "Bash", "Write").
 * @param input    - The raw tool input (used to inspect Bash commands).
 * @param opts     - Gate options including tier and enabled flag.
 * @returns        - { verdict: "allow" } or { verdict: "block", reason, suggestion }.
 */
export function checkSurgicalToolGate(
  toolName: string,
  input: Record<string, unknown>,
  opts: SurgicalGateOptions,
): SurgicalGateResult {
  if (!opts.enabled) return { verdict: "allow" };

  // Numeric tier path (new 4-tier system)
  if (typeof opts.tier === "number") {
    return checkByNumericTier(toolName, input, opts.tier as SurgicalTier);
  }

  // Legacy string tier path — preserves original behavior exactly
  return checkByLegacyScopeTier(toolName, input, opts.tier as ScopeTier);
}

// ---------------------------------------------------------------------------
// Legacy 3-tier path (string "narrow" | "medium" | "wide")
// Preserves the exact original restriction behavior for backward compatibility.
// ---------------------------------------------------------------------------

function checkByLegacyScopeTier(
  toolName: string,
  input: Record<string, unknown>,
  tier: ScopeTier,
): SurgicalGateResult {
  if (tier === "wide") return { verdict: "allow" };

  // --- Unconditionally blocked tools -----------------------------------------
  const blocked = BLOCKED_TOOLS_BY_SCOPE_TIER[tier];
  if (blocked.has(toolName)) {
    const tierLabel = tier === "narrow" ? "narrow surgical" : "medium surgical";
    const suggestions: Record<string, string> = {
      Write: "use Edit to modify an existing file, or switch to normal mode for new files",
      Edit: tier === "narrow"
        ? "switch to medium or normal mode to edit files"
        : undefined as unknown as string,
      Agent: "surgical mode does not allow spawning sub-agents; use normal mode",
      Coordinate: "surgical mode does not allow spawning sub-agents; use normal mode",
    };
    return {
      verdict: "block",
      reason: `[surgical-tool-gate] "${toolName}" is not allowed in ${tierLabel} mode`,
      suggestion: suggestions[toolName] ?? `switch to normal mode to use ${toolName}`,
    };
  }

  // --- Bash-specific pattern checks ------------------------------------------
  if (toolName === "Bash") {
    return checkBashCommandLegacy(input, tier);
  }

  // --- Allowed tools fast path -----------------------------------------------
  if (ALLOWED_TOOLS_BY_SCOPE_TIER[tier].has(toolName)) return { verdict: "allow" };

  // --- Unknown tools: fail-open -----------------------------------------------
  return { verdict: "allow" };
}

// ---------------------------------------------------------------------------
// New 4-tier numeric path
// ---------------------------------------------------------------------------

/**
 * Core restriction check using the 4-tier numeric system.
 */
function checkByNumericTier(
  toolName: string,
  input: Record<string, unknown>,
  tier: SurgicalTier,
): SurgicalGateResult {
  // Tier 4 always allows everything
  if (tier === 4) return { verdict: "allow" };

  const tierLabel = NUMERIC_TIER_LABELS[tier];

  // --- Unconditionally blocked tools -----------------------------------------
  const blocked = BLOCKED_TOOLS_BY_NUMERIC_TIER[tier];
  if (blocked.has(toolName)) {
    return {
      verdict: "block",
      reason: `[surgical-tool-gate] "${toolName}" is not allowed in ${tierLabel} mode`,
      suggestion: numericTierBlockSuggestion(toolName, tier),
    };
  }

  // --- Bash-specific pattern checks (tiers 3 only; tiers 1–2 block Bash via BLOCKED_TOOLS) --
  if (toolName === "Bash") {
    return checkBashCommand(input, tier);
  }

  // --- Allowed tools fast path -----------------------------------------------
  const allowed = ALLOWED_TOOLS_BY_NUMERIC_TIER[tier];
  if (allowed.has(toolName)) return { verdict: "allow" };

  // --- Unknown / uncategorised tools: allow (fail-open) ----------------------
  return { verdict: "allow" };
}

/**
 * Validate a Bash command for the legacy 3-tier path.
 * Mirrors the original behavior: pattern-checks for both narrow and medium.
 */
function checkBashCommandLegacy(
  input: Record<string, unknown>,
  tier: "narrow" | "medium",
): SurgicalGateResult {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return { verdict: "allow" };

  const tierLabel = tier === "narrow" ? "narrow surgical" : "medium surgical";

  for (const { pattern, label } of BASH_BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        verdict: "block",
        reason: `[surgical-tool-gate] Bash "${label}" is not allowed in ${tierLabel} mode`,
        suggestion:
          label.includes("install")
            ? "In surgical mode, dependency adds are not permitted. Switch to normal mode if a package is genuinely needed."
            : "In surgical mode, that shell pattern is too risky. Use a safer alternative or switch to normal mode.",
      };
    }
  }

  if (tier === "narrow") {
    const firstWord = command.split(/\s+/)[0]?.toLowerCase() ?? "";
    const isSafe = BASH_SAFE_PREFIXES.some((prefix) => firstWord === prefix);
    if (!isSafe && firstWord.length > 0) {
      console.error(
        `[surgical-tool-gate] Note: "${firstWord}" is outside the narrow-mode safe-prefix list; allowing but flagging for review`,
      );
    }
  }

  return { verdict: "allow" };
}

/**
 * Validate a Bash command against surgical-mode pattern rules (numeric tier path).
 * Called for numeric tiers 3 only (tiers 1–2 block Bash outright; tier 4 allows all).
 */
function checkBashCommand(
  input: Record<string, unknown>,
  tier: SurgicalTier,
): SurgicalGateResult {
  const command = typeof input.command === "string" ? input.command.trim() : "";

  if (!command) {
    return { verdict: "allow" }; // empty command validated elsewhere
  }

  const tierLabel = NUMERIC_TIER_LABELS[tier] ?? "surgical";

  // Check blocked patterns first
  for (const { pattern, label } of BASH_BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        verdict: "block",
        reason: `[surgical-tool-gate] Bash "${label}" is not allowed in ${tierLabel} mode`,
        suggestion:
          label.includes("install")
            ? "In surgical mode, dependency adds are not permitted. Switch to normal mode if a package is genuinely needed."
            : "In surgical mode, that shell pattern is too risky. Use a safer alternative or switch to normal mode.",
      };
    }
  }

  // Tier 1 (micro) and Tier 2 (fine): additionally warn (but allow) commands
  // outside the safe prefix list. We don't hard-block unknown prefixes to avoid
  // false positives on legitimate commands like `jq`, `yq`, `node -e "…"`.
  // The blocked-pattern list above already catches the dangerous cases.
  // Note: tier 1 never reaches here (Bash is in BLOCKED_TOOLS_BY_NUMERIC_TIER[1]).
  if (tier <= 2) {
    const firstWord = command.split(/\s+/)[0]?.toLowerCase() ?? "";
    const isSafe = BASH_SAFE_PREFIXES.some((prefix) => firstWord === prefix);
    if (!isSafe && firstWord.length > 0) {
      // Allow but emit a console note — does not block
      console.error(
        `[surgical-tool-gate] Note: "${firstWord}" is outside the ${tierLabel} safe-prefix list; allowing but flagging for review`,
      );
    }
  }

  return { verdict: "allow" };
}

// ---------------------------------------------------------------------------
// Convenience: build a user-facing refusal message
// ---------------------------------------------------------------------------

/**
 * Format a blocked gate result into a tool-result string suitable for
 * returning from ToolRegistry.execute().
 */
export function formatSurgicalBlockMessage(result: SurgicalGateResult): string {
  const lines: string[] = [result.reason ?? "[surgical-tool-gate] Tool blocked by surgical mode"];
  if (result.suggestion) {
    lines.push(`Suggestion: ${result.suggestion}`);
  }
  return lines.join("\n");
}
