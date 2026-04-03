/**
 * Message rendering — format tool output with grouping and progress.
 */

import { theme } from "./theme.ts";

/** Format a tool execution for display with icon and timing */
export function formatToolExecution(name: string, input: Record<string, unknown>, result: string, isError: boolean, durationMs?: number): string[] {
  const lines: string[] = [];
  const icon = isError ? theme.error("✗") : theme.success("✓");
  const timing = durationMs ? theme.muted(` (${formatDuration(durationMs)})`) : "";

  // Tool header
  lines.push(`  ${theme.toolIcon("◆")} ${theme.toolName(name)}${timing}`);

  // Input preview (context-aware)
  const preview = getInputPreview(name, input);
  if (preview) lines.push(theme.tertiary(`    ${preview}`));

  // Result preview (first line, truncated)
  const resultPreview = result.split("\n")[0]?.slice(0, 100) ?? "";
  const extra = result.split("\n").length > 1 ? theme.muted(` (+${result.split("\n").length - 1} lines)`) : "";
  lines.push(`  ${icon} ${theme.toolResult(resultPreview)}${extra}`);

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

/** Get a smart input preview for a tool */
function getInputPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return `$ ${String(input.command ?? "").slice(0, 80)}`;
    case "Read": return String(input.file_path ?? "");
    case "Write": return `-> ${String(input.file_path ?? "")}`;
    case "Edit": return `~ ${String(input.file_path ?? "")}`;
    case "Glob": return `pattern: ${String(input.pattern ?? "")}`;
    case "Grep": return `/${String(input.pattern ?? "")}/`;
    case "WebFetch": return String(input.url ?? "").slice(0, 60);
    case "Agent": return `agent: ${String(input.description ?? "")}`;
    case "LSP": return `${input.action} ${String(input.file ?? "")}:${input.line}`;
    default: {
      const first = Object.entries(input)[0];
      return first ? `${first[0]}: ${String(first[1]).slice(0, 60)}` : "";
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Format a turn separator with stats */
export function formatTurnSeparator(turnNumber: number, cost: number, buddyName: string, toolCount: number): string {
  const parts = [`turn ${turnNumber}`, `$${cost.toFixed(4)}`];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  parts.push(buddyName);
  return theme.muted(`\n  ── ${parts.join(" · ")} ──\n`);
}
