/**
 * ProductAgent — autonomous product-building mode.
 *
 * A strategic agent that has a high-level product goal and works
 * fully autonomously toward it. Combines:
 *   - Autopilot scanning (find what's broken/missing/weak)
 *   - Strategic prioritization (rank by user impact)
 *   - Coordinator dispatch (parallel sub-agents for execution)
 *   - Verification (validate every change)
 *   - KAIROS heartbeat (keep working when user is away)
 *
 * Activate with: /ship <product-goal>
 *
 * Unlike KAIROS (which does tasks you give it), ProductAgent FINDS
 * its own work by analyzing the product against the goal.
 */

import { runSubAgent } from "./sub-agent.ts";
import { coordinate, type CoordinatorConfig } from "./coordinator.ts";
import { runVerification, clearModifiedFiles } from "./verification.ts";
import { detectTerminalFocus, type FocusState } from "./kairos.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { Message } from "../providers/types.ts";

export interface ProductAgentConfig {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  /** The product goal — what "done" looks like */
  goal: string;
  /** Max work items to execute per session. Default: 20 */
  maxItems?: number;
  /** Pause between work items (ms). Default: 5000 */
  pauseBetweenMs?: number;
  /** Auto-commit after each verified change. Default: false */
  autoCommit?: boolean;
  /** Callbacks */
  onOutput?: (text: string) => void;
  onPhaseChange?: (phase: ProductPhase) => void;
}

export type ProductPhase =
  | "scanning"
  | "prioritizing"
  | "executing"
  | "verifying"
  | "committing"
  | "paused"
  | "complete";

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  category: "bug" | "feature" | "quality" | "test" | "docs" | "security" | "performance";
  priority: "critical" | "high" | "medium" | "low";
  estimatedComplexity: "small" | "medium" | "large";
  files?: string[];
}

export interface ProductAgentResult {
  goal: string;
  itemsCompleted: number;
  itemsFailed: number;
  itemsSkipped: number;
  totalItems: number;
  phases: Array<{
    item: WorkItem;
    status: "completed" | "failed" | "skipped";
    verificationPassed?: boolean;
    committed?: boolean;
  }>;
  stoppedReason: "complete" | "max_items" | "budget" | "user_stop" | "error";
}

/**
 * The strategic scanning prompt that analyzes the product against the goal.
 */
function buildScanPrompt(goal: string): string {
  return `You are a product analyst. Analyze this codebase against the following product goal and identify what's missing, broken, or weak.

## Product Goal
${goal}

## Your Task (READ-ONLY — use only Read, Glob, Grep tools)
1. Read the project's CLAUDE.md or README to understand what exists
2. Use Glob to scan key directories (src/, prompts/, package.json)
3. Use Grep to search for TODOs, FIXMEs, incomplete implementations
4. Read key files to check for missing error handling at system boundaries
5. Identify features a paying user would expect but are missing
6. Use Grep to search for security patterns (hardcoded keys, unsanitized input)

IMPORTANT: You only have read-only tools (Read, Glob, Grep). Do NOT attempt to run commands, tests, or scripts.

## Output Format
Return a JSON array of work items, prioritized by user impact. Start your response with \`[\` and end with \`]\`. No explanation before or after.

Each item:
[
  {
    "title": "Short title",
    "description": "What needs to be done and why it matters for users",
    "category": "bug|feature|quality|test|docs|security|performance",
    "priority": "critical|high|medium|low",
    "estimatedComplexity": "small|medium|large",
    "files": ["src/path/to/file.ts"]
  }
]

Prioritization rules:
- **critical**: Broken functionality, security holes, data loss risks
- **high**: Missing features paying users expect, poor error messages
- **medium**: Quality improvements, test coverage, documentation
- **low**: Nice-to-haves, cosmetic issues, minor optimizations

Maximum 15 items. Focus on what matters most.`;
}

/**
 * Parse the scan output into structured work items.
 * Returns empty array with diagnostic info on failure.
 */
function parseScanOutput(text: string, onOutput?: (text: string) => void): WorkItem[] {
  try {
    // Find the JSON array in the output (agent may include explanation text)
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      onOutput?.(`  ⚠ Scan returned no JSON array. Raw output (first 500 chars):\n  ${text.slice(0, 500)}\n`);
      return [];
    }
    const items = JSON.parse(jsonMatch[0]) as Omit<WorkItem, "id">[];
    if (!Array.isArray(items) || items.length === 0) {
      onOutput?.("  ⚠ Scan returned empty array\n");
      return [];
    }
    return items.map((item, i) => ({
      ...item,
      id: `work-${Date.now()}-${i}`,
    }));
  } catch (err) {
    onOutput?.(`  ⚠ Failed to parse scan output: ${err instanceof Error ? err.message : String(err)}\n  Raw (first 500 chars): ${text.slice(0, 500)}\n`);
    return [];
  }
}

/**
 * The ProductAgent — runs autonomously toward a product goal.
 */
export class ProductAgent {
  private running = false;
  private config: ProductAgentConfig;
  private focusTimer: ReturnType<typeof setInterval> | null = null;
  private _focusState: FocusState = "unknown";
  private _result: ProductAgentResult;

  constructor(config: ProductAgentConfig) {
    this.config = config;
    this._result = {
      goal: config.goal,
      itemsCompleted: 0,
      itemsFailed: 0,
      itemsSkipped: 0,
      totalItems: 0,
      phases: [],
      stoppedReason: "complete",
    };
  }

  async start(): Promise<ProductAgentResult> {
    if (this.running) return this._result;
    this.running = true;

    const out = this.config.onOutput ?? (() => {});
    const maxItems = this.config.maxItems ?? 20;

    out("\n  🚀 ProductAgent starting\n");
    out(`  Goal: ${this.config.goal}\n\n`);

    // Start focus polling
    this.focusTimer = setInterval(async () => {
      this._focusState = await detectTerminalFocus();
    }, 10_000);

    try {
      // Phase 1: Scan
      this.config.onPhaseChange?.("scanning");
      out("  📡 Phase 1: Scanning codebase against goal...\n");
      const workItems = await this.scan();

      if (workItems.length === 0) {
        out("  ✅ No work items found — product looks good!\n");
        this._result.stoppedReason = "complete";
        return this._result;
      }

      this._result.totalItems = workItems.length;
      out(`  Found ${workItems.length} work items\n\n`);

      // Phase 2: Prioritize
      this.config.onPhaseChange?.("prioritizing");
      out("  📋 Phase 2: Prioritizing by user impact...\n");
      const prioritized = this.prioritize(workItems);
      this.displayWorkItems(prioritized.slice(0, 10), out);
      out("\n");

      // Phase 3: Execute each item
      let completed = 0;
      for (const item of prioritized) {
        if (!this.running) {
          this._result.stoppedReason = "user_stop";
          break;
        }
        if (completed >= maxItems) {
          this._result.stoppedReason = "max_items";
          break;
        }

        // Check budget
        if (this.config.router.costTracker.isBudgetExceeded()) {
          out("  💰 Budget exceeded — stopping\n");
          this._result.stoppedReason = "budget";
          break;
        }

        // Skip large items if terminal is unfocused (safer)
        if (item.estimatedComplexity === "large" && this._focusState === "unfocused") {
          out(`  ⏭ Skipping (complex + user away): ${item.title}\n`);
          this._result.itemsSkipped++;
          this._result.phases.push({ item, status: "skipped" });
          continue;
        }

        out(`\n  ▶ [${completed + 1}/${Math.min(prioritized.length, maxItems)}] ${item.title}\n`);
        out(`    ${item.category} · ${item.priority} · ${item.estimatedComplexity}\n`);

        const success = await this.executeItem(item, out);
        completed++;

        if (success) {
          this._result.itemsCompleted++;
        } else {
          this._result.itemsFailed++;
        }

        // Pause between items
        if (this.config.pauseBetweenMs && this.running) {
          await new Promise(r => setTimeout(r, this.config.pauseBetweenMs));
        }
      }

      // Summary
      if (this._result.stoppedReason === "complete" || completed >= prioritized.length) {
        this._result.stoppedReason = "complete";
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`  ❌ ProductAgent error: ${msg}\n`);
      this._result.stoppedReason = "error";
    } finally {
      this.stop();
    }

    return this._result;
  }

  stop(): void {
    this.running = false;
    if (this.focusTimer) {
      clearInterval(this.focusTimer);
      this.focusTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Phase 1: Scan the codebase for work items */
  private async scan(): Promise<WorkItem[]> {
    const scanResult = await runSubAgent({
      name: "product-scanner",
      prompt: buildScanPrompt(this.config.goal),
      systemPrompt: this.config.systemPrompt,
      router: this.config.router,
      toolRegistry: this.config.toolRegistry,
      toolContext: this.config.toolContext,
      readOnly: true,
      maxIterations: 15,
    });

    return parseScanOutput(scanResult.text, this.config.onOutput);
  }

  /** Phase 2: Sort by priority and impact */
  private prioritize(items: WorkItem[]): WorkItem[] {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const complexityOrder = { small: 0, medium: 1, large: 2 };

    return [...items].sort((a, b) => {
      // First by priority
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      // Then prefer smaller items (faster wins)
      return complexityOrder[a.estimatedComplexity] - complexityOrder[b.estimatedComplexity];
    });
  }

  /** Phase 3: Execute a single work item */
  private async executeItem(
    item: WorkItem,
    out: (text: string) => void,
  ): Promise<boolean> {
    this.config.onPhaseChange?.("executing");
    clearModifiedFiles();

    try {
      // Use coordinator for medium/large items, direct sub-agent for small
      if (item.estimatedComplexity === "small") {
        await this.executeDirectly(item, out);
      } else {
        await this.executeWithCoordinator(item, out);
      }

      // Verify
      this.config.onPhaseChange?.("verifying");
      out("    🔍 Verifying...\n");
      const vResult = await runVerification({
        router: this.config.router,
        toolRegistry: this.config.toolRegistry,
        toolContext: this.config.toolContext,
        systemPrompt: this.config.systemPrompt,
      }, { intent: item.description });

      const passed = vResult.passed;
      out(passed ? "    ✓ Verification passed\n" : "    ✗ Verification failed\n");

      // Auto-commit if configured and verified
      if (passed && this.config.autoCommit) {
        this.config.onPhaseChange?.("committing");
        out("    📝 Committing...\n");
        await this.autoCommit(item);
      }

      this._result.phases.push({
        item,
        status: passed ? "completed" : "failed",
        verificationPassed: passed,
        committed: passed && this.config.autoCommit,
      });

      return passed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`    ❌ Error: ${msg}\n`);
      this._result.phases.push({ item, status: "failed" });
      return false;
    }
  }

  /** Execute a small item directly via sub-agent */
  private async executeDirectly(
    item: WorkItem,
    out: (text: string) => void,
  ): Promise<void> {
    await runSubAgent({
      name: `fix-${item.id}`,
      prompt: `${item.description}\n\nFiles to focus on: ${(item.files ?? []).join(", ") || "determine from context"}`,
      systemPrompt: this.config.systemPrompt,
      router: this.config.router,
      toolRegistry: this.config.toolRegistry,
      toolContext: this.config.toolContext,
      maxIterations: 15,
      onText: (text) => out(`    ${text}`),
    });
  }

  /** Execute a medium/large item via coordinator */
  private async executeWithCoordinator(
    item: WorkItem,
    out: (text: string) => void,
  ): Promise<void> {
    await coordinate(item.description, {
      router: this.config.router,
      toolRegistry: this.config.toolRegistry,
      toolContext: this.config.toolContext,
      systemPrompt: this.config.systemPrompt,
      autoVerify: false, // We verify separately
      onProgress: (event) => {
        switch (event.type) {
          case "dispatching":
            out(`    🚀 Agent ${event.agentName} [${event.taskIndex + 1}/${event.totalTasks}]\n`);
            break;
          case "agent_complete":
            out(event.success ? `    ✓ ${event.agentName}\n` : `    ✗ ${event.agentName}\n`);
            break;
        }
      },
    });
  }

  /** Auto-commit after verified change */
  private async autoCommit(item: WorkItem): Promise<void> {
    const cwd = this.config.toolContext.cwd;

    // Stage all changes (separate spawn to avoid shell injection)
    const addProc = Bun.spawn(["git", "add", "-A"], { cwd, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;

    // Commit with message passed as argument (no shell interpolation)
    const message = `fix: ${item.title}\n\nProductAgent: ${item.category} (${item.priority})\n\nCo-Authored-By: AshlrCode <noreply@ashlr.ai>`;
    const commitProc = Bun.spawn(
      ["git", "commit", "-m", message],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    await commitProc.exited;
  }

  /** Display work items in a nice format */
  private displayWorkItems(
    items: WorkItem[],
    out: (text: string) => void,
  ): void {
    for (const item of items) {
      const icon = item.priority === "critical" ? "🔴"
        : item.priority === "high" ? "🟠"
        : item.priority === "medium" ? "🟡"
        : "🟢";
      out(`    ${icon} [${item.estimatedComplexity}] ${item.title}\n`);
    }
  }
}

/**
 * Format ProductAgent results for display.
 */
export function formatProductReport(result: ProductAgentResult): string {
  const lines: string[] = [];

  lines.push("## 🚀 ProductAgent Report");
  lines.push("");
  lines.push(`**Goal:** ${result.goal}`);
  lines.push(`**Result:** ${result.itemsCompleted} completed, ${result.itemsFailed} failed, ${result.itemsSkipped} skipped (of ${result.totalItems} total)`);
  lines.push(`**Stopped:** ${result.stoppedReason}`);
  lines.push("");

  if (result.phases.length > 0) {
    lines.push("### Work Items");
    for (const phase of result.phases) {
      const icon = phase.status === "completed" ? "✓" : phase.status === "failed" ? "✗" : "⏭";
      const verify = phase.verificationPassed !== undefined
        ? (phase.verificationPassed ? " (verified)" : " (verification failed)")
        : "";
      const commit = phase.committed ? " [committed]" : "";
      lines.push(`- ${icon} **${phase.item.title}** — ${phase.item.category}/${phase.item.priority}${verify}${commit}`);
    }
  }

  return lines.join("\n");
}
