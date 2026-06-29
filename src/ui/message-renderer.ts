/**
 * Message rendering — format tool output with bordered blocks and syntax highlighting.
 */

import chalk from "chalk";
import { highlightCode } from "./markdown.ts";
import { stylePath, theme } from "./theme.ts";
import type { ToolResultChunk } from "../agent/tool-result-streaming.ts";

const MAX_BODY_LINES = 20;
const BOX_WIDTH = 60;

// ── Borders ────────────────────────────────────────────────────────────────

function wrapWithBorder(bodyLines: string[], header?: string, footer?: string): string[] {
  const lines: string[] = [];

  // Top border: ┌─ Header ─────────────────────────────┐
  if (header) {
    const label = ` ${header} `;
    const prefixWidth = 4; // "  ┌─"
    const remaining = Math.max(0, BOX_WIDTH - prefixWidth - label.length - 1); // -1 for ┐
    lines.push(theme.border("  ┌─") + theme.borderBright(label) + theme.border("─".repeat(remaining) + "┐"));
  }

  for (const line of bodyLines) {
    lines.push(theme.border("  │") + `  ${line}`);
  }

  // Bottom border: └────────────────────────────────────┘
  const footerSuffix = footer ? `  ${theme.muted(footer)}` : "";
  lines.push(theme.border("  └" + "─".repeat(Math.max(0, BOX_WIDTH - 2)) + "┘") + footerSuffix);
  return lines;
}

function truncateLines(allLines: string[], max: number = MAX_BODY_LINES): string[] {
  if (allLines.length <= max) return allLines;
  const tail = Math.max(1, Math.floor((max - 1) / 4));
  const head = max - 1 - tail;
  const omitted = allLines.length - head - tail;
  return [...allLines.slice(0, head), theme.muted(`  ... ${omitted} more lines ...`), ...allLines.slice(-tail)];
}

// ── File extension → language ──────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "json",
  yml: "json",
  toml: "json",
  md: "",
  txt: "",
  css: "",
  html: "",
  sql: "",
};

function extToLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "";
}

// ── Compact input for header ───────────────────────────────────────────────

function getCompactInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "")
        .split("\n")[0]!
        .slice(0, 60);
    case "Read":
    case "Write":
    case "Edit":
      return shortenPath(String(input.file_path ?? ""));
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return `/${String(input.pattern ?? "")}/`;
    case "WebFetch":
      return String(input.url ?? "").slice(0, 50);
    case "WebSearch":
      return String(input.query ?? "").slice(0, 50);
    case "Agent":
      return String(input.description ?? "").slice(0, 50);
    case "LSP":
      return `${input.action ?? ""} ${shortenPath(String(input.file ?? ""))}`;
    case "BulkEdit": {
      const patches = input.patches as Array<{ path: string }> | undefined;
      return patches ? `${patches.length} patch(es)` : "";
    }
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
      body.push(chalk.hex("#FF1744")("- ") + chalk.hex("#FF1744").dim(line.slice(2)));
    } else if (line.startsWith("+ ")) {
      body.push(chalk.hex("#00E676")("+ ") + chalk.hex("#00E676")(line.slice(2)));
    } else if (line.startsWith("  ...")) {
      body.push(theme.muted(line));
    } else {
      body.push(theme.tertiary(line));
    }
  }
  return truncateLines(body);
}

function formatReadBody(result: string, filePath: string): string[] {
  const lang = extToLang(filePath);
  const lines = result.split("\n");
  // Find max line number width for right-alignment
  const maxNumWidth = lines.reduce((max, line) => {
    const tabIdx = line.indexOf("\t");
    if (tabIdx > 0) {
      const num = line.slice(0, tabIdx).trim();
      return Math.max(max, num.length);
    }
    return max;
  }, 3);

  const formatted = lines.map((line) => {
    const tabIdx = line.indexOf("\t");
    if (tabIdx > 0) {
      const num = line.slice(0, tabIdx).trim();
      const content = line.slice(tabIdx + 1);
      const paddedNum = num.padStart(maxNumWidth);
      const highlighted = lang ? highlightCode(content, lang) : content;
      return theme.muted(`${paddedNum} │ `) + highlighted;
    }
    return lang ? highlightCode(line, lang) : line;
  });
  return truncateLines(formatted);
}

function formatBashBody(result: string, isError: boolean): string[] {
  const lines = result.split("\n");
  if (isError) return truncateLines(lines.map((line) => chalk.hex("#FF1744")(line)));
  return truncateLines(lines);
}

function formatGrepBody(result: string): string[] {
  const lines = result.split("\n");
  return truncateLines(
    lines.map((line) => {
      // Highlight file:line: pattern matches
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        return stylePath(line.slice(0, colonIdx)) + line.slice(colonIdx);
      }
      return line;
    }),
    15,
  );
}

function formatBulkEditBody(result: string): string[] {
  const lines = result.split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line.startsWith("✓")) {
      body.push(chalk.hex("#00E676")(line));
    } else if (line.startsWith("✗")) {
      body.push(chalk.hex("#FF1744")(line));
    } else if (line.startsWith("  ↩")) {
      body.push(chalk.hex("#FFA726")(line));
    } else if (line.startsWith(">> Preview of")) {
      body.push(chalk.bold(line));
    } else if (line.startsWith("   - ")) {
      body.push(chalk.hex("#FF1744")(line));
    } else if (line.startsWith("   + ")) {
      body.push(chalk.hex("#00E676")(line));
    } else if (line.startsWith("   @@")) {
      body.push(chalk.cyan(line));
    } else if (line.includes("DRY RUN")) {
      body.push(chalk.bold.yellow(line));
    } else if (line.includes("Rolling back")) {
      body.push(chalk.hex("#FFA726")(line));
    } else if (line.includes("Rollback complete")) {
      body.push(chalk.hex("#FFA726").bold(line));
    } else if (line.includes("file(s) updated")) {
      body.push(chalk.bold(line));
    } else {
      body.push(theme.tertiary(line));
    }
  }
  return truncateLines(body, 40);
}

function formatAgentBody(result: string): string[] {
  const lines = result.split("\n");
  return truncateLines(
    lines.map((line) => {
      // Highlight markdown headers
      if (line.startsWith("## ")) return chalk.bold(line);
      if (line.startsWith("### ")) return chalk.bold.dim(line);
      // Highlight file paths
      if (line.match(/^\s*[-*]\s+`/)) return theme.tertiary(line);
      return line;
    }),
    25,
  );
}

function formatDefaultBody(result: string): string[] {
  return truncateLines(result.split("\n"), 10);
}

/** Collapse repeated tool names: "Read, Read, Grep, Read" → "Read x3, Grep x1" */
function collapseToolNames(toolLine: string): string {
  const prefix = "Tools used: ";
  const idx = toolLine.indexOf(prefix);
  if (idx < 0) return toolLine;
  const names = toolLine.slice(idx + prefix.length).split(",").map((s) => s.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const collapsed = Array.from(counts.entries())
    .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
    .join(", ");
  return toolLine.slice(0, idx) + prefix + collapsed;
}

// ── Main formatter ─────────────────────────────────────────────────────────

/** Format a tool execution for display with bordered block */
export function formatToolExecution(
  name: string,
  input: Record<string, unknown>,
  result: string,
  isError: boolean,
  durationMs?: number,
): string[] {
  const lines: string[] = [];

  // Build header label: "ToolName: compact_input"
  const compactInput = getCompactInput(name, input);
  const headerLabel = compactInput ? `${name}: ${compactInput}` : name;
  const icon = isError ? theme.error("●") : theme.accent("●");
  lines.push(`  ${icon} ${theme.toolName(name)}${compactInput ? theme.muted(` ${compactInput}`) : ""}`);

  // Body — per-tool formatting
  let bodyLines: string[];
  switch (name) {
    case "BulkEdit":
      bodyLines = formatBulkEditBody(result);
      break;
    case "Edit":
    case "Write":
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
    case "Agent": {
      // Collapse "Tools used:" line in agent results
      const agentResult = result.replace(/^Tools used: .+$/m, (match) => collapseToolNames(match));
      bodyLines = formatAgentBody(agentResult);
      break;
    }
    default:
      bodyLines = formatDefaultBody(result);
  }

  // Filter empty trailing lines
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === "") {
    bodyLines.pop();
  }

  // Wrap with border, header, and footer
  const timing = durationMs ? `(${formatDuration(durationMs)})` : "";
  lines.push(...wrapWithBorder(bodyLines, headerLabel, timing));

  return lines;
}

/** Format a group of tool executions (parallel tools) */
export function formatToolGroup(
  tools: Array<{ name: string; result: string; isError: boolean; durationMs?: number }>,
): string[] {
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

// ── Tool result chunk rendering (progressive / lazy-load) ──────────────────

/**
 * Visual separator emitted between streamed tool result chunks.
 *
 * Shows the chunk's compact summary (when available) and a lazy-load
 * indicator when more chunks are expected.
 */
export function formatChunkSeparator(chunk: ToolResultChunk): string {
  const parts: string[] = [];

  if (chunk.summary) {
    parts.push(theme.muted(`  ┄ ${chunk.summary}`));
  }

  if (chunk.pendingMore) {
    parts.push(theme.muted("  ┄ loading…"));
  }

  return parts.join("\n");
}

/**
 * Format a single streamed ToolResultChunk for terminal display.
 *
 * Applies per-outputType styling:
 *   - grep_results  → file path highlight
 *   - bash_error    → red
 *   - diff          → +/- colouring
 *   - json_*        → dim (JSON is verbose; let the summary speak)
 *   - log_lines     → muted timestamp, normal message
 *   - file_contents → dim line numbers (mirrors formatReadBody)
 *   - generic_text  → passthrough
 *
 * The separator is prepended when the chunk is not the first chunk (index > 0).
 */
export function formatToolResultChunk(chunk: ToolResultChunk): string[] {
  const lines: string[] = [];

  // Prepend separator between chunks (not before the first one)
  if (chunk.index > 0) {
    const sep = formatChunkSeparator(chunk);
    if (sep) lines.push(sep);
  }

  const chunkLines = chunk.text.split("\n");

  switch (chunk.outputType) {
    case "bash_error": {
      for (const line of chunkLines) {
        lines.push(chalk.hex("#FF1744")(line));
      }
      break;
    }
    case "grep_results": {
      for (const line of chunkLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          lines.push(stylePath(line.slice(0, colonIdx)) + line.slice(colonIdx));
        } else {
          lines.push(line);
        }
      }
      break;
    }
    case "diff": {
      for (const line of chunkLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          lines.push(chalk.hex("#00E676")(line));
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          lines.push(chalk.hex("#FF1744")(line));
        } else if (line.startsWith("@@")) {
          lines.push(chalk.cyan(line));
        } else if (/^(diff --git|index |--- |\\+\\+\\+ )/.test(line)) {
          lines.push(chalk.bold(line));
        } else {
          lines.push(line);
        }
      }
      break;
    }
    case "json_array":
    case "json_object": {
      // JSON is typically large; show dimmed to reduce visual noise.
      // The summary (shown via separator) carries the meaningful info.
      for (const line of chunkLines) {
        lines.push(theme.muted(line));
      }
      break;
    }
    case "log_lines": {
      for (const line of chunkLines) {
        // Dim the timestamp prefix, keep the rest readable
        const match = line.match(/^(\S+\s+\S+)\s+(.*)/);
        if (match) {
          lines.push(theme.muted(match[1]!) + "  " + match[2]!);
        } else {
          lines.push(line);
        }
      }
      break;
    }
    case "file_contents": {
      for (const line of chunkLines) {
        // Dim line-number prefix (NNN | or NNN\t)
        const match = line.match(/^(\s*\d+\s*[\t|])(.*)/);
        if (match) {
          lines.push(theme.muted(match[1]!) + match[2]!);
        } else {
          lines.push(line);
        }
      }
      break;
    }
    case "file_listing": {
      for (const line of chunkLines) {
        lines.push(stylePath(line));
      }
      break;
    }
    default: {
      for (const line of chunkLines) {
        lines.push(line);
      }
    }
  }

  // Lazy-load indicator at the end of the final chunk's pending section
  if (chunk.isFinal && chunk.index > 0) {
    lines.push(theme.muted(`  ┄ ${chunk.cumulativeBytes.toLocaleString()} bytes total`));
  }

  return lines;
}

/** Format a turn separator with stats */
export function formatTurnSeparator(
  turnNumber: number,
  cost: number,
  buddyName: string,
  toolCount: number,
  speculationStats?: { hits: number; misses: number },
  budgetInfo?: { budgetUSD: number; percentUsed: number },
  options?: { ultrathink?: boolean; durationMs?: number },
): string {
  // Cost display: show budget % if set, otherwise just cost
  let costStr = `$${cost.toFixed(4)}`;
  if (budgetInfo && budgetInfo.budgetUSD !== Infinity) {
    const pct = Math.round(budgetInfo.percentUsed);
    const indicator = pct >= 90 ? "🔴" : pct >= 75 ? "🟡" : "";
    costStr += ` / $${budgetInfo.budgetUSD.toFixed(2)} ${indicator}${pct}%`;
  }

  const parts: string[] = [];
  if (options?.ultrathink) {
    parts.push("ultrathink");
  }
  parts.push(`turn ${turnNumber}`);
  // Show duration if provided
  if (options?.durationMs) {
    parts.push(formatDuration(options.durationMs));
  }
  parts.push(costStr);
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

  if (options?.ultrathink) {
    // Ultrathink turns get a magenta-accented separator
    const inner = parts.join(" · ");
    return "\n" + chalk.magenta("  ══ ") + chalk.bold.magenta(inner) + chalk.magenta(" ══") + "\n";
  }
  return theme.muted(`\n  ── ${parts.join(" · ")} ──\n`);
}
