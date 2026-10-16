/**
 * bashValidator — semantic validation for bash command parameters.
 *
 * Detects dangerous patterns before execution:
 *   - rm -rf /  (and variants that wipe root or home)
 *   - Writes to /dev/* (dd if=..., truncate /dev/sda, etc.)
 *   - Fork bombs  (:(){:|:&};:  and variants)
 *   - Pipe to /dev/null without redirection of meaningful output
 *     (specifically: redirecting stdout of a command that produces
 *      important output, leaving the caller blind to errors)
 *
 * Each rule carries a `suggestion` explaining what to do instead.
 *
 * Returns null when safe, or an error string when a dangerous pattern
 * is detected.  The registry raises a PermissionError with this message.
 */

export interface DangerousPattern {
  /** Human-readable name for the pattern */
  name: string;
  /** Regex tested against the full command string */
  pattern: RegExp;
  /** Suggested safer alternative */
  suggestion: string;
}

/**
 * Ordered list of dangerous bash command patterns.
 * Add new patterns here — keep them specific to avoid false positives.
 */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // ── Destructive filesystem wipes ────────────────────────────────
  {
    name: "rm -rf root",
    pattern: /\brm\s+(-\w*f\w*r\w*|-\w*r\w*f\w*)\s+(\/\s*$|\/\s+|"\/"\s*|'\/')/,
    suggestion: "Use 'rm -rf /specific/path' to target only the directory you intend to remove.",
  },
  {
    name: "rm -rf with wildcard at root",
    pattern: /\brm\s+(-\w*f\w*r\w*|-\w*r\w*f\w*)\s+\/\*/,
    suggestion: "Avoid globbing at root. Specify the exact directory path.",
  },
  {
    name: "rm -rf home",
    pattern: /\brm\s+(-\w*f\w*r\w*|-\w*r\w*f\w*)\s+(~\/?\s*$|~\/?\s+|"~"\s*|'~')/,
    suggestion: "Use 'rm -rf ~/specific/subdir' to target only the directory you intend to remove.",
  },
  // ── Writes to block/character devices ───────────────────────────
  {
    name: "write to /dev device",
    pattern: /\b(dd\s+.*of=\/dev\/|truncate\s+.*\/dev\/|>\s*\/dev\/(sd[a-z]|hd[a-z]|nvme\d|xvd[a-z]|disk\d))/,
    suggestion: "Do not write directly to block devices. Use a file path instead.",
  },
  // ── Fork bombs ───────────────────────────────────────────────────
  {
    name: "fork bomb",
    // Matches :(){:|:&};: and common variants with different function names
    pattern: /\w+\s*\(\s*\)\s*\{[^}]*\|\s*\w+\s*&\s*\}/,
    suggestion: "This looks like a fork bomb. Remove the self-referencing function call.",
  },
  {
    name: "fork bomb (classic)",
    // The exact classic form
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    suggestion: "Classic fork bomb detected. Do not run self-replicating shell functions.",
  },
  // ── Dangerous redirections ───────────────────────────────────────
  {
    name: "stdout to /dev/null losing all output",
    // Catches patterns like: some-cmd > /dev/null (no stderr redirect)
    // Only warns when there is no 2>&1 or 2>/dev/null keeping stderr visible.
    // We specifically target cases where the primary output pipe is silenced
    // with no redirection of stderr — a common accidental pattern.
    pattern: /[^2]>\s*\/dev\/null(?!\s*2[>&])/,
    suggestion:
      "Piping stdout to /dev/null hides output. If you want to suppress output, " +
      "use '> /dev/null 2>&1' to also suppress stderr, or capture output in a variable.",
  },
  // ── Overwrite critical system files ─────────────────────────────
  {
    name: "overwrite /etc/passwd or /etc/shadow",
    pattern: />\s*\/etc\/(passwd|shadow|sudoers|hosts)/,
    suggestion: "Do not overwrite critical system files. Use a temporary file and review changes first.",
  },
  // ── Dangerous curl | bash patterns ──────────────────────────────
  {
    name: "curl pipe to shell",
    pattern: /\bcurl\b.*\|\s*(ba)?sh\b/,
    suggestion:
      "Piping curl output directly to a shell is dangerous. " +
      "Download the script first ('curl -o script.sh URL'), inspect it, then run it.",
  },
  {
    name: "wget pipe to shell",
    pattern: /\bwget\b.*-[qO-]*\s*-\s*.*\|\s*(ba)?sh\b|\bwget\b.*\|\s*(ba)?sh\b/,
    suggestion:
      "Piping wget output directly to a shell is dangerous. " +
      "Download the script first, inspect it, then run it.",
  },
];

/**
 * Validate a bash command for dangerous patterns.
 *
 * @param command  The bash command string to validate
 * @returns null if safe, error string with suggestion if dangerous
 */
export function validateBash(command: string): string | null {
  if (!command || typeof command !== "string") {
    return "command must be a non-empty string";
  }

  for (const { name, pattern, suggestion } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return (
        `Dangerous command pattern detected [${name}]: "${command.slice(0, 120)}${command.length > 120 ? "…" : ""}". ` +
        `Suggested fix: ${suggestion}`
      );
    }
  }

  return null;
}
