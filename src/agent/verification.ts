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
 */

import { runSubAgent, type SubAgentResult } from "./sub-agent.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import { getAgentContext } from "./async-context.ts";

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
}

export interface VerificationIssue {
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  description: string;
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
  // Prefer agent-context-scoped files if available
  const ctx = getAgentContext();
  if (ctx) {
    // Agent context doesn't track files yet — fall through to global
  }
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
 */
function buildVerificationPrompt(modifiedFiles: string[], intent?: string): string {
  const fileList = modifiedFiles.map(f => `  - ${f}`).join("\n");

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

If everything looks correct, report STATUS: PASS with no issues.
Be thorough but avoid false positives — only flag real problems.`;
}

/**
 * Parse the verification agent's output into structured results.
 */
function parseVerificationOutput(text: string, files: string[]): Omit<VerificationResult, "agentResult"> {
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

  // Extract individual issues
  const issuePattern = /\[(\w+)\]\s*([^\s:]+?)(?::(\d+))?\s*[—-]\s*(.+)/g;
  let match;
  while ((match = issuePattern.exec(text)) !== null) {
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

  return { passed, issues, summary, filesChecked: files };
}

/**
 * Run a verification sub-agent to check recent changes.
 */
export async function runVerification(
  config: VerificationConfig,
  options?: { intent?: string; files?: string[] }
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

  const prompt = buildVerificationPrompt(files, options?.intent);

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

  return { ...parsed, agentResult };
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

  return lines.join("\n");
}
