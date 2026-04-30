/**
 * Unified Autopilot Loop — merges KAIROS (heartbeat), ProductAgent (vision-driven
 * execution), Coordinator (multi-agent dispatch), and Autopilot (work queue) into
 * a single system.
 *
 * The loop ticks at a configurable interval and each tick:
 *   1. Drains user messages (stop, wrap-up, focus changes)
 *   2. Checks wrap-up state (run tests, create PR, stop)
 *   3. Periodically re-assesses the vision via LLM
 *   4. Periodically re-scans the codebase for new work
 *   5. Prioritizes queue items by severity and focus area
 *   6. Executes top items via sub-agent or coordinator
 *   7. Verifies changes with verification agent
 *   8. Auto-commits if configured
 *   9. Reports progress and sends notifications when user is away
 *  10. Sleeps until next tick (abortable)
 */

import { WorkQueue } from "../autopilot/queue.ts";
import { scanCodebase } from "../autopilot/scanner.ts";
import type { WorkItem, WorkItemType } from "../autopilot/types.ts";
import { coordinate } from "./coordinator.ts";
import { runSubAgent } from "./sub-agent.ts";
import { runVerification, clearModifiedFiles } from "./verification.ts";
import { detectTerminalFocus, type FocusState } from "./kairos.ts";
import { sleep } from "./error-handler.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { GenomeManifest } from "../genome/manifest.ts";

/* ── Vision interface (inline until vision.ts exists) ──────────── */

interface Vision {
  goal: string;
  successCriteria: string[];
  focusAreas: string[];
  avoidAreas: string[];
  progress: Array<{
    timestamp: string;
    summary: string;
    itemsCompleted: number;
    itemsFailed: number;
  }>;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/* ── Config & events ───────────────────────────────────────────── */

export interface AutopilotConfig {
  router: ProviderRouter;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  systemPrompt: string;
  /** Milliseconds between ticks. Default: 30_000 */
  tickIntervalMs?: number;
  /** Max parallel sub-agents for coordinator dispatch. Default: 3 */
  maxParallel?: number;
  /** Auto-commit after each verified item. Default: true */
  autoCommit?: boolean;
  /** Team ID for coordinator dispatch */
  teamId?: string;
  /** Progress callback */
  onProgress?: (event: AutopilotEvent) => void;
}

export type AutopilotEvent =
  | { type: "started"; goal: string }
  | { type: "tick"; tickNumber: number; phase: string }
  | { type: "scanning"; message: string }
  | { type: "scan_complete"; newItems: number; totalItems: number }
  | { type: "assessing"; message: string }
  | { type: "assessment"; focusAreas: string[]; assessment: string; isComplete: boolean }
  | { type: "executing"; itemDescription: string }
  | { type: "item_complete"; description: string; success: boolean; summary: string }
  | { type: "committing"; message: string }
  | { type: "user_message"; message: string; action: string }
  | { type: "wrapping_up" }
  | {
      type: "stopped";
      summary: string;
      itemsCompleted: number;
      itemsFailed: number;
      duration: string;
    }
  | { type: "notification"; title: string; body: string };

/* ── Helpers ───────────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Send a macOS notification (no-op on other platforms).
 * Mirrors the pattern from kairos.ts but kept local to avoid
 * exporting an internal helper.
 */
async function sendNotification(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const escaped = message.replace(/"/g, '\\"').slice(0, 200);
    const escapedTitle = title.replace(/"/g, '\\"');
    const proc = Bun.spawn(
      [
        "osascript",
        "-e",
        `display notification "${escaped}" with title "${escapedTitle}"`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
  } catch {
    // Notification failure is not critical
  }
}

/**
 * Build a ScanContext adapter so `scanCodebase()` can run shell commands
 * via `Bun.spawn` and grep/glob via the tool registry.
 */
function buildScanContext(cwd: string) {
  return {
    cwd,
    async runCommand(cmd: string): Promise<string> {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    },
    async searchFiles(pattern: string): Promise<string> {
      const proc = Bun.spawn(
        ["bash", "-c", `find . -path './${pattern}' -type f 2>/dev/null | head -200`],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    },
    async grepContent(pattern: string, glob?: string): Promise<string> {
      const globArg = glob ? `--include='${glob}'` : "";
      const proc = Bun.spawn(
        ["bash", "-c", `grep -rn '${pattern}' ${globArg} . 2>/dev/null | head -200`],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    },
  };
}

/* ── AutopilotLoop ─────────────────────────────────────────────── */

export class AutopilotLoop {
  private running = false;
  private tickNumber = 0;
  private startedAt = 0;
  private itemsCompleted = 0;
  private itemsFailed = 0;
  private userMessages: string[] = [];
  private wrapUpRequested = false;
  private abortController = new AbortController();
  private vision!: Vision;
  private queue!: WorkQueue;
  private config!: AutopilotConfig;
  private lastScanHash = "";
  private focusState: FocusState = "unknown";
  private genome: GenomeManifest | null = null;

  /* ── Public API ────────────────────────────────────────────── */

  async start(vision: Vision, config: AutopilotConfig): Promise<void> {
    this.vision = vision;
    this.config = config;
    this.running = true;
    this.startedAt = Date.now();
    this.tickNumber = 0;
    this.itemsCompleted = 0;
    this.itemsFailed = 0;
    this.userMessages = [];
    this.wrapUpRequested = false;
    this.abortController = new AbortController();
    this.queue = new WorkQueue(config.toolContext.cwd);
    await this.queue.load();

    // Load genome if available — enhances agent context and enables auto-evolution
    try {
      const { loadManifest } = await import("../genome/manifest.ts");
      this.genome = await loadManifest(config.toolContext.cwd);
    } catch {
      this.genome = null;
    }

    config.onProgress?.({ type: "started", goal: vision.goal });

    await this.runLoop();
  }

  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  requestWrapUp(): void {
    this.wrapUpRequested = true;
  }

  queueUserMessage(msg: string): void {
    this.userMessages.push(msg);
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): {
    running: boolean;
    tickNumber: number;
    itemsCompleted: number;
    itemsFailed: number;
    queuePending: number;
    duration: string;
    focusState: FocusState;
    wrapUpRequested: boolean;
  } {
    return {
      running: this.running,
      tickNumber: this.tickNumber,
      itemsCompleted: this.itemsCompleted,
      itemsFailed: this.itemsFailed,
      queuePending: this.queue?.getPending().length ?? 0,
      duration: formatDuration(Date.now() - this.startedAt),
      focusState: this.focusState,
      wrapUpRequested: this.wrapUpRequested,
    };
  }

  /* ── Main loop ─────────────────────────────────────────────── */

  private async runLoop(): Promise<void> {
    const tickInterval = this.config.tickIntervalMs ?? 30_000;

    while (this.running) {
      this.tickNumber++;
      this.config.onProgress?.({
        type: "tick",
        tickNumber: this.tickNumber,
        phase: this.wrapUpRequested ? "wrapping_up" : "running",
      });

      // Refresh focus state each tick
      this.focusState = await detectTerminalFocus();

      try {
        // Step 1: Drain user messages
        this.drainUserMessages();

        // Step 2: Handle wrap-up
        if (this.wrapUpRequested) {
          await this.handleWrapUp();
          break;
        }

        // Step 3: Re-assess vision (every 5 ticks) + genome evolution
        if (this.tickNumber % 5 === 0) {
          const complete = await this.assessVision();
          if (complete) {
            // If genome exists, end generation and advance before wrapping up
            if (this.genome) {
              await this.advanceGeneration();
            }
            this.wrapUpRequested = true;
            continue; // Next iteration will handle wrap-up
          }

          // Evaluate genome fitness periodically (every 10 ticks)
          if (this.genome && this.tickNumber % 10 === 0) {
            await this.evaluateGenomeFitness();
          }
        }

        // Step 4: Scan for new work (every 3 ticks)
        if (this.tickNumber % 3 === 0) {
          await this.scan();
        }

        // Step 5: Prioritize and pick top item
        const item = this.pickNextItem();
        if (!item) {
          // Nothing to do — sleep and retry
          await this.abortableSleep(tickInterval);
          continue;
        }

        // Step 6: Execute
        clearModifiedFiles();
        const success = await this.executeItem(item);

        // Step 7: Verify (only if item execution succeeded)
        let verified = true;
        if (success) {
          verified = await this.verifyItem(item);
        }

        // Step 8: Commit
        if (success && verified && (this.config.autoCommit ?? true)) {
          await this.commitItem(item);
        }

        // Update item status in queue
        if (success && verified) {
          this.queue.completeItem(item.id);
          this.itemsCompleted++;
        } else {
          this.queue.failItem(
            item.id,
            success ? "Verification failed" : "Execution failed",
          );
          this.itemsFailed++;
        }
        await this.queue.save();

        // Step 9: Report progress
        await this.reportProgress();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Don't crash the loop on individual tick errors
        this.config.onProgress?.({
          type: "notification",
          title: "Autopilot Error",
          body: msg.slice(0, 200),
        });
        if (this.focusState === "unfocused") {
          await sendNotification("AshlrCode — Autopilot Error", msg.slice(0, 100));
        }
      }

      // Step 10: Sleep
      await this.abortableSleep(tickInterval);
    }

    // Emit final stopped event
    const summary = `Completed ${this.itemsCompleted} items, ${this.itemsFailed} failed over ${formatDuration(Date.now() - this.startedAt)}`;
    this.config.onProgress?.({
      type: "stopped",
      summary,
      itemsCompleted: this.itemsCompleted,
      itemsFailed: this.itemsFailed,
      duration: formatDuration(Date.now() - this.startedAt),
    });
    this.running = false;
  }

  /* ── Step 1: User messages ─────────────────────────────────── */

  private drainUserMessages(): void {
    const messages = this.userMessages.splice(0);

    for (const msg of messages) {
      const lower = msg.toLowerCase().trim();

      if (lower.includes("stop")) {
        this.config.onProgress?.({
          type: "user_message",
          message: msg,
          action: "stopping",
        });
        this.stop();
        return;
      }

      if (lower.includes("wrap") || lower.includes("pr")) {
        this.config.onProgress?.({
          type: "user_message",
          message: msg,
          action: "wrapping_up",
        });
        this.requestWrapUp();
        continue;
      }

      const focusMatch = lower.match(/focus on (.+)/);
      if (focusMatch) {
        const topic = focusMatch[1]!.trim();
        this.vision.focusAreas = [topic, ...this.vision.focusAreas].slice(0, 5);
        this.config.onProgress?.({
          type: "user_message",
          message: msg,
          action: `focus updated: ${topic}`,
        });
        continue;
      }

      // Generic message — stored as context (already consumed from array)
      this.config.onProgress?.({
        type: "user_message",
        message: msg,
        action: "noted",
      });
    }
  }

  /* ── Step 2: Wrap-up ───────────────────────────────────────── */

  private async handleWrapUp(): Promise<void> {
    this.config.onProgress?.({ type: "wrapping_up" });
    const cwd = this.config.toolContext.cwd;

    // Run tests
    try {
      const testProc = Bun.spawn(["bun", "test"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      await testProc.exited;
    } catch {
      // Test failure does not prevent wrap-up
    }

    // Try creating a PR if gh is available
    try {
      const ghCheck = Bun.spawn(["which", "gh"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const ghPath = (await new Response(ghCheck.stdout).text()).trim();
      await ghCheck.exited;

      if (ghPath) {
        const summary = `Autopilot: ${this.itemsCompleted} items completed, ${this.itemsFailed} failed`;
        const prProc = Bun.spawn(
          [
            "gh",
            "pr",
            "create",
            "--title",
            `[autopilot] ${this.vision.goal.slice(0, 60)}`,
            "--body",
            `## Autopilot Summary\n\n${summary}\n\nGoal: ${this.vision.goal}`,
          ],
          { cwd, stdout: "pipe", stderr: "pipe" },
        );
        await prProc.exited;
      }
    } catch {
      // gh not available or PR creation failed — not critical
    }

    this.running = false;
  }

  /* ── Step 3: Vision assessment ─────────────────────────────── */

  private async assessVision(): Promise<boolean> {
    this.config.onProgress?.({
      type: "assessing",
      message: "Re-assessing vision progress...",
    });

    const recentProgress = this.vision.progress.slice(-5);
    const progressText =
      recentProgress.length > 0
        ? recentProgress
            .map(
              (p) =>
                `[${p.timestamp}] ${p.summary} (${p.itemsCompleted} done, ${p.itemsFailed} failed)`,
            )
            .join("\n")
        : "No progress entries yet.";

    const prompt = `Given this vision: ${this.vision.goal}
Progress so far:
${progressText}
Focus areas: ${this.vision.focusAreas.join(", ") || "none set"}

How close are we? What should we focus on next?
Reply with JSON only: {"focusAreas": ["..."], "assessment": "...", "isComplete": boolean}`;

    let responseText = "";
    try {
      const stream = this.config.router.stream({
        systemPrompt:
          "You are a progress assessor. Evaluate project progress and return structured JSON.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
      });

      for await (const event of stream) {
        if (event.type === "text_delta" && event.text) {
          responseText += event.text;
        }
      }
    } catch {
      // Assessment failure is not critical — continue with current focus
      return false;
    }

    // Parse assessment JSON
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const assessment = JSON.parse(jsonMatch[0]) as {
          focusAreas: string[];
          assessment: string;
          isComplete: boolean;
        };

        if (
          Array.isArray(assessment.focusAreas) &&
          assessment.focusAreas.length > 0
        ) {
          this.vision.focusAreas = assessment.focusAreas;
        }

        this.config.onProgress?.({
          type: "assessment",
          focusAreas: this.vision.focusAreas,
          assessment: assessment.assessment ?? "",
          isComplete: assessment.isComplete ?? false,
        });

        return assessment.isComplete === true;
      }
    } catch {
      // Parse failure — continue
    }

    return false;
  }

  /* ── Step 4: Scan ──────────────────────────────────────────── */

  private async scan(): Promise<void> {
    const cwd = this.config.toolContext.cwd;

    // Check if files changed since last scan via git
    let currentHash = "";
    try {
      const proc = Bun.spawn(["git", "diff", "--stat", "HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      currentHash = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
    } catch {
      // git not available — always scan
      currentHash = String(Date.now());
    }

    if (currentHash === this.lastScanHash && this.lastScanHash !== "") {
      // No changes since last scan — skip
      return;
    }
    this.lastScanHash = currentHash;

    this.config.onProgress?.({
      type: "scanning",
      message: "Scanning codebase for work items...",
    });

    const scanTypes: WorkItemType[] = [
      "todo",
      "missing_test",
      "type_error",
      "security",
    ];

    try {
      const ctx = buildScanContext(cwd);
      const items = await scanCodebase(ctx, scanTypes);

      // Auto-approve all discovered items for the autopilot loop
      const added = this.queue.addItems(items);
      if (added > 0) {
        this.queue.approveAll();
        await this.queue.save();
      }

      this.config.onProgress?.({
        type: "scan_complete",
        newItems: added,
        totalItems: this.queue.length,
      });
    } catch {
      // Scan failure is not critical — continue with existing queue
    }
  }

  /* ── Step 5: Prioritize ────────────────────────────────────── */

  private pickNextItem(): WorkItem | null {
    const pending = this.queue.getPending();
    if (pending.length === 0) return null;

    // Sort: severity desc, then prefer items matching focusAreas
    const focusAreas = this.vision.focusAreas.map((a) => a.toLowerCase());
    const priorityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    const sorted = [...pending].sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 3;
      const pb = priorityOrder[b.priority] ?? 3;
      if (pa !== pb) return pa - pb;

      // Prefer items matching focus areas
      const aMatch = focusAreas.some(
        (f) =>
          a.title.toLowerCase().includes(f) ||
          a.description.toLowerCase().includes(f) ||
          a.file.toLowerCase().includes(f),
      );
      const bMatch = focusAreas.some(
        (f) =>
          b.title.toLowerCase().includes(f) ||
          b.description.toLowerCase().includes(f) ||
          b.file.toLowerCase().includes(f),
      );
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;

      return 0;
    });

    const item = sorted[0]!;

    // Mark as in-progress (approve first if discovered)
    if (item.status === "discovered") {
      this.queue.approve(item.id);
    }
    this.queue.startItem(item.id);

    return item;
  }

  /* ── Step 6: Execute ───────────────────────────────────────── */

  private async executeItem(item: WorkItem): Promise<boolean> {
    this.config.onProgress?.({
      type: "executing",
      itemDescription: item.title,
    });

    // Static-DAG route: artist_build items dispatch the build-artist coordinator
    // config directly. Skip LLM planning; each phase sub-agent runs in dependency
    // order per ashlrcode-config/coordinator/build-artist.json.
    if (item.type === "artist_build") {
      const slug = item.slug;
      if (!slug) {
        this.config.onProgress?.({
          type: "item_complete",
          description: item.title,
          success: false,
          summary: "artist_build item missing required slug field",
        });
        return false;
      }
      try {
        const { loadCoordinatorConfig } = await import("./coordinator-config.ts");
        const { coordinateWithTasks } = await import("./coordinator.ts");
        const { config: cfg, tasks } = await loadCoordinatorConfig("build-artist", { slug });
        const result = await coordinateWithTasks(tasks, `build-artist: ${slug}`, {
          router: this.config.router,
          toolRegistry: this.config.toolRegistry,
          toolContext: this.config.toolContext,
          systemPrompt: this.config.systemPrompt,
          teamId: this.config.teamId,
          maxParallel: cfg.maxParallel ?? this.config.maxParallel ?? 3,
          autoVerify: false,
        });
        const success =
          result.tasks.length > 0 && result.tasks.every((t) => t.success);
        this.config.onProgress?.({
          type: "item_complete",
          description: item.title,
          success,
          summary: result.summary,
        });
        return success;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.config.onProgress?.({
          type: "item_complete",
          description: item.title,
          success: false,
          summary: `artist_build error: ${msg.slice(0, 200)}`,
        });
        return false;
      }
    }

    // Build context with genome sections if available
    let genomeContext = "";
    if (this.genome) {
      try {
        const { retrieveSections, formatGenomeForPrompt } = await import("../genome/retriever.ts");
        const sections = await retrieveSections(
          this.config.toolContext.cwd,
          `${item.title} ${item.description}`,
          4000,
        );
        genomeContext = formatGenomeForPrompt(sections);
      } catch {
        // Genome retrieval failed — continue without
      }
    }

    const contextPrompt = [
      `## Vision`,
      `Goal: ${this.vision.goal}`,
      `Focus areas: ${this.vision.focusAreas.join(", ") || "none"}`,
      genomeContext ? `\n${genomeContext}` : "",
      ``,
      `## Task`,
      `${item.title}: ${item.description}`,
      item.file ? `File: ${item.file}${item.line ? `:${item.line}` : ""}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      // Determine complexity: use coordinator for items touching 3+ files
      const fileCount = item.file
        ? 1
        : 0;
      const isComplex =
        item.type === "security" ||
        item.type === "missing_test" ||
        fileCount >= 3;

      if (isComplex) {
        // Use coordinator for complex items
        const result = await coordinate(contextPrompt, {
          router: this.config.router,
          toolRegistry: this.config.toolRegistry,
          toolContext: this.config.toolContext,
          systemPrompt: this.config.systemPrompt,
          teamId: this.config.teamId,
          maxParallel: this.config.maxParallel ?? 3,
          autoVerify: false, // We verify separately in step 7
        });

        const success =
          result.tasks.filter((t) => t.success).length > 0 ||
          result.tasks.length === 0;

        this.config.onProgress?.({
          type: "item_complete",
          description: item.title,
          success,
          summary: result.summary,
        });

        return success;
      } else {
        // Simple item: run sub-agent directly
        const result = await runSubAgent({
          name: `autopilot-${item.id}`,
          prompt: contextPrompt,
          systemPrompt: this.config.systemPrompt,
          router: this.config.router,
          toolRegistry: this.config.toolRegistry,
          toolContext: this.config.toolContext,
          maxIterations: 15,
        });

        const success =
          !result.text.startsWith("[AGENT ERROR:") && result.text.trim().length > 0;

        this.config.onProgress?.({
          type: "item_complete",
          description: item.title,
          success,
          summary: result.text.slice(0, 200),
        });

        return success;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.config.onProgress?.({
        type: "item_complete",
        description: item.title,
        success: false,
        summary: `Error: ${msg.slice(0, 200)}`,
      });
      return false;
    }
  }

  /* ── Step 7: Verify ────────────────────────────────────────── */

  private async verifyItem(item: WorkItem): Promise<boolean> {
    try {
      const vResult = await runVerification(
        {
          router: this.config.router,
          toolRegistry: this.config.toolRegistry,
          toolContext: this.config.toolContext,
          systemPrompt: this.config.systemPrompt,
        },
        { intent: item.description },
      );
      return vResult.passed;
    } catch {
      // Verification failure defaults to passing (don't block on verification errors)
      return true;
    }
  }

  /* ── Step 8: Commit ────────────────────────────────────────── */

  private async commitItem(item: WorkItem): Promise<void> {
    const cwd = this.config.toolContext.cwd;

    this.config.onProgress?.({
      type: "committing",
      message: `Committing: ${item.title}`,
    });

    try {
      // Stage all changes
      const addProc = Bun.spawn(["git", "add", "-A"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      await addProc.exited;

      // Commit
      const message = `[autopilot] ${item.title}\n\n${item.type}: ${item.description.slice(0, 200)}\n\nCo-Authored-By: AshlrCode <noreply@ashlr.ai>`;
      const commitProc = Bun.spawn(["git", "commit", "-m", message], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      await commitProc.exited;
    } catch {
      // Commit failure is not critical
    }
  }

  /* ── Step 9: Report progress ───────────────────────────────── */

  private async reportProgress(): Promise<void> {
    // Save vision progress entry every 5 completed items
    const totalProcessed = this.itemsCompleted + this.itemsFailed;
    if (totalProcessed > 0 && totalProcessed % 5 === 0) {
      this.vision.progress.push({
        timestamp: new Date().toISOString(),
        summary: `Tick ${this.tickNumber}: processed ${totalProcessed} items`,
        itemsCompleted: this.itemsCompleted,
        itemsFailed: this.itemsFailed,
      });
      this.vision.updatedAt = new Date().toISOString();

      // Cap progress entries
      if (this.vision.progress.length > 50) {
        this.vision.progress = this.vision.progress.slice(-50);
      }

      // Propose genome progress update if genome exists
      if (this.genome) {
        try {
          const { proposeUpdate } = await import("../genome/scribe.ts");
          await proposeUpdate(this.config.toolContext.cwd, {
            agentId: "autopilot",
            section: "knowledge/discoveries.md",
            operation: "append",
            content: `- [${new Date().toISOString().split("T")[0]}] Tick ${this.tickNumber}: ${this.itemsCompleted} completed, ${this.itemsFailed} failed`,
            rationale: "Autopilot progress update",
            generation: this.genome.generation.number,
          });
        } catch {
          // Genome proposal failed — not critical
        }
      }
    }

    // Notify user if terminal unfocused
    if (this.focusState === "unfocused" && totalProcessed > 0 && totalProcessed % 3 === 0) {
      const body = `${this.itemsCompleted} done, ${this.itemsFailed} failed (tick #${this.tickNumber})`;
      this.config.onProgress?.({
        type: "notification",
        title: "Autopilot Progress",
        body,
      });
      await sendNotification("AshlrCode — Autopilot", body);
    }
  }

  /* ── Genome integration ──────────────────────────────────────── */

  /**
   * Evaluate genome fitness and consolidate pending proposals.
   */
  private async evaluateGenomeFitness(): Promise<void> {
    try {
      const { evaluateGeneration, formatGenerationReport } = await import("../genome/generations.ts");
      const { consolidateProposals } = await import("../genome/scribe.ts");
      const cwd = this.config.toolContext.cwd;

      // First consolidate any pending proposals
      await consolidateProposals(cwd, this.config.router);

      // Then evaluate fitness
      const report = await evaluateGeneration(cwd, this.config.router);

      this.config.onProgress?.({
        type: "notification",
        title: "Genome Fitness",
        body: `Gen ${report.generation}: ${(report.fitness.milestoneProgress * 100).toFixed(0)}% milestone, ${report.mutations} mutations`,
      });
    } catch {
      // Genome evaluation failed — not critical
    }
  }

  /**
   * End the current generation and start the next one.
   */
  private async advanceGeneration(): Promise<void> {
    try {
      const { endGeneration, startGeneration } = await import("../genome/generations.ts");
      const { loadManifest } = await import("../genome/manifest.ts");
      const { readSection } = await import("../genome/manifest.ts");
      const cwd = this.config.toolContext.cwd;

      await endGeneration(cwd);

      // Check backlog for next milestone
      const backlog = await readSection(cwd, "milestones/backlog.md");
      const nextMilestone = backlog
        ? extractFirstMilestone(backlog)
        : "Continue development";

      const genNum = await startGeneration(cwd, nextMilestone);
      this.genome = await loadManifest(cwd);

      this.config.onProgress?.({
        type: "notification",
        title: "Generation Advanced",
        body: `Generation ${genNum}: ${nextMilestone}`,
      });
    } catch {
      // Generation advance failed — not critical
    }
  }

  /* ── Step 10: Abortable sleep ──────────────────────────────── */

  private async abortableSleep(ms: number): Promise<void> {
    if (!this.running) return;
    const signal = this.abortController.signal;
    if (signal.aborted) return;

    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
  }
}

/* ── Singleton accessor ────────────────────────────────────────── */

let _instance: AutopilotLoop | null = null;

export function getAutopilotLoop(): AutopilotLoop | null {
  return _instance;
}

export function createAutopilotLoop(): AutopilotLoop {
  _instance = new AutopilotLoop();
  return _instance;
}

/**
 * Extract the first milestone from a backlog markdown file.
 * Looks for the first ## heading or first bullet point.
 */
function extractFirstMilestone(backlog: string): string {
  for (const line of backlog.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) return heading[1]!.trim();
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) return bullet[1]!.trim();
  }
  return "Continue development";
}
