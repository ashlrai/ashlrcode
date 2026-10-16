/**
 * Cross-File Semantic Verifier
 *
 * Builds a lightweight type/call graph from a set of modified TypeScript/JavaScript
 * files and detects semantic inconsistencies across file boundaries:
 *
 *   - Exported function signatures that changed in one file but call sites in
 *     other files still use the old signature.
 *   - Renamed exports referenced under the old name in sibling files.
 *   - Moved interfaces / type aliases referenced from the wrong import path.
 *
 * Usage:
 *   const issues = await runCrossFileVerification(modifiedFiles);
 *
 * This module is intentionally self-contained (no LLM calls) so it can run
 * fast as a pre-flight check before the heavyweight verification sub-agent.
 */

import { readFileSync, existsSync } from "fs";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CrossFileIssue {
  severity: "error" | "warning" | "info";
  /** File where the problem was found */
  file: string;
  line?: number;
  description: string;
  /** Suggested repair for the issue */
  suggestion?: string;
}

/** A parsed export entry from a source file */
export interface ExportedSymbol {
  name: string;
  kind: "function" | "class" | "type" | "interface" | "variable" | "enum";
  /** Simplified parameter list for functions (e.g. "x: number, y: string") */
  params?: string;
  /** Return type annotation when present */
  returnType?: string;
  /** Source line number (1-based) */
  line: number;
  /** Raw source snippet covering the signature */
  raw: string;
}

/** A parsed import statement in a file */
export interface ImportedSymbol {
  /** The local name used in the importing file */
  localName: string;
  /** The original exported name (may differ on renames: `import { foo as bar }`) */
  exportedName: string;
  /** Resolved relative path being imported from */
  fromPath: string;
  /** Source line number (1-based) */
  line: number;
}

/** Per-file analysis result */
export interface FileAnalysis {
  filePath: string;
  exports: ExportedSymbol[];
  imports: ImportedSymbol[];
}

/** A detected call site for an exported symbol */
export interface CallSite {
  file: string;
  line: number;
  /** Raw text of the call */
  raw: string;
  /** Arguments as a raw string */
  args: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const TS_EXT_RE = /\.(ts|tsx|js|jsx|mts|cts)$/;

/** Read file safely, returning empty string if not found */
function safeRead(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Split source into lines (preserves 1-based indexing via unshift) */
function toLines(src: string): string[] {
  return src.split("\n");
}

// ── Export extraction ─────────────────────────────────────────────────────────

/**
 * Regex patterns for common export forms.
 * Intentionally kept simple — handles the 95% case without a full TS parser.
 */
const EXPORT_PATTERNS: Array<{
  kind: ExportedSymbol["kind"];
  re: RegExp;
  nameGroup: number;
  paramsGroup?: number;
  returnTypeGroup?: number;
}> = [
  // export function foo(x: string, y: number): void
  {
    kind: "function",
    re: /^export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;\n]+))?/,
    nameGroup: 1,
    paramsGroup: 2,
    returnTypeGroup: 3,
  },
  // export const foo = (x: string) => ...   OR  export const foo: SomeType = ...
  {
    kind: "function",
    re: /^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{;\n]+))?\s*=>/,
    nameGroup: 1,
    paramsGroup: 2,
    returnTypeGroup: 3,
  },
  // export class Foo
  {
    kind: "class",
    re: /^export\s+(?:abstract\s+)?class\s+(\w+)/,
    nameGroup: 1,
  },
  // export interface Foo
  {
    kind: "interface",
    re: /^export\s+interface\s+(\w+)/,
    nameGroup: 1,
  },
  // export type Foo = ...
  {
    kind: "type",
    re: /^export\s+type\s+(\w+)\s*(?:<[^>]*>)?\s*=/,
    nameGroup: 1,
  },
  // export enum Foo
  {
    kind: "enum",
    re: /^export\s+enum\s+(\w+)/,
    nameGroup: 1,
  },
  // export const/let/var foo (not arrow function — covered above)
  {
    kind: "variable",
    re: /^export\s+(?:const|let|var)\s+(\w+)/,
    nameGroup: 1,
  },
];

export function extractExports(src: string): ExportedSymbol[] {
  const lines = toLines(src);
  const results: ExportedSymbol[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const { kind, re, nameGroup, paramsGroup, returnTypeGroup } of EXPORT_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[nameGroup];
      if (!name || seen.has(name)) break;
      seen.add(name);
      results.push({
        name,
        kind,
        params: paramsGroup !== undefined ? (m[paramsGroup] ?? "").trim() : undefined,
        returnType:
          returnTypeGroup !== undefined && m[returnTypeGroup]
            ? m[returnTypeGroup]!.trim()
            : undefined,
        line: i + 1,
        raw: lines[i]!.trim(),
      });
      break; // Only match one pattern per line
    }
  }
  return results;
}

// ── Import extraction ─────────────────────────────────────────────────────────

/**
 * Parse import statements of the form:
 *   import { foo, bar as baz } from "./path"
 *   import type { Foo } from "../types"
 */
export function extractImports(src: string, filePath: string): ImportedSymbol[] {
  const lines = toLines(src);
  const results: ImportedSymbol[] = [];

  // Resolve a relative import path to a normalised form usable as a map key.
  // We intentionally don't resolve to absolute to stay portable — consumers
  // compare using the normalised relative paths returned here.
  function resolveFrom(from: string): string {
    // Strip quotes
    from = from.replace(/['"]/g, "").trim();
    // Remove trailing extension if not present (allow bare paths)
    return from;
  }

  // We track multi-line imports by joining continuation lines
  let inMultiLine = false;
  let buffer = "";
  let bufferStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (!inMultiLine && !trimmed.startsWith("import")) continue;

    if (!inMultiLine) {
      buffer = trimmed;
      bufferStart = i;
    } else {
      buffer += " " + trimmed;
    }

    // Check if the statement is complete
    if (buffer.includes("}") || (buffer.includes("from") && !buffer.includes("{"))) {
      inMultiLine = false;
      // Parse the complete import statement
      const fromMatch = buffer.match(/from\s+(['"][^'"]+['"])/);
      if (!fromMatch) {
        buffer = "";
        continue;
      }
      const fromPath = resolveFrom(fromMatch[1]!);

      // Extract named imports: { foo, bar as baz }
      const namedMatch = buffer.match(/\{([^}]+)\}/);
      if (namedMatch) {
        for (const segment of namedMatch[1]!.split(",")) {
          const cleaned = segment.trim().replace(/^type\s+/, "");
          if (!cleaned) continue;
          const aliasParts = cleaned.split(/\s+as\s+/);
          const exportedName = aliasParts[0]!.trim();
          const localName = aliasParts[1]?.trim() ?? exportedName;
          if (exportedName) {
            results.push({
              localName,
              exportedName,
              fromPath,
              line: bufferStart + 1,
            });
          }
        }
      }
      buffer = "";
    } else if (!trimmed.endsWith(";") && !trimmed.includes("from")) {
      // Continue buffering
      inMultiLine = true;
    } else {
      inMultiLine = false;
      buffer = "";
    }
  }

  return results;
}

// ── Call site detection ───────────────────────────────────────────────────────

/**
 * Find all call sites for a named function in source text.
 * Returns line numbers and raw argument strings.
 *
 * We look for `name(` patterns that are not preceded by `function `, `=>`, or
 * `export` (i.e., definitions rather than calls).
 */
export function findCallSites(src: string, name: string, filePath: string): CallSite[] {
  const lines = toLines(src);
  const results: CallSite[] = [];
  // Match: identifier followed by ( that is not a definition
  const callRe = new RegExp(`(?<![\\w.])${escapeRegExp(name)}\\s*\\(`, "g");
  const defRe = new RegExp(
    `(?:function|=>|export\\s+(?:const|function|async\\s+function))\\s+${escapeRegExp(name)}\\s*[(<]`,
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!callRe.test(line)) {
      callRe.lastIndex = 0;
      continue;
    }
    callRe.lastIndex = 0;
    // Skip lines that look like definitions
    if (defRe.test(line)) continue;

    // Extract argument string (best-effort, single-line only)
    const parenStart = line.indexOf(`${name}(`);
    let args = "";
    if (parenStart >= 0) {
      const afterParen = line.slice(parenStart + name.length + 1);
      let depth = 1;
      let end = 0;
      for (let j = 0; j < afterParen.length; j++) {
        if (afterParen[j] === "(") depth++;
        else if (afterParen[j] === ")") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      args = afterParen.slice(0, end).trim();
    }

    results.push({ file: filePath, line: i + 1, raw: line.trim(), args });
  }
  return results;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Parameter type extraction ─────────────────────────────────────────────────

/**
 * Parse a TypeScript parameter list string into an array of parameter info.
 * Input: "x: string, y: number, z?: boolean"
 * Output: [{ name: "x", type: "string", optional: false }, ...]
 */
export interface ParsedParam {
  name: string;
  type: string;
  optional: boolean;
}

export function parseParams(paramStr: string): ParsedParam[] {
  if (!paramStr.trim()) return [];
  return paramStr.split(",").map(p => {
    const trimmed = p.trim();
    const optional = trimmed.includes("?");
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) return { name: trimmed.replace("?", ""), type: "any", optional };
    const name = trimmed.slice(0, colonIdx).replace("?", "").trim();
    const type = trimmed.slice(colonIdx + 1).trim();
    return { name, type, optional };
  });
}

// ── Argument type inference ───────────────────────────────────────────────────

/**
 * Very basic heuristic to infer the TypeScript type of a call argument expression.
 * This is intentionally conservative — we only flag obvious mismatches.
 */
export function inferArgType(arg: string): string | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  if (trimmed === "true" || trimmed === "false") return "boolean";
  if (/^\d+$/.test(trimmed)) return "number";
  if (/^\d+\.\d+$/.test(trimmed)) return "number";
  if (/^['"`]/.test(trimmed)) return "string";
  if (/^null$/.test(trimmed)) return "null";
  if (/^undefined$/.test(trimmed)) return "undefined";
  if (/^\[/.test(trimmed)) return "array";
  if (/^\{/.test(trimmed)) return "object";
  // Template literal
  if (/^`/.test(trimmed)) return "string";
  // Numeric conversion functions — returns a number
  if (/^(?:parseInt|parseFloat|Number)\s*\(/.test(trimmed)) return "number";
  // String conversion
  if (/^String\s*\(/.test(trimmed)) return "string";
  return null; // Unknown — skip check
}

/**
 * Return true if typeA is *definitely incompatible* with typeB.
 * We only flag clear-cut cases to minimise false positives.
 */
export function typesAreIncompatible(typeA: string, typeB: string): boolean {
  const normalise = (t: string) =>
    t
      .replace(/\s/g, "")
      .replace(/readonly\s*/g, "")
      .toLowerCase();
  const a = normalise(typeA);
  const b = normalise(typeB);
  if (a === b) return false;
  if (a === "any" || b === "any") return false;
  if (a === "unknown" || b === "unknown") return false;
  // Primitive incompatibilities
  const primitives = new Set(["string", "number", "boolean", "bigint", "symbol"]);
  if (primitives.has(a) && primitives.has(b) && a !== b) return true;
  return false;
}

// ── Main cross-file analysis ──────────────────────────────────────────────────

/**
 * Analyse a single file and return its exports and imports.
 */
export function analyseFile(filePath: string): FileAnalysis {
  const src = safeRead(filePath);
  return {
    filePath,
    exports: extractExports(src),
    imports: extractImports(src, filePath),
  };
}

/**
 * Build a map from normalised module specifier → FileAnalysis for all
 * provided file paths.
 *
 * The key is the path as it would appear in an import statement FROM another
 * file in the same directory. We normalise to a relative path without extension.
 */
function buildExportMap(
  analyses: FileAnalysis[],
): Map<string, FileAnalysis> {
  const map = new Map<string, FileAnalysis>();
  for (const a of analyses) {
    // Store under both the raw path and a stripped-extension variant
    const stripped = a.filePath.replace(TS_EXT_RE, "");
    map.set(a.filePath, a);
    map.set(stripped, a);
    // Also store under just the basename for simple resolution
    const baseName = stripped.split("/").pop();
    if (baseName) {
      // Don't overwrite — first wins
      if (!map.has(baseName)) map.set(baseName, a);
    }
  }
  return map;
}

/**
 * Resolve a relative import path like `"./foo"` or `"../utils/bar"` to the
 * absolute file path of the imported module, given the importing file's path.
 *
 * Returns null if the path cannot be resolved among the provided candidates.
 */
function resolveImportPath(
  fromPath: string,
  importingFile: string,
  candidates: string[],
): string | null {
  // Only handle relative imports
  if (!fromPath.startsWith(".")) return null;

  const importingDir = importingFile.includes("/")
    ? importingFile.slice(0, importingFile.lastIndexOf("/"))
    : ".";

  // Compute a normalised target path
  const segments = (importingDir + "/" + fromPath).split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  const base = resolved.join("/");

  // Try exact match and with extensions
  for (const ext of ["", ".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = base + ext;
    if (candidates.includes(candidate)) return candidate;
  }

  // Try index files
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const indexCandidate = base + "/index" + ext;
    if (candidates.includes(indexCandidate)) return indexCandidate;
  }

  return null;
}

/**
 * Main entry point: run cross-file semantic verification on a list of modified
 * source files. Returns an array of issues found.
 *
 * Algorithm:
 *  1. Analyse each file → collect exports + imports
 *  2. For each file F, look at which exports it defines
 *  3. For every other modified file G that imports from F, check:
 *     a. The imported name actually exists in F's exports (renamed export check)
 *     b. For function imports, find call sites in G and check argument count /
 *        obvious type mismatches against F's parameter list
 *  4. Return all detected issues with repair suggestions
 */
export function runCrossFileVerification(filePaths: string[]): CrossFileIssue[] {
  if (filePaths.length < 2) return [];

  const issues: CrossFileIssue[] = [];
  const analyses = filePaths.map(analyseFile);
  const exportMap = buildExportMap(analyses);

  for (const importing of analyses) {
    const importingSrc = safeRead(importing.filePath);

    for (const imp of importing.imports) {
      // Try to resolve the import to one of our modified files
      const resolvedPath = resolveImportPath(imp.fromPath, importing.filePath, filePaths);
      if (!resolvedPath) continue;

      const exporting = exportMap.get(resolvedPath);
      if (!exporting) continue;

      // ── Check 1: Renamed / missing export ──────────────────────────────
      const exportedNames = new Set(exporting.exports.map(e => e.name));
      if (!exportedNames.has(imp.exportedName)) {
        // The imported name doesn't exist in the exporting file.
        // Look for near-matches (case-insensitive or prefix) to suggest rename.
        const lower = imp.exportedName.toLowerCase();
        const suggestions = exporting.exports
          .filter(e => e.name.toLowerCase().includes(lower) || lower.includes(e.name.toLowerCase()))
          .map(e => e.name);

        const suggestionText =
          suggestions.length > 0
            ? `Did you mean: ${suggestions.join(", ")}?`
            : `Available exports: ${[...exportedNames].slice(0, 5).join(", ")}`;

        issues.push({
          severity: "error",
          file: importing.filePath,
          line: imp.line,
          description: `Import '${imp.exportedName}' not found in '${imp.fromPath}'. ${suggestionText}`,
          suggestion: suggestions[0]
            ? `Update import to use '${suggestions[0]}' instead of '${imp.exportedName}'`
            : undefined,
        });
        continue; // No point checking call sites for a missing export
      }

      // ── Check 2: Function signature call-site verification ─────────────
      const exportedFn = exporting.exports.find(
        e => e.name === imp.exportedName && e.kind === "function",
      );
      if (!exportedFn || exportedFn.params === undefined) continue;

      const expectedParams = parseParams(exportedFn.params);
      if (expectedParams.length === 0) continue; // No params → nothing to check

      const callSites = findCallSites(importingSrc, imp.localName, importing.filePath);

      for (const site of callSites) {
        const rawArgs = site.args
          .split(",")
          .map(a => a.trim())
          .filter(Boolean);

        const requiredCount = expectedParams.filter(p => !p.optional).length;
        const maxCount = expectedParams.length;

        // Check argument count
        if (rawArgs.length < requiredCount) {
          issues.push({
            severity: "error",
            file: site.file,
            line: site.line,
            description: `Call to '${imp.localName}' passes ${rawArgs.length} argument(s) but '${imp.exportedName}' requires at least ${requiredCount}.`,
            suggestion: `Update call to pass all required arguments: ${exportedFn.params}`,
          });
          continue;
        }

        if (rawArgs.length > maxCount) {
          issues.push({
            severity: "warning",
            file: site.file,
            line: site.line,
            description: `Call to '${imp.localName}' passes ${rawArgs.length} argument(s) but '${imp.exportedName}' accepts at most ${maxCount}.`,
            suggestion: `Remove extra argument(s) from call to '${imp.localName}'`,
          });
          continue;
        }

        // Check argument types for obvious mismatches
        for (let i = 0; i < rawArgs.length; i++) {
          const param = expectedParams[i];
          if (!param) continue;
          const inferredType = inferArgType(rawArgs[i]!);
          if (inferredType === null) continue; // Unknown type — skip

          // Normalise expected type (strip generics, union, etc.)
          const expectedType = param.type
            .split("|")[0]!
            .trim()
            .replace(/<.*>/, "")
            .replace(/\[\]/, "");

          if (typesAreIncompatible(inferredType, expectedType)) {
            issues.push({
              severity: "error",
              file: site.file,
              line: site.line,
              description: `Argument ${i + 1} of '${imp.localName}' call: expected '${param.type}' but got '${inferredType}' (value: ${rawArgs[i]}).`,
              suggestion: buildRepairSuggestion(rawArgs[i]!, inferredType, param.type, imp.localName, site),
            });
          }
        }
      }
    }
  }

  return issues;
}

/** Generate a concrete repair suggestion for a type mismatch */
function buildRepairSuggestion(
  arg: string,
  inferredType: string,
  expectedType: string,
  fnName: string,
  site: CallSite,
): string {
  // string → number
  if (inferredType === "string" && (expectedType === "number" || expectedType === "bigint")) {
    return `File ${site.file}, line ${site.line}: update ${fnName}(${arg}) to ${fnName}(parseInt(${arg}, 10))`;
  }
  // number → string
  if (inferredType === "number" && expectedType === "string") {
    return `File ${site.file}, line ${site.line}: update ${fnName}(${arg}) to ${fnName}(String(${arg}))`;
  }
  // boolean → string
  if (inferredType === "boolean" && expectedType === "string") {
    return `File ${site.file}, line ${site.line}: update ${fnName}(${arg}) to ${fnName}(String(${arg}))`;
  }
  // boolean → number
  if (inferredType === "boolean" && expectedType === "number") {
    return `File ${site.file}, line ${site.line}: update ${fnName}(${arg}) to ${fnName}(${arg} ? 1 : 0)`;
  }
  return `File ${site.file}, line ${site.line}: convert argument ${arg} from ${inferredType} to ${expectedType}`;
}

// ── Report formatting ─────────────────────────────────────────────────────────

/**
 * Format cross-file issues into human-readable lines suitable for prepending
 * to the verification report.
 */
export function formatCrossFileReport(issues: CrossFileIssue[]): string {
  if (issues.length === 0) return "## Cross-File Verification: No issues found\n";

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warnCount = issues.filter(i => i.severity === "warning").length;

  const lines: string[] = [
    `## Cross-File Verification: ${errorCount} error(s), ${warnCount} warning(s)`,
    "",
  ];

  for (const issue of issues) {
    const icon = issue.severity === "error" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
    const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
    lines.push(`${icon} **${loc}** — ${issue.description}`);
    if (issue.suggestion) {
      lines.push(`   💡 ${issue.suggestion}`);
    }
  }

  return lines.join("\n");
}
