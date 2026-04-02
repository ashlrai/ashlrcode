/**
 * Codebase scanner — discovers work items autonomously.
 *
 * Scans for: TODOs, missing tests, lint errors, type errors,
 * security issues, dead code, complexity, missing docs.
 */

import { randomUUID } from "crypto";
import type { WorkItem, WorkItemType, WorkItemPriority } from "./types.ts";

interface ScanContext {
  cwd: string;
  runCommand: (cmd: string) => Promise<string>;
  searchFiles: (pattern: string, path?: string) => Promise<string>;
  grepContent: (pattern: string, glob?: string) => Promise<string>;
}

/**
 * Run a full scan and return discovered work items.
 */
export async function scanCodebase(ctx: ScanContext, types: WorkItemType[]): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  const now = new Date().toISOString();

  // Run scans in parallel for speed
  const scanners: Array<Promise<WorkItem[]>> = [];

  if (types.includes("todo")) scanners.push(scanTodos(ctx, now));
  if (types.includes("missing_test")) scanners.push(scanMissingTests(ctx, now));
  if (types.includes("type_error")) scanners.push(scanTypeErrors(ctx, now));
  if (types.includes("lint_error")) scanners.push(scanLintErrors(ctx, now));
  if (types.includes("complexity")) scanners.push(scanComplexity(ctx, now));
  if (types.includes("security")) scanners.push(scanSecurity(ctx, now));
  if (types.includes("dead_code")) scanners.push(scanDeadCode(ctx, now));

  const results = await Promise.allSettled(scanners);
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    }
  }

  return items;
}

// ── Individual Scanners ──

async function scanTodos(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    const result = await ctx.grepContent("(TODO|FIXME|HACK|XXX):", "*.{ts,tsx,js,jsx,py,go,rs}");
    const lines = result.split("\n").filter(l => l.trim());

    for (const line of lines.slice(0, 50)) { // Cap at 50
      const match = line.match(/^(.+?):(\d+):(.+)$/);
      if (!match) continue;
      const [, file, lineNum, content] = match;
      const isFixme = content!.includes("FIXME") || content!.includes("HACK");

      items.push({
        id: randomUUID().slice(0, 8),
        type: "todo",
        priority: isFixme ? "high" : "medium",
        title: `${isFixme ? "FIXME" : "TODO"} in ${file}:${lineNum}`,
        description: content!.trim().slice(0, 200),
        file: file!,
        line: parseInt(lineNum!, 10),
        status: "discovered",
        discoveredAt: now,
      });
    }
  } catch {}
  return items;
}

async function scanMissingTests(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    const srcFiles = await ctx.searchFiles("src/**/*.ts");
    const testFiles = await ctx.searchFiles("src/**/*.test.ts");

    const srcList = srcFiles.split("\n").filter(f => f.trim() && !f.includes(".test.") && !f.includes("__tests__"));
    const testList = new Set(testFiles.split("\n").map(f => f.trim()));

    for (const src of srcList.slice(0, 20)) {
      const expectedTest = src.replace(".ts", ".test.ts");
      if (!testList.has(expectedTest) && !src.includes("/types") && !src.includes("/index")) {
        items.push({
          id: randomUUID().slice(0, 8),
          type: "missing_test",
          priority: "medium",
          title: `No tests for ${src.split("/").pop()}`,
          description: `${src} has no corresponding test file`,
          file: src,
          status: "discovered",
          discoveredAt: now,
        });
      }
    }
  } catch {}
  return items;
}

async function scanTypeErrors(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    const result = await ctx.runCommand("bunx tsc --noEmit 2>&1 || true");
    const errors = result.split("\n").filter(l => l.includes("error TS"));

    for (const error of errors.slice(0, 20)) {
      const match = error.match(/^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/);
      if (!match) continue;
      const [, file, lineNum, code, msg] = match;

      items.push({
        id: randomUUID().slice(0, 8),
        type: "type_error",
        priority: "high",
        title: `${code} in ${file}:${lineNum}`,
        description: msg!.trim(),
        file: file!,
        line: parseInt(lineNum!, 10),
        status: "discovered",
        discoveredAt: now,
      });
    }
  } catch {}
  return items;
}

async function scanLintErrors(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    const result = await ctx.runCommand("npx eslint src/ --format json 2>/dev/null || true");
    // Parse JSON output if available
    try {
      const data = JSON.parse(result);
      for (const file of data) {
        for (const msg of (file.messages ?? []).slice(0, 10)) {
          items.push({
            id: randomUUID().slice(0, 8),
            type: "lint_error",
            priority: msg.severity === 2 ? "high" : "low",
            title: `${msg.ruleId} in ${file.filePath.split("/").pop()}:${msg.line}`,
            description: msg.message,
            file: file.filePath,
            line: msg.line,
            status: "discovered",
            discoveredAt: now,
          });
        }
      }
    } catch {
      // ESLint not available or no JSON output
    }
  } catch {}
  return items;
}

async function scanComplexity(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    // Find functions > 50 lines by searching for function/method patterns
    const result = await ctx.grepContent("^(export )?(async )?(function |const .+ = )", "*.{ts,tsx}");
    const lines = result.split("\n").filter(l => l.trim());

    // Group by file to detect long functions
    // (Simplified: just flag files with many function definitions as potentially complex)
    const fileCounts = new Map<string, number>();
    for (const line of lines) {
      const file = line.split(":")[0];
      if (file) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }

    for (const [file, count] of fileCounts) {
      if (count > 15) { // Files with many functions might need splitting
        items.push({
          id: randomUUID().slice(0, 8),
          type: "complexity",
          priority: "low",
          title: `${file.split("/").pop()} has ${count} functions`,
          description: `Consider splitting ${file} into smaller modules`,
          file,
          status: "discovered",
          discoveredAt: now,
        });
      }
    }
  } catch {}
  return items;
}

async function scanSecurity(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    const result = await ctx.runCommand("bun pm ls 2>/dev/null | grep -i 'vulnerab' || npm audit --json 2>/dev/null || true");
    if (result.includes("vulnerab") || result.includes("critical") || result.includes("high")) {
      items.push({
        id: randomUUID().slice(0, 8),
        type: "security",
        priority: "critical",
        title: "Dependency vulnerabilities detected",
        description: result.slice(0, 300),
        file: "package.json",
        status: "discovered",
        discoveredAt: now,
      });
    }
  } catch {}
  return items;
}

async function scanDeadCode(ctx: ScanContext, now: string): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  try {
    // Find exports that might not be imported anywhere
    const exports = await ctx.grepContent("^export (function|const|class|interface|type) (\\w+)", "*.ts");
    const exportLines = exports.split("\n").filter(l => l.trim()).slice(0, 100);

    for (const line of exportLines.slice(0, 10)) {
      const match = line.match(/export (?:function|const|class|interface|type) (\w+)/);
      if (!match) continue;
      const name = match[1]!;

      // Check if it's imported anywhere
      const imports = await ctx.grepContent(name, "*.{ts,tsx}");
      const importCount = imports.split("\n").filter(l => l.trim()).length;

      if (importCount <= 1) { // Only the definition itself
        const file = line.split(":")[0]!;
        items.push({
          id: randomUUID().slice(0, 8),
          type: "dead_code",
          priority: "low",
          title: `Unused export: ${name}`,
          description: `${name} in ${file} may not be used anywhere`,
          file,
          status: "discovered",
          discoveredAt: now,
        });
      }
    }
  } catch {}
  return items;
}
