/**
 * Message rendering — format tool output with bordered blocks and syntax highlighting.
 */

import chalk from "chalk";
import { theme, stylePath } from "./theme.ts";
import { highlightCode } from "./markdown.ts";

const MAX_BODY_LINES = 20;

// ── Borders ────────────────────────────────────────────────────────────────

function wrapWithBorder(bodyLines: string[], footer?: string): string[] {
  const lines: string[] = [];
  for (const line of bodyLines) {
    lines.push(theme.muted("  │") + `  ${line}`);
  }
  const suffix = footer ? `  ${theme.muted(footer)}` : "";
  lines.push(theme.muted("  └") + suffix);
  return lines;
}

function truncateLines(allLines: string[], max: number = MAX_BODY_LINES): string[] {
  if (allLines.length <= max) return allLines;
  const tail = Math.max(1, Math.floor((max - 1) / 4));
  const head = (max - 1) - tail;
  const omitted = allLines.length - head - tail;
  return [...allLines.slice(0, head), theme.muted(`  ... ${omitted} more lines ...`), ...allLines.slice(-tail)];
}

// ── File extension → language ──────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", go: "go", rs: "rust", sh: "bash", bash: "bash", zsh: "bash",
  json: "json", yaml: "json", yml: "json", toml: "json",
  md: "", txt: "", css: "", html: "", sql: "",
};

function extToLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "";
}

// ── Compact input for header ───────────────────────────────────────────────

function getCompactInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return String(input.command ?? "").split("\n")[0]!.slice(0, 60);
    case "Read":
    case "Write":
    case "Edit": return shortenPath(String(input.file_path ?? ""));
    case "Glob": return String(input.pattern ?? "");
    case "Grep": return `/${String(input.pattern ?? "")}/`;
    case "WebFetch": return String(input.url ?? "").slice(0, 50);
    case "WebSearch": return String(input.query ?? "").slice(0, 50);
    case "Agent": return String(input.description ?? "").slice(0, 50);
    case "LSP": return `${input.action ?? ""} ${shortenPath(String(input.file ?? ""))}`;
    default: {
      const first = Object.entries(input)[0];
      return first ? String(first[1]).slice(0, 50) : "";
    }
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

// ── Per-tool formatters ────────────────────────────────────────────────────

function formatEditBody(result: string): string[] {
  const lines = result.split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) {
      body.push(chalk.hex("#FF1744")(line));
    } else if (line.startsWith("+ ")) {
      body.push(chalk.hex("#00E676")(line));
    } else if (line.startsWith("  ...")) {
      body.push(theme.muted(line));
    } else {
      body.push(line);
    }
  }
  return truncateLines(body);
}

function formatReadBody(result: string, filePath: string): string[] {
  const lang = extToLang(filePath);
  const lines = result.split("\n");
  if (!lang) return truncateLines(lines);
  return truncateLines(lines.map(line => {
    // Line-numbered content: "   1\tcontent" — highlight the content part
    const tabIdx = line.indexOf("\t");
    if (tabIdx > 0) {
      const num = line.slice(0, tabIdx);
      const content = line.slice(tabIdx + 1);
      return chalk.hex("#616161")(num + " │ ") + highlightCode(content, lang);
    }
    return highlightCode(line, lang);
  }));
}

function formatBashBody(result: string, isError: boolean): string[] {
  const lines = result.split("\n");
  if (isError) return truncateLines(lines.map(line => chalk.hex("#FF1744")(line)));
  return truncateLines(lines);
}

function formatGrepBody(result: string): string[] {
  const lines = result.split("\n");
  return truncateLines(lines.map(line => {
    // Highlight file:line: pattern matches
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      return stylePath(line.slice(0, colonIdx)) + line.slice(colonIdx);
    }
    return line;
  }), 15);
}

function formatDefaultBody(result: string): string[] {
  return truncateLines(result.split("\n"), 10);
}

// ── Main formatter ─────────────────────────────────────────────────────────

/** Format a tool execution for display with bordered block */
export function formatToolExecution(name: string, input: Record<string, unknown>, result: string, isError: boolean, durationMs?: number): string[] {
  const lines: string[] = [];

  // Header: ● ToolName(compact_input)
  const compactInput = getCompactInput(name, input);
  const inputStr = compactInput ? theme.muted(`(${compactInput})`) : "";
  const icon = isError ? theme.error("●") : theme.accent("●");
  lines.push(`  ${icon} ${theme.toolName(name)}${inputStr}`);

  // Body — per-tool formatting
  let bodyLines: string[];
  switch (name) {
    case "Edit":
      bodyLines = formatEditBody(result);
      break;
    case "Read":
      bodyLines = formatReadBody(result, String(input.file_path ?? ""));
      break;
    case "Bash":
      bodyLines = formatBashBody(result, isError);
      break;
    case "Grep":
      bodyLines = formatGrepBody(result);
      break;
    default:
      bodyLines = formatDefaultBody(result);
  }

  // Filter empty trailing lines
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === "") {
    bodyLines.pop();
  }

  // Wrap with border and footer
  const timing = durationMs ? `(${formatDuration(durationMs)})` : "";
  lines.push(...wrapWithBorder(bodyLines, timing));

  return lines;
}

/** Format a group of tool executions (parallel tools) */
export function formatToolGroup(tools: Array<{ name: string; result: string; isError: boolean; durationMs?: number }>): string[] {
  if (tools.length <= 1) return [];

  const lines: string[] = [];
  lines.push(theme.muted(`  ┌ ${tools.length} tools executed in parallel`));
  for (const t of tools) {
    const icon = t.isError ? theme.error("✗") : theme.success("✓");
    lines.push(`  │ ${icon} ${t.name} ${theme.muted(t.durationMs ? `(${formatDuration(t.durationMs)})` : "")}`);
  }
  lines.push(theme.muted("  └"));
  return lines;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Format a turn separator with stats */
export function formatTurnSeparator(
  turnNumber: number,
  cost: number,
  buddyName: string,
  toolCount: number,
  speculationStats?: { hits: number; misses: number },
  budgetInfo?: { budgetUSD: number; percentUsed: number },
): string {
  // Cost display: show budget % if set, otherwise just cost
  let costStr = `$${cost.toFixed(4)}`;
  if (budgetInfo && budgetInfo.budgetUSD !== Infinity) {
    const pct = Math.round(budgetInfo.percentUsed);
    const indicator = pct >= 90 ? "🔴" : pct >= 75 ? "🟡" : "";
    costStr += ` / $${budgetInfo.budgetUSD.toFixed(2)} ${indicator}${pct}%`;
  }

  const parts = [`turn ${turnNumber}`, costStr];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  // Show speculation cache performance when active
  if (speculationStats) {
    const total = speculationStats.hits + speculationStats.misses;
    if (total > 0) {
      const rate = Math.round((speculationStats.hits / total) * 100);
      parts.push(`⚡${rate}% cache`);
    }
  }
  parts.push(buddyName);
  return theme.muted(`\n  ── ${parts.join(" · ")} ──\n`);
}
