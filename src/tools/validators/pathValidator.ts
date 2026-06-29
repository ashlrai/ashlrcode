/**
 * pathValidator — semantic validation for file path parameters.
 *
 * Rejects:
 *   - Path traversal sequences ("..") that would escape cwd
 *   - Symlinks whose real path resolves outside cwd
 *
 * Returns null when safe, or an error string with a suggested fix.
 */

import { resolve, normalize, relative } from "path";
import { lstatSync, realpathSync } from "fs";

/** Resolve the canonical real path of a directory, falling back to the input on error. */
function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Validate a file path for safety.
 *
 * @param filePath  Raw path from tool input (may be relative or absolute)
 * @param cwd       Working directory (tool context cwd)
 * @returns null if safe, error string with suggested fix if not
 */
export function validatePath(filePath: string, cwd: string): string | null {
  if (!filePath || typeof filePath !== "string") {
    return "file_path must be a non-empty string";
  }

  // ── Traversal check ──────────────────────────────────────────────
  // Normalise the path and check if it contains ".." segments that
  // would escape cwd.  We do this before resolving so we catch
  // patterns like "../../etc/passwd" even if the intermediate dirs
  // don't exist.
  // Use the canonical cwd so macOS /private/var symlinks don't cause false positives
  const canonicalCwd = realCwd(cwd);

  const normalised = normalize(filePath);
  if (normalised.includes("..")) {
    // Allow if the resolved absolute path still sits inside cwd
    const resolved = resolve(canonicalCwd, filePath);
    const rel = relative(canonicalCwd, resolved);
    if (rel.startsWith("..")) {
      return (
        `Path traversal rejected: "${filePath}" resolves outside the working directory. ` +
        `Suggested fix: use an absolute path or a path relative to cwd (${cwd}).`
      );
    }
  }

  // ── Symlink check ────────────────────────────────────────────────
  // If the path exists, resolve symlinks and verify the real path
  // stays within cwd.
  const resolved = resolve(canonicalCwd, filePath);
  try {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(resolved);
      const rel = relative(canonicalCwd, real);
      if (rel.startsWith("..")) {
        return (
          `Symlink rejected: "${filePath}" points outside the working directory ` +
          `(resolves to "${real}"). ` +
          `Suggested fix: access the target path directly instead of via a symlink.`
        );
      }
    }
  } catch {
    // File doesn't exist yet (e.g. Write tool target) — that's fine.
  }

  return null;
}
