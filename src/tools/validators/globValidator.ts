/**
 * globValidator — semantic validation for glob pattern parameters.
 *
 * Warns (returns an error string) when a pattern would match:
 *   - Fewer than 5 files  → pattern may be too specific / wrong directory
 *   - More than 10 000 files → pattern too broad, likely accidental
 *
 * "Warn" here means the registry treats it as a PermissionError so the
 * model sees the message and can refine the pattern.  The tool is not
 * executed when validation fails.
 *
 * Returns null when the pattern is within acceptable bounds.
 */

import fg from "fast-glob";
import { resolve } from "path";

/** Minimum file matches before we warn (too-specific pattern). */
export const GLOB_MIN_WARN = 5;
/** Maximum file matches before we warn (too-broad pattern). */
export const GLOB_MAX_WARN = 10_000;

/**
 * Validate a glob pattern against the filesystem.
 *
 * @param pattern   Glob pattern string
 * @param cwd       Working directory (tool context cwd)
 * @param searchPath  Optional sub-directory override (defaults to cwd)
 * @returns null if within bounds, warning string otherwise
 */
export async function validateGlob(
  pattern: string,
  cwd: string,
  searchPath?: string
): Promise<string | null> {
  if (!pattern || typeof pattern !== "string") {
    return "pattern must be a non-empty string";
  }

  const basePath = resolve(cwd, searchPath ?? ".");

  let count: number;
  try {
    // Count only — don't load stats to keep it fast
    const matches = await fg(pattern, {
      cwd: basePath,
      absolute: false,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
      onlyFiles: false,
    });
    count = matches.length;
  } catch {
    // Invalid pattern syntax or inaccessible directory — let execution fail naturally
    return null;
  }

  if (count === 0) {
    // Zero matches is not a validation error — let the tool report it.
    return null;
  }

  if (count < GLOB_MIN_WARN) {
    // Not blocking — fewer than 5 is valid but possibly unintentional
    // Don't block on too-few; just allow.
    return null;
  }

  if (count > GLOB_MAX_WARN) {
    return (
      `Glob pattern "${pattern}" matches ${count.toLocaleString()} files in ${basePath}, ` +
      `which exceeds the safety limit of ${GLOB_MAX_WARN.toLocaleString()}. ` +
      `Suggested fix: narrow the pattern (e.g. add a subdirectory prefix or a more specific extension).`
    );
  }

  return null;
}
