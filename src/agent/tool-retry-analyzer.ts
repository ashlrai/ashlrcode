/**
 * Tool Failure Recovery & Self-Healing Retry Patterns
 *
 * Classifies tool execution failures into actionable categories and builds
 * retry strategies with optional input mutation — so transient failures are
 * recovered automatically without re-prompting the user.
 *
 * Categories:
 *   - timeout      — execution exceeded time limit; retry with longer timeout
 *   - permission   — filesystem/OS permission denied; escalate to user
 *   - not-found    — file/path not found; try Glob-scan first then retry
 *   - parse        — JSON/output parse error; ask once for format clarification
 *   - transient    — generic network/MCP/flap error; plain exponential retry
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureCategory =
  | "timeout"
  | "permission"
  | "not-found"
  | "parse"
  | "transient";

export interface FailureClassification {
  /** Coarse category used for strategy selection. */
  category: FailureCategory;
  /** Whether automated retry without user intervention is possible. */
  recoverable: boolean;
  /** Human-readable description of the recommended next action. */
  suggestedAction: string;
}

export interface RetryStrategy {
  /** Maximum retry attempts (not counting the initial attempt). */
  maxRetries: number;
  /** Base delay between attempts in milliseconds (exponentially backed off). */
  delay: number;
  /**
   * Optional input mutator applied before each retry attempt.
   * Receives the original input (or the previously-mutated input) and the
   * 1-based retry number, and returns a new input object.
   * When omitted the original input is reused unchanged.
   */
  mutate?: (input: Record<string, unknown>, retryNum: number) => Record<string, unknown>;
}

/** Summary of a single retry attempt recorded in the retry history. */
export interface RetryAttemptRecord {
  /** Tool name. */
  toolName: string;
  /** 1-based attempt number (1 = first retry after initial failure). */
  attempt: number;
  /** Failure category that triggered this retry. */
  category: FailureCategory;
  /** Whether the attempt succeeded (true) or produced another error (false). */
  succeeded: boolean;
  /** ISO timestamp when the attempt was recorded. */
  timestamp: string;
  /** Original error message (truncated to 200 chars for storage efficiency). */
  errorMessage: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TIMEOUT_PATTERNS = [
  /timed?\s*out/i,
  /timeout/i,
  /ETIMEDOUT/,
  /ESOCKETTIMEDOUT/,
  /execution.*exceeded/i,
  /took too long/i,
  /deadline/i,
];

const PERMISSION_PATTERNS = [
  /permission denied/i,
  /EACCES/,
  /EPERM/,
  /Operation not permitted/i,
  /access denied/i,
  /not permitted/i,
];

const NOT_FOUND_PATTERNS = [
  /ENOENT/,
  /no such file or directory/i,
  /file not found/i,
  /path not found/i,
  /cannot find/i,
  /does not exist/i,
  /not found/i,
];

const PARSE_PATTERNS = [
  /JSON\s*parse/i,
  /unexpected token/i,
  /invalid json/i,
  /parse error/i,
  /syntax error/i,
  /malformed/i,
  /failed to parse/i,
];

const TRANSIENT_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /network/i,
  /socket/i,
  /503/,
  /502/,
  /unavailable/i,
  /mcp.*unavailable/i,
  /tool.*unavailable/i,
  /temporarily/i,
  /EAGAIN/,
];

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(message));
}

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

/**
 * Classify a tool execution error into one of the canonical failure categories.
 *
 * @param toolName  Name of the tool that failed (used for context-specific rules).
 * @param error     The error that was thrown or returned.
 * @param context   Optional structured context (e.g. { input: {...} }).
 */
export function classifyFailure(
  toolName: string,
  error: Error | unknown,
  context?: Record<string, unknown>
): FailureClassification {
  const message = error instanceof Error ? error.message : String(error);

  // Timeout — checked first because some timeout messages also mention "not found"
  if (matchesAny(message, TIMEOUT_PATTERNS)) {
    return {
      category: "timeout",
      recoverable: true,
      suggestedAction: `Retry "${toolName}" with a 50% larger timeout (up to 3×).`,
    };
  }

  // Permission — cannot self-heal; escalate to user
  if (matchesAny(message, PERMISSION_PATTERNS)) {
    return {
      category: "permission",
      recoverable: false,
      suggestedAction: `"${toolName}" was denied permission. Ask the user to grant access or run with elevated privileges.`,
    };
  }

  // Not-found — healable by scanning with Glob before retry
  if (matchesAny(message, NOT_FOUND_PATTERNS)) {
    const path = extractPath(context);
    const pathHint = path ? ` (looked for: ${path})` : "";
    return {
      category: "not-found",
      recoverable: true,
      suggestedAction: `Path not found${pathHint}. Use Glob to locate the correct path, then retry "${toolName}".`,
    };
  }

  // Parse — ask for format clarification once, then retry
  if (matchesAny(message, PARSE_PATTERNS)) {
    return {
      category: "parse",
      recoverable: true,
      suggestedAction: `"${toolName}" produced unparseable output. Ask the user for the expected format, then retry once.`,
    };
  }

  // Transient — generic network/MCP flap
  if (matchesAny(message, TRANSIENT_PATTERNS)) {
    return {
      category: "transient",
      recoverable: true,
      suggestedAction: `"${toolName}" encountered a transient error. Retry with exponential back-off.`,
    };
  }

  // Default: treat as transient — better to try once more than to give up
  return {
    category: "transient",
    recoverable: true,
    suggestedAction: `"${toolName}" failed with an unclassified error. Attempting one transient retry.`,
  };
}

/** Extract a file path from the tool's input context (best-effort). */
function extractPath(context?: Record<string, unknown>): string | null {
  if (!context) return null;
  const input = context.input as Record<string, unknown> | undefined;
  if (!input) return null;
  const p = input.file_path ?? input.path ?? input.filePath ?? input.dir;
  return typeof p === "string" ? p : null;
}

// ---------------------------------------------------------------------------
// buildRetryStrategy
// ---------------------------------------------------------------------------

/**
 * Build a concrete retry strategy for a classified failure.
 *
 * @param failure   Result from classifyFailure().
 * @param history   Previous retry records for this tool in the current session.
 *                  Used to avoid repeating strategies that have already failed.
 */
export function buildRetryStrategy(
  failure: FailureClassification,
  history: RetryAttemptRecord[] = []
): RetryStrategy {
  // Count previous attempts for this category to detect repeated failures
  const priorAttempts = history.filter((r) => r.category === failure.category).length;

  switch (failure.category) {
    // Timeout: increase timeout by 50% per retry, up to 3 retries
    case "timeout": {
      return {
        maxRetries: 3,
        delay: 500,
        mutate: (input, retryNum) => {
          const currentTimeout =
            typeof input.timeout === "number" ? input.timeout : 120_000;
          // Each retry multiplies by 1.5: 1.5x, 2.25x, 3.375x
          const factor = Math.pow(1.5, retryNum);
          return {
            ...input,
            timeout: Math.round(currentTimeout * factor),
          };
        },
      };
    }

    // Not-found: allow 2 retries with short delay (Glob scan happens externally)
    case "not-found": {
      return {
        maxRetries: 2,
        delay: 200,
        // The caller is expected to mutate the path via Glob before retrying;
        // the mutate here is a no-op placeholder so the infrastructure works.
        mutate: (input, _retryNum) => ({ ...input }),
      };
    }

    // Parse: only one clarification-based retry; if already tried, give up
    case "parse": {
      return {
        maxRetries: priorAttempts > 0 ? 0 : 1,
        delay: 100,
      };
    }

    // Permission: not recoverable — 0 automatic retries
    case "permission": {
      return {
        maxRetries: 0,
        delay: 0,
      };
    }

    // Transient: exponential back-off, up to 3 retries
    case "transient":
    default: {
      const baseDelay = 300;
      return {
        maxRetries: 3,
        delay: baseDelay * Math.pow(2, priorAttempts),
        mutate: (input, _retryNum) => ({ ...input }),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Session-scoped retry history (ring buffer)
// ---------------------------------------------------------------------------

const MAX_RETRY_HISTORY = 500;
const _retryHistory: RetryAttemptRecord[] = [];

/**
 * Record a retry attempt in the in-process ring buffer.
 * Never throws — safe to call unconditionally.
 */
export function recordRetryAttempt(record: RetryAttemptRecord): void {
  if (_retryHistory.length >= MAX_RETRY_HISTORY) {
    _retryHistory.shift();
  }
  _retryHistory.push(record);
}

/** Return a copy of the current retry history (most recent last). */
export function getRetryHistory(): readonly RetryAttemptRecord[] {
  return _retryHistory.slice();
}

/** Reset the history (for tests). */
export function resetRetryHistory(): void {
  _retryHistory.length = 0;
}

// ---------------------------------------------------------------------------
// Aggregate success-rate stats for /debug tool-failures
// ---------------------------------------------------------------------------

export interface ToolRetryStats {
  toolName: string;
  totalRetries: number;
  successfulRetries: number;
  failedRetries: number;
  successRate: number;
  categoryCounts: Partial<Record<FailureCategory, number>>;
}

/** Compute per-tool retry success-rate statistics from the history. */
export function getRetryStats(): ToolRetryStats[] {
  const byTool = new Map<string, RetryAttemptRecord[]>();
  for (const r of _retryHistory) {
    const list = byTool.get(r.toolName) ?? [];
    list.push(r);
    byTool.set(r.toolName, list);
  }

  const stats: ToolRetryStats[] = [];
  for (const [toolName, records] of byTool) {
    const total = records.length;
    const succeeded = records.filter((r) => r.succeeded).length;
    const categoryCounts: Partial<Record<FailureCategory, number>> = {};
    for (const r of records) {
      categoryCounts[r.category] = (categoryCounts[r.category] ?? 0) + 1;
    }
    stats.push({
      toolName,
      totalRetries: total,
      successfulRetries: succeeded,
      failedRetries: total - succeeded,
      successRate: total > 0 ? succeeded / total : 0,
      categoryCounts,
    });
  }

  return stats.sort((a, b) => b.totalRetries - a.totalRetries);
}

/** Format retry stats as a human-readable string. */
export function formatRetryStats(): string {
  const stats = getRetryStats();
  if (stats.length === 0) return "  No tool retries recorded this session.";

  const lines: string[] = ["  Tool Retry Statistics:"];
  const totalRetries = stats.reduce((s, t) => s + t.totalRetries, 0);
  const totalSucceeded = stats.reduce((s, t) => s + t.successfulRetries, 0);
  const overallRate = totalRetries > 0 ? Math.round((totalSucceeded / totalRetries) * 100) : 0;

  lines.push(`  Total retries: ${totalRetries}  (${overallRate}% recovered without user intervention)`);
  lines.push("");

  for (const s of stats) {
    const rate = Math.round(s.successRate * 100);
    const cats = Object.entries(s.categoryCounts)
      .map(([c, n]) => `${c}×${n}`)
      .join(", ");
    lines.push(
      `  ${s.toolName.padEnd(20)} ${String(s.totalRetries).padStart(3)} retries  ${String(rate).padStart(3)}% ok  [${cats}]`
    );
  }

  return lines.join("\n");
}
