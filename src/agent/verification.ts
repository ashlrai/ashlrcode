/**
 * Verification Agent — auto-validates multi-file changes.
 *
 * After non-trivial edits (2+ files modified), spawns a read-only sub-agent
 * that reviews the git diff and modified files for:
 *   - Syntax errors and obvious bugs
 *   - Logic consistency with stated intent
 *   - Missing imports, undefined references
 *   - Unintended side effects
 *
 * Claude Code's internal verification agent "doubles completion rates."
 *
 * With --with-tests mode, also suggests and generates test stubs for uncovered paths.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runSubAgent, type SubAgentResult } from "./sub-agent.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";

export interface VerificationConfig {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  /** Minimum number of modified files to auto-trigger verification. Default: 2 */
  fileThreshold?: number;
  /** Max iterations for the verification sub-agent. Default: 10 */
  maxIterations?: number;
  /** Callback for verification progress */
  onOutput?: (text: string) => void;
}

export interface VerificationResult {
  passed: boolean;
  issues: VerificationIssue[];
  summary: string;
  filesChecked: string[];
  agentResult: SubAgentResult;
  /** Test suggestions produced when withTests mode is active */
  testSuggestions?: TestSuggestion[];
  /** Paths of generated test stub files (only present when withTests mode wrote files) */
  generatedTestFiles?: string[];
}

export interface VerificationIssue {
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  description: string;
}

/**
 * A concrete test recommendation for an uncovered code path.
 *
 * coverage: 0–100 — estimated % of the uncovered branch that this test exercises.
 * estimatedLines: rough line count for the generated stub.
 */
export interface TestSuggestion {
  file: string;
  testName: string;
  description: string;
  /** 0–100 estimated branch coverage gained */
  coverage: number;
  estimatedLines: number;
}

/**
 * Track files modified during a turn for automatic verification triggering.
 *
 * Uses a per-session global set. In sub-agent contexts, modifications are
 * tracked in the agent's AsyncLocalStorage context instead (see async-context.ts),
 * but this global is kept for the main REPL session.
 */
const _modifiedFiles = new Set<string>();

export function trackFileModification(filePath: string): void {
  _modifiedFiles.add(filePath);
}

export function getModifiedFiles(): string[] {
  // TODO: When agent context gains file tracking, prefer ctx-scoped files
  return Array.from(_modifiedFiles);
}

export function clearModifiedFiles(): void {
  _modifiedFiles.clear();
}

export function shouldAutoVerify(threshold: number = 2): boolean {
  return _modifiedFiles.size >= threshold;
}

/**
 * Build the verification prompt with context about what changed.
 * When withTests is true, the agent also performs coverage-gap analysis.
 */
function buildVerificationPrompt(modifiedFiles: string[], intent?: string, withTests?: boolean): string {
  const fileList = modifiedFiles.map(f => `  - ${f}`).join("\n");

  const testInstructions = withTests ? `
5. Analyze coverage gaps — identify branches, error paths, and edge cases that lack tests:
   - Look for if/else branches with no corresponding test
   - Catch blocks that are never exercised by tests
   - Public functions with no test coverage
   - Conditional logic that only has happy-path tests

6. Report test suggestions in this EXACT block after VERIFICATION_RESULT:

TEST_SUGGESTIONS:
- FILE: src/foo.ts | TEST: should handle null input | DESC: Covers the null-guard branch on line 42 | COVERAGE: 85 | LINES: 8
- FILE: src/bar.ts | TEST: throws on invalid config | DESC: Exercises the config-validation error path | COVERAGE: 72 | LINES: 5

Only include suggestions with estimated coverage > 50%.
Limit to the 5 most impactful suggestions.
` : "";

  return `You are a VERIFICATION AGENT. Your job is to review recent code changes for correctness.

## Modified Files
${fileList}

${intent ? `## Stated Intent\n${intent}\n` : ""}
## Your Task

1. Use the Diff tool to see what changed (run \`git diff\` via Bash if Diff is unavailable)
2. Read each modified file to understand the full context
3. Check for:
   - **Syntax errors**: Missing brackets, unclosed strings, invalid TypeScript
   - **Logic bugs**: Off-by-one errors, null/undefined access, wrong conditions
   - **Missing imports**: References to symbols not imported
   - **Type mismatches**: Arguments that don't match function signatures
   - **Unintended side effects**: Changes that break existing behavior
   - **Incomplete changes**: TODOs left behind, partial implementations

4. Report your findings in this EXACT format:

VERIFICATION_RESULT:
STATUS: PASS | FAIL
ISSUES:
- [ERROR|WARNING|INFO] file.ts:123 — Description of issue
- [WARNING] other-file.ts — Description
SUMMARY: One-line summary of verification outcome
${testInstructions}
If everything looks correct, report STATUS: PASS with no issues.
Be thorough but avoid false positives — only flag real problems.`;
}

/**
 * Parse the verification agent's output into structured results.
 * Also extracts an optional TEST_SUGGESTIONS block when present.
 */
export function parseVerificationOutput(text: string, files: string[]): Omit<VerificationResult, "agentResult"> {
  const issues: VerificationIssue[] = [];
  let passed = true;
  let summary = "Verification completed";

  // Extract STATUS
  const statusMatch = text.match(/STATUS:\s*(PASS|FAIL)/i);
  if (statusMatch) {
    passed = statusMatch[1]!.toUpperCase() === "PASS";
  }

  // Extract SUMMARY
  const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);
  if (summaryMatch) {
    summary = summaryMatch[1]!.trim();
  }

  // Extract individual issues — only within the VERIFICATION_RESULT block,
  // before any TEST_SUGGESTIONS section, to avoid false positives.
  const verificationBlock = text.split(/^TEST_SUGGESTIONS:/m)[0] ?? text;
  const issuePattern = /\[(\w+)\]\s*([^\s:]+?)(?::(\d+))?\s*[—-]\s*(.+)/g;
  let match;
  while ((match = issuePattern.exec(verificationBlock)) !== null) {
    const severityRaw = match[1]!.toLowerCase();
    const severity: VerificationIssue["severity"] =
      severityRaw === "error" ? "error" :
      severityRaw === "warning" ? "warning" : "info";

    issues.push({
      severity,
      file: match[2]!,
      line: match[3] ? parseInt(match[3], 10) : undefined,
      description: match[4]!.trim(),
    });

    if (severity === "error") passed = false;
  }

  // Extract TEST_SUGGESTIONS block
  const testSuggestions = parseTestSuggestions(text);

  return { passed, issues, summary, filesChecked: files, testSuggestions };
}

/**
 * Parse the TEST_SUGGESTIONS block from agent output.
 *
 * Expected line format (pipe-delimited key:value pairs):
 *   - FILE: src/foo.ts | TEST: name | DESC: desc | COVERAGE: 85 | LINES: 8
 */
export function parseTestSuggestions(text: string): TestSuggestion[] {
  const suggestions: TestSuggestion[] = [];

  // Find the TEST_SUGGESTIONS section — capture lines starting with "- " until
  // a blank line, a top-level section header (word chars + colon at line start),
  // or end of string. We avoid matching "- FILE:" as a section boundary by
  // requiring the header to start at column 0 with no leading dash/space.
  const sectionMatch = text.match(/^TEST_SUGGESTIONS:\s*\n((?:[ \t]*-[^\n]*\n?)*)/m);
  if (!sectionMatch) return suggestions;

  const block = sectionMatch[1]!;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/^\s*-\s*/, "").trim();
    if (!line) continue;

    // Parse pipe-separated key:value tokens
    const tokens: Record<string, string> = {};
    for (const segment of line.split("|")) {
      const colonIdx = segment.indexOf(":");
      if (colonIdx < 0) continue;
      const key = segment.slice(0, colonIdx).trim().toUpperCase();
      const val = segment.slice(colonIdx + 1).trim();
      tokens[key] = val;
    }

    const file = tokens["FILE"];
    const testName = tokens["TEST"];
    const description = tokens["DESC"] ?? tokens["DESCRIPTION"] ?? "";
    const coverage = parseInt(tokens["COVERAGE"] ?? "0", 10);
    const estimatedLines = parseInt(tokens["LINES"] ?? "5", 10);

    if (file && testName && !isNaN(coverage)) {
      suggestions.push({ file, testName, description, coverage, estimatedLines });
    }
  }

  return suggestions;
}

/**
 * Derive the test stub file path for a source file.
 *
 * src/agent/verification.ts  →  src/__tests__/verification.test.ts
 * src/ui/theme.ts             →  src/__tests__/theme.test.ts
 */
export function testPathForSource(sourceFile: string): string {
  // Normalise: strip leading ./ or /
  const rel = sourceFile.replace(/^\.\//, "").replace(/^\/+/, "");
  // Split into dir segments and filename
  const parts = rel.split("/");
  const filename = parts[parts.length - 1]!;
  const baseName = filename.replace(/\.(ts|tsx|js|jsx)$/, "");
  // Place test file under <first-segment>/__tests__/<module>.test.ts
  // e.g. src/agent/foo.ts  → src/__tests__/foo.test.ts
  const rootDir = parts[0] ?? "src";
  return `${rootDir}/__tests__/${baseName}.test.ts`;
}

/**
 * Build a Bun test stub for a single suggestion.
 */
function buildTestStub(suggestion: TestSuggestion, existingContent?: string): string {
  const importPath = suggestion.file
    .replace(/^src\//, "../")
    .replace(/\.(ts|tsx)$/, ".ts");

  const header = existingContent
    ? "" // Append to existing file — no header needed
    : `import { describe, test, expect } from "bun:test";\n// Auto-generated by /verify --with-tests\nimport {} from "${importPath}";\n\n`;

  const stub = `describe("${suggestion.file} — auto-suggested coverage", () => {\n  test("${suggestion.testName}", () => {\n    // TODO: ${suggestion.description}\n    // Estimated coverage gain: ${suggestion.coverage}%\n    expect(true).toBe(true); // replace with real assertion\n  });\n});\n`;

  return header + stub;
}

/**
 * Write test stubs for suggestions with coverage above threshold.
 * Returns the list of files written.
 */
export function generateTestStubs(
  suggestions: TestSuggestion[],
  cwd: string,
  coverageThreshold: number = 70,
): string[] {
  const written: string[] = [];

  // Group suggestions by target test file
  const byTestFile = new Map<string, TestSuggestion[]>();
  for (const s of suggestions) {
    if (s.coverage < coverageThreshold) continue;
    const testPath = testPathForSource(s.file);
    const group = byTestFile.get(testPath) ?? [];
    group.push(s);
    byTestFile.set(testPath, group);
  }

  for (const [relPath, group] of byTestFile) {
    const absPath = join(cwd, relPath);
    const existing = existsSync(absPath) ? readFileSync(absPath, "utf-8") : undefined;

    let content = existing ?? "";
    for (const suggestion of group) {
      content += buildTestStub(suggestion, existing ?? content);
    }

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    written.push(relPath);
  }

  return written;
}

/**
 * Call the LLM with modified files and diff to extract uncovered branches
 * and return structured test suggestions.
 *
 * Uses a lightweight read-only sub-agent (no tool calls, max 3 iterations)
 * so it is consistent with the rest of the verification system.
 */
export async function suggestTests(
  modifiedFiles: string[],
  diff: string,
  config: VerificationConfig,
): Promise<TestSuggestion[]> {
  if (modifiedFiles.length === 0) return [];

  const fileList = modifiedFiles.map(f => `  - ${f}`).join("\n");
  const prompt = `You are a TEST COVERAGE ANALYST. Given these modified files and their diff, identify uncovered branches.

## Modified Files
${fileList}

## Git Diff (truncated to 4000 chars)
${diff.slice(0, 4000)}

Identify the top 5 most impactful uncovered branches, error paths, or edge cases.
Respond ONLY with a TEST_SUGGESTIONS block — no other text:

TEST_SUGGESTIONS:
- FILE: <relative-path> | TEST: <test name> | DESC: <one sentence> | COVERAGE: <0-100> | LINES: <estimated stub lines>

Only include suggestions with COVERAGE > 50.`;

  try {
    const agentResult = await runSubAgent({
      name: "test-suggestion-agent",
      prompt,
      systemPrompt: "You are a test coverage analyst. Be concise and precise. Do not use any tools — respond only with the TEST_SUGGESTIONS block.",
      router: config.router,
      toolRegistry: config.toolRegistry,
      toolContext: config.toolContext,
      readOnly: true,
      maxIterations: 3,
    });

    return parseTestSuggestions(agentResult.text);
  } catch {
    // Non-fatal: suggestions are best-effort
    return [];
  }
}

/**
 * Run a verification sub-agent to check recent changes.
 *
 * Pass `withTests: true` to also request test suggestions and (when
 * `generateStubs` is true) write stub files for high-coverage suggestions.
 */
export async function runVerification(
  config: VerificationConfig,
  options?: {
    intent?: string;
    files?: string[];
    /** Enable test-suggestion mode */
    withTests?: boolean;
    /** Auto-write stub files for suggestions with coverage > coverageThreshold */
    generateStubs?: boolean;
    /** Min coverage (0–100) to auto-generate stubs. Default: 70 */
    coverageThreshold?: number;
  }
): Promise<VerificationResult> {
  const files = options?.files ?? getModifiedFiles();

  if (files.length === 0) {
    return {
      passed: true,
      issues: [],
      summary: "No files to verify",
      filesChecked: [],
      agentResult: { name: "verification", text: "", toolCalls: [], messages: [] },
    };
  }

  const withTests = options?.withTests ?? false;
  const prompt = buildVerificationPrompt(files, options?.intent, withTests);

  config.onOutput?.("  Running verification agent...\n");

  const agentResult = await runSubAgent({
    name: "verification-agent",
    prompt,
    systemPrompt: config.systemPrompt + "\n\nYou are a verification agent. Be thorough but concise. Only use read-only tools.",
    router: config.router,
    toolRegistry: config.toolRegistry,
    toolContext: config.toolContext,
    readOnly: true,
    maxIterations: config.maxIterations ?? 10,
    onText: config.onOutput,
  });

  const parsed = parseVerificationOutput(agentResult.text, files);

  const errorCount = parsed.issues.filter(i => i.severity === "error").length;
  const warnCount = parsed.issues.filter(i => i.severity === "warning").length;

  config.onOutput?.(
    parsed.passed
      ? `  ✓ Verification passed (${files.length} files checked)\n`
      : `  ✗ Verification failed: ${errorCount} errors, ${warnCount} warnings\n`
  );

  let generatedTestFiles: string[] | undefined;

  if (withTests && parsed.testSuggestions && parsed.testSuggestions.length > 0) {
    const threshold = options?.coverageThreshold ?? 70;
    const highCoverage = parsed.testSuggestions.filter(s => s.coverage > threshold);
    if (highCoverage.length > 0) {
      config.onOutput?.(`  Found ${highCoverage.length} high-coverage test suggestion(s)\n`);
    }

    if (options?.generateStubs && highCoverage.length > 0) {
      const cwd = config.toolContext.cwd ?? process.cwd();
      generatedTestFiles = generateTestStubs(parsed.testSuggestions, cwd, threshold);
      if (generatedTestFiles.length > 0) {
        config.onOutput?.(
          `  ✓ Generated ${generatedTestFiles.length} test stub file(s):\n` +
          generatedTestFiles.map(f => `    ${f}`).join("\n") + "\n"
        );
      }
    }
  }

  return { ...parsed, agentResult, generatedTestFiles };
}

/**
 * Format verification results for display.
 */
export function formatVerificationReport(result: VerificationResult): string {
  const lines: string[] = [];

  lines.push(result.passed ? "## ✓ Verification Passed" : "## ✗ Verification Failed");
  lines.push("");
  lines.push(`**Files checked:** ${result.filesChecked.length}`);
  lines.push(`**Summary:** ${result.summary}`);

  if (result.issues.length > 0) {
    lines.push("");
    lines.push("### Issues");
    for (const issue of result.issues) {
      const icon = issue.severity === "error" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
      const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      lines.push(`${icon} **${loc}** — ${issue.description}`);
    }
  }

  if (result.testSuggestions && result.testSuggestions.length > 0) {
    lines.push("");
    lines.push("### Test Suggestions");
    for (const s of result.testSuggestions) {
      lines.push(`🧪 **${s.file}** — \`${s.testName}\``);
      lines.push(`   ${s.description} *(~${s.coverage}% coverage, ~${s.estimatedLines} lines)*`);
    }
    if (!result.generatedTestFiles) {
      lines.push("");
      lines.push("*Run `/verify --with-tests` to auto-generate stubs for suggestions with coverage > 70%*");
    }
  }

  if (result.generatedTestFiles && result.generatedTestFiles.length > 0) {
    lines.push("");
    lines.push("### Generated Test Stubs");
    for (const f of result.generatedTestFiles) {
      lines.push(`📄 ${f}`);
    }
  }

  return lines.join("\n");
}
