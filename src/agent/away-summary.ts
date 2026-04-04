/**
 * Away Summary — generate work summaries when user is away.
 *
 * Claude Code pattern (tengu_sedge_lantern): when terminal is unfocused
 * for N minutes, generate a lightweight summary of recent work and
 * push a notification so the user knows what happened.
 */

import type { Message } from "../providers/types.ts";

export interface AwaySummary {
  duration: string;
  toolCalls: number;
  filesModified: string[];
  keyActions: string[];
  status: "working" | "idle" | "blocked" | "complete";
}

/**
 * Generate a summary of recent agent work from message history.
 * Designed to be fast (no LLM call) — just extracts key info from messages.
 */
export function generateAwaySummary(
  messages: Message[],
): AwaySummary {
  const recent = messages.slice(-50);

  const toolCalls = new Set<string>();
  const filesModified = new Set<string>();
  const keyActions: string[] = [];

  for (const msg of recent) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolCalls.add(block.name);

        // Track file modifications
        const input = block.input as Record<string, unknown>;
        if (input.file_path && typeof input.file_path === "string") {
          if (["Write", "Edit", "FileWrite", "FileEdit"].includes(block.name)) {
            filesModified.add(input.file_path);
          }
        }

        // Track key actions
        if (block.name === "Bash" && input.command) {
          const cmd = String(input.command).slice(0, 60);
          if (cmd.includes("git commit")) keyActions.push("Committed changes");
          else if (cmd.includes("bun test") || cmd.includes("npm test")) keyActions.push("Ran tests");
          else if (cmd.includes("git push")) keyActions.push("Pushed to remote");
        }
      }

      if (block.type === "text" && msg.role === "assistant") {
        const text = block.text;
        // Extract key decision points
        if (text.includes("PASS") || text.includes("passed")) {
          keyActions.push("Verification passed");
        }
        if (text.includes("FAIL") || text.includes("failed")) {
          keyActions.push("Something failed — needs attention");
        }
      }
    }
  }

  // Determine status (order matters — more specific overrides less specific)
  let status: AwaySummary["status"] = "working";
  if (toolCalls.size === 0 && keyActions.length === 0) status = "idle";
  if (keyActions.some(a => a.includes("failed"))) status = "blocked";
  if (keyActions.some(a => a.includes("Committed"))) status = "complete";

  return {
    duration: "", // Caller fills this
    toolCalls: toolCalls.size,
    filesModified: Array.from(filesModified),
    keyActions: [...new Set(keyActions)].slice(0, 5),
    status,
  };
}

/**
 * Format an away summary for notification display.
 */
export function formatAwaySummaryForNotification(summary: AwaySummary): string {
  const parts: string[] = [];

  const statusEmoji = {
    working: "🔧",
    idle: "💤",
    blocked: "⚠️",
    complete: "✅",
  }[summary.status];

  parts.push(`${statusEmoji} AshlrCode — ${summary.status}`);

  if (summary.toolCalls > 0) {
    parts.push(`${summary.toolCalls} tool calls`);
  }
  if (summary.filesModified.length > 0) {
    parts.push(`${summary.filesModified.length} files modified`);
  }
  if (summary.keyActions.length > 0) {
    parts.push(summary.keyActions.join(", "));
  }

  return parts.join(" · ");
}

/**
 * Format for display in the terminal (richer than notification).
 */
export function formatAwaySummaryForTerminal(summary: AwaySummary): string {
  const lines: string[] = [];

  lines.push(`  📋 Away Summary (${summary.duration})`);
  lines.push(`  Status: ${summary.status} · ${summary.toolCalls} tool calls`);

  if (summary.filesModified.length > 0) {
    lines.push(`  Files modified:`);
    for (const f of summary.filesModified.slice(0, 5)) {
      lines.push(`    • ${f}`);
    }
    if (summary.filesModified.length > 5) {
      lines.push(`    ... and ${summary.filesModified.length - 5} more`);
    }
  }

  if (summary.keyActions.length > 0) {
    lines.push(`  Key actions:`);
    for (const a of summary.keyActions) {
      lines.push(`    • ${a}`);
    }
  }

  return lines.join("\n");
}
