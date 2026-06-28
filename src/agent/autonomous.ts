/**
 * Autonomous Mode — headless non-interactive execution.
 *
 * Scaffolds greenfield projects and builds them via the existing
 * Coordinator, all without human intervention.
 *
 * Usage: ac --autonomous --goal "Build X" [--initial-scaffold] [--max-iterations N] [--timeout S]
 */

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

import { runAgentLoop } from "./loop.ts";
import { coordinate, type CoordinatorConfig } from "./coordinator.ts";
import { AutonomousReporter } from "./autonomous-reporter.ts";
import { buildMinimalCoordinatorContext, type MinimalCoordinatorContext } from "./bootstrap.ts";
import { initPulseHud, getPulseHud } from "../telemetry/pulse-hud.ts";
import { listTimelines, loadTimeline, forkFrom } from "./time-travel.ts";
import { bisectEdits, type Edit } from "./self-bisect.ts";
import {
  detectSurgicalScope,
  checkFileCountGuard,
  revertToPreSurgicalSnapshot,
} from "./surgical-scope.ts";

export interface AutonomousOptions {
  goal: string;
  cwd: string;
  scaffold: boolean;
  maxIterations: number;
  /** Timeout in seconds */
  timeout: number;
  /**
   * Surgical mode — make ONLY the minimal change the goal states.
   * Forbids scaffolding, planning docs, new files (unless the goal explicitly
   * requires a new file), and caps iterations to a low number.
   */
  surgical?: boolean;
  /** Enable Pulse HUD telemetry — emits OTLP spans to the configured endpoint. */
  pulseHud?: boolean;
  /** Enable time-travel recording — appends each tool step to a session timeline. */
  timeTravel?: boolean;
  /**
   * Self-bisect on test failure — when a post-milestone fix-pass still leaves
   * tests red, binary-search the recorded edit sequence to isolate the culprit
   * edit and surface a surgical revert instead of a broad retry.
   */
  selfBisect?: boolean;
}

export interface AutonomousResult {
  success: boolean;
  summary: string;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function isDirectoryEmpty(cwd: string): boolean {
  const hasPkg = existsSync(join(cwd, "package.json"));
  const hasSrc = existsSync(join(cwd, "src"));
  return !hasPkg && !hasSrc;
}

/**
 * Parse BACKLOG.md into milestone entries.
 * Looks for ## headings or numbered list items.
 */
function parseMilestones(backlogContent: string): Array<{ name: string; details: string }> {
  const milestones: Array<{ name: string; details: string }> = [];
  const lines = backlogContent.split("\n");
  let currentName = "";
  let currentDetails: string[] = [];

  for (const line of lines) {
    // ## heading style
    const headingMatch = line.match(/^##\s+(?:\d+[\.\)]\s*)?(.+)/);
    // Numbered list style: 1. Milestone name
    const numberedMatch = !headingMatch ? line.match(/^\d+[\.\)]\s+(.+)/) : null;

    const match = headingMatch ?? numberedMatch;
    if (match) {
      if (currentName) {
        milestones.push({ name: currentName, details: currentDetails.join("\n").trim() });
      }
      currentName = match[1]!.trim();
      currentDetails = [];
    } else if (currentName) {
      currentDetails.push(line);
    }
  }

  if (currentName) {
    milestones.push({ name: currentName, details: currentDetails.join("\n").trim() });
  }

  return milestones;
}

async function gitCommit(cwd: string, message: string): Promise<boolean> {
  try {
    const add = Bun.spawn(["git", "add", "-A"], { cwd, stdout: "pipe", stderr: "pipe" });
    await add.exited;

    // Check if there's anything to commit
    const status = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
    const statusOut = (await new Response(status.stdout).text()).trim();
    await status.exited;
    if (!statusOut) return false; // Nothing to commit

    const commit = Bun.spawn(["git", "commit", "-m", message], { cwd, stdout: "pipe", stderr: "pipe" });
    const code = await commit.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function detectAndRunTests(cwd: string): Promise<{ passed: number; failed: number }> {
  // Try common test runners in order
  const runners = [
    { check: "bun.lockb", cmd: ["bun", "test"] },
    { check: "package.json", cmd: ["npm", "test"] },
  ];

  for (const runner of runners) {
    if (!existsSync(join(cwd, runner.check))) continue;

    // For package.json, verify there's a test script
    if (runner.check === "package.json") {
      try {
        const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
        if (!pkg.scripts?.test || pkg.scripts.test.includes("no test specified")) continue;
      } catch {
        continue;
      }
    }

    try {
      const proc = Bun.spawn(runner.cmd, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CI: "true" },
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const output = stdout + "\n" + stderr;

      // Parse test results from output (best-effort)
      const passMatch = output.match(/(\d+)\s*(?:pass|passed|passing)/i);
      const failMatch = output.match(/(\d+)\s*(?:fail|failed|failing)/i);

      const passed = passMatch ? parseInt(passMatch[1]!, 10) : (exitCode === 0 ? 1 : 0);
      const failed = failMatch ? parseInt(failMatch[1]!, 10) : (exitCode !== 0 ? 1 : 0);

      return { passed, failed };
    } catch {
      // Runner failed to execute
    }
  }

  return { passed: 0, failed: 0 };
}

/* ── Self-bisect helpers ──────────────────────────────────────────── */

/**
 * Snapshot all git-tracked source files in `cwd` into `out`.
 * Uses `git ls-files` so we only track files the repo knows about.
 * Non-git dirs fall back to a no-op (bisect just won't have edits).
 */
async function snapshotTrackedFiles(cwd: string, out: Map<string, string>): Promise<void> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const paths = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    await Promise.all(
      paths.map(async (rel) => {
        const abs = join(cwd, rel);
        try {
          const content = await readFile(abs, "utf-8");
          out.set(abs, content);
        } catch {
          // binary or unreadable — skip
        }
      }),
    );
  } catch {
    // not a git repo or git unavailable — bisect edit log stays empty
  }
}

/**
 * Compare current on-disk content against `snapshots`, add one Edit entry per
 * changed file into `log`. Each file gets a single coarse edit (before=snapshot,
 * after=current) labelled with the milestone name.
 */
async function diffSnapshotsIntoEditLog(
  cwd: string,
  snapshots: Map<string, string>,
  log: Edit[],
  label: string,
): Promise<void> {
  for (const [abs, before] of snapshots) {
    try {
      const after = await readFile(abs, "utf-8");
      if (after !== before) {
        log.push({ filePath: abs, before, after, label });
      }
    } catch {
      // file was deleted — record deletion as edit with empty after
      log.push({ filePath: abs, before, after: "", label: `${label} (deleted)` });
    }
  }
  // Also pick up newly created files (not in snapshot but now on disk).
  try {
    const proc = Bun.spawn(["git", "ls-files", "--others", "--exclude-standard"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const newFiles = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const rel of newFiles) {
      const abs = join(cwd, rel);
      if (!snapshots.has(abs)) {
        try {
          const after = await readFile(abs, "utf-8");
          log.push({ filePath: abs, before: "", after, label: `${label} (new)` });
        } catch {
          // skip unreadable
        }
      }
    }
  } catch {
    // git unavailable — skip new-file detection
  }
}

/* ── Main entry point ─────────────────────────────────────────────── */

/** System-prompt directive injected when --surgical is active. */
const SURGICAL_DIRECTIVE = `
[SURGICAL MODE — CRITICAL CONSTRAINTS]
You are performing a SURGICAL edit. You MUST obey ALL of the following:
1. Make ONLY the exact minimal change that the goal states — nothing more.
2. If the goal says "add a one-line comment", add exactly one line. Do not refactor, rename, or reorganize.
3. Do NOT create any new files unless the goal explicitly says to create a new file. No BACKLOG.md, no README, no scaffolding, no milestone docs.
4. Do NOT run planning phases, create task lists, or write project structure files.
5. Locate the target, apply the smallest possible edit, and stop.
6. If you are unsure which file to edit, read only what is necessary to find it, then edit it.
VIOLATION OF THESE RULES IS A FAILURE. One edit. Stop.
`.trim();

export async function runAutonomous(opts: AutonomousOptions): Promise<AutonomousResult> {
  const reporter = new AutonomousReporter();
  const startTime = Date.now();
  const timeoutMs = opts.timeout * 1000;
  let totalCommits = 0;
  let totalFilesCreated = 0;
  let lastTestResults = { passed: 0, failed: 0 };

  // ── Pulse HUD bootstrap ─────────────────────────────────────────────────
  // Init before any agent work so spans are captured from the first loop iter.
  initPulseHud({
    enabled: opts.pulseHud ?? false,
    endpoint: (opts as any).pulseOtlpUrl ?? process.env.PULSE_OTLP_URL,
    apiKey: (opts as any).pulseOtlpApiKey ?? process.env.PULSE_OTLP_API_KEY,
    sessionId: `auto-${Date.now()}`,
  });

  // ── Edit log for self-bisect ────────────────────────────────────────────
  // Populated by the onToolEnd hook below whenever Write/Edit succeeds.
  const recordedEdits: Edit[] = [];

  reporter.phase("init", `Goal: ${opts.goal}`);
  reporter.phase("init", `Working directory: ${opts.cwd}`);
  if (opts.surgical) {
    reporter.phase("init", "Mode: SURGICAL — minimal change only, scaffolding disabled");
  }

  // Bootstrap the full coordinator context (router, tools, permissions, system prompt)
  let ctx: MinimalCoordinatorContext;
  try {
    ctx = await buildMinimalCoordinatorContext(opts.cwd, { mode: "yolo" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reporter.error(`Failed to initialize: ${msg}`);
    return { success: false, summary: `Init failed: ${msg}` };
  }

  // In surgical mode: skip all phases and run one focused agent loop, then return.
  if (opts.surgical) {
    // ── Intent-aware scope detection ──────────────────────────────────────
    const scope = detectSurgicalScope(opts.goal);
    reporter.phase("surgical", `Scope detected: ${scope.scopeLabel} — file budget: ${scope.fileBudget}`);

    const surgicalSystemPrompt =
      ctx.systemPrompt +
      "\n\n" +
      SURGICAL_DIRECTIVE +
      `\n\nSCOPE BUDGET: This goal is classified as "${scope.scopeTier}" scope. ` +
      `Expected to touch at most ${scope.fileBudget} file(s). ` +
      `Stay within this budget — do not spread changes across unrelated files.`;

    // Cap at 10 iterations — enough for read+edit+verify but blocks multi-milestone sprawl.
    // User can still pass --max-iterations 2 to further restrict.
    const surgicalMaxIterations = Math.min(opts.maxIterations, 10);

    reporter.phase("surgical", `Applying surgical edit (max ${surgicalMaxIterations} iterations, scope: ${scope.scopeTier})...`);

    try {
      const result = await runAgentLoop(opts.goal, [], {
        systemPrompt: surgicalSystemPrompt,
        router: ctx.router,
        toolRegistry: ctx.toolRegistry,
        toolContext: ctx.toolContext,
        maxIterations: surgicalMaxIterations,
      });

      // ── File-count guard ───────────────────────────────────────────────
      // If the run touched more files than the scope budget allows, auto-revert
      // via git stash and report the overshoot instead of committing.
      const guardResult = await checkFileCountGuard(opts.cwd, scope);
      if (!guardResult.withinBudget) {
        reporter.warn(
          `FILE-COUNT GUARD: surgical run touched ${guardResult.filesChanged} file(s) ` +
          `but scope budget is ${guardResult.fileBudget} (${scope.scopeTier}). ` +
          `Auto-reverting via git stash.`,
        );
        const reverted = await revertToPreSurgicalSnapshot(opts.cwd, opts.goal);
        const revertMsg = reverted
          ? "Changes stashed as 'surgical-scope-revert'. Use `git stash pop` to restore if intentional."
          : "Stash failed — working tree may still have changes. Inspect manually.";
        reporter.warn(revertMsg);
        await ctx.cleanup();
        return {
          success: false,
          summary:
            `Surgical overshoot: touched ${guardResult.filesChanged} files, ` +
            `budget was ${guardResult.fileBudget} (${scope.scopeTier} scope). ` +
            revertMsg,
        };
      }

      // Commit only if something actually changed
      const committed = await gitCommit(opts.cwd, `fix: ${opts.goal.slice(0, 72)}`);
      if (committed) {
        reporter.commit(`fix: ${opts.goal.slice(0, 72)}`);
        totalCommits++;
      }

      reporter.summary({
        filesCreated: 0,
        testsPass: 0,
        testsFail: 0,
        commits: totalCommits,
        duration: Date.now() - startTime,
        milestones: { done: 1, total: 1 },
      });

      const summary = result.finalText.slice(0, 200) || "Surgical edit applied";
      return { success: true, summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reporter.error(`Surgical edit failed: ${msg}`);
      return { success: false, summary: `Surgical edit failed: ${msg}` };
    } finally {
      await ctx.cleanup();
    }
  }

  try {
    // ── Phase 1: Scaffold ──────────────────────────────────────
    const shouldScaffold = opts.scaffold || isDirectoryEmpty(opts.cwd);

    if (shouldScaffold) {
      reporter.phase("scaffold", "Analyzing goal...");

      const scaffoldPrompt = `You are starting a new project from scratch. The goal is: "${opts.goal}"

Analyze this and produce:
1. A tech stack decision (framework, language, database, CSS)
2. The directory structure
3. Initial files to create (package.json, tsconfig, etc)
4. A BACKLOG.md with 5-10 milestones ordered by dependency

Then execute: create all the initial files using the Write and Bash tools.
After creating files, run any install commands (bun install, npm install, etc).
Make sure BACKLOG.md exists with ## headings for each milestone.`;

      const scaffoldResult = await runAgentLoop(scaffoldPrompt, [], {
        systemPrompt: ctx.systemPrompt + "\n\n[AUTONOMOUS MODE — No human available. Execute fully, do not ask questions. Create all files directly.]",
        router: ctx.router,
        toolRegistry: ctx.toolRegistry,
        toolContext: ctx.toolContext,
        maxIterations: Math.min(opts.maxIterations, 50),
        onToolEnd: (name, _result, isError) => {
          if (!isError && (name === "Write" || name === "Bash")) {
            totalFilesCreated++;
          }
        },
      });

      // Extract tech stack info from the response (best-effort)
      const techMatch = scaffoldResult.finalText.match(/(?:tech stack|framework|using)[:\s]+([^\n]{10,80})/i);
      if (techMatch) {
        reporter.phase("scaffold", `Tech stack: ${techMatch[1]!.trim()}`);
      }

      // Commit scaffold
      const committed = await gitCommit(opts.cwd, "scaffold: initial project structure");
      if (committed) {
        reporter.commit("scaffold: initial project structure");
        totalCommits++;
      }

      reporter.phase("scaffold", "Scaffold complete");
    }

    // ── Phase 2: Build ─────────────────────────────────────────

    // Check timeout before build phase
    if (Date.now() - startTime > timeoutMs) {
      reporter.warn("Timeout reached after scaffold phase");
      return buildResult(reporter, true, totalCommits, totalFilesCreated, lastTestResults, startTime, 0, 0);
    }

    // Read BACKLOG.md for milestones
    const backlogPath = join(opts.cwd, "BACKLOG.md");
    let milestones: Array<{ name: string; details: string }> = [];

    if (existsSync(backlogPath)) {
      const backlogContent = await readFile(backlogPath, "utf-8");
      milestones = parseMilestones(backlogContent);
      reporter.phase("autopilot", `Found ${milestones.length} milestones in BACKLOG.md`);
    }

    if (milestones.length === 0) {
      // No backlog — create a single milestone from the goal
      milestones = [{ name: opts.goal, details: opts.goal }];
      reporter.phase("autopilot", "No BACKLOG.md found, using goal as single milestone");
    }

    let milestonesCompleted = 0;
    let iterationsUsed = 0;

    for (let i = 0; i < milestones.length; i++) {
      const ms = milestones[i]!;

      // Check timeout between milestones
      if (Date.now() - startTime > timeoutMs) {
        reporter.warn(`Timeout reached after ${milestonesCompleted} milestones`);
        break;
      }

      // Check iteration budget
      if (iterationsUsed >= opts.maxIterations) {
        reporter.warn(`Max iterations (${opts.maxIterations}) reached`);
        break;
      }

      reporter.milestone(i + 1, milestones.length, ms.name);

      // Snapshot of edit log length at milestone start — lets us slice edits
      // produced only during this milestone for bisect purposes.
      const editLogBaseIdx = recordedEdits.length;

      // Capture pre-milestone file snapshots for self-bisect edit recording.
      // We snapshot every tracked source file before coordinate() runs, then
      // diff against disk after — each changed file becomes one Edit entry.
      const preMilestoneSnapshots = new Map<string, string>();
      if (opts.selfBisect) {
        await snapshotTrackedFiles(opts.cwd, preMilestoneSnapshots);
      }

      // Dispatch milestone via Coordinator
      const coordinatorConfig: CoordinatorConfig = {
        router: ctx.router,
        toolRegistry: ctx.toolRegistry,
        toolContext: ctx.toolContext,
        systemPrompt: ctx.systemPrompt + "\n\n[AUTONOMOUS MODE — No human available. Execute fully, do not ask questions. Implement everything directly.]",
        maxParallel: 3,
        autoVerify: false,
        onProgress: (event) => {
          switch (event.type) {
            case "planning":
              reporter.phase("autopilot", event.message);
              break;
            case "plan_ready":
              reporter.phase("autopilot", `Plan: ${event.taskCount} tasks in ${event.waveCount} waves`);
              break;
            case "dispatching":
              reporter.phase("autopilot", `Dispatching: ${event.agentName}`);
              break;
            case "agent_complete":
              if (event.success) {
                reporter.phase("autopilot", `Done: ${event.agentName}`);
              } else {
                reporter.warn(`Failed: ${event.agentName} - ${event.summary.slice(0, 100)}`);
              }
              break;
          }
        },
      };

      try {
        const milestoneGoal = `Implement milestone: ${ms.name}\n\nDetails:\n${ms.details}\n\nThis is part of the larger goal: ${opts.goal}\nWorking directory: ${opts.cwd}`;
        const result = await coordinate(milestoneGoal, coordinatorConfig);

        const successCount = result.tasks.filter((t) => t.success).length;
        iterationsUsed += result.tasks.length;

        // Build edit log from pre/post file snapshots (for self-bisect).
        if (opts.selfBisect && preMilestoneSnapshots.size > 0) {
          await diffSnapshotsIntoEditLog(opts.cwd, preMilestoneSnapshots, recordedEdits, ms.name);
        }

        // Run tests after each milestone
        lastTestResults = await detectAndRunTests(opts.cwd);
        if (lastTestResults.passed > 0 || lastTestResults.failed > 0) {
          reporter.tests(lastTestResults.passed, lastTestResults.failed);
        }

        // If tests fail, attempt a fix pass
        if (lastTestResults.failed > 0) {
          reporter.phase("autopilot", "Attempting to fix test failures...");

          // Capture file snapshots before the fix-pass so bisect can restore.
          // We snapshot each file touched in this milestone's edits.
          const milestoneEdits = recordedEdits.slice(editLogBaseIdx);

          await runAgentLoop(
            `Tests are failing. Run the tests, read the error output, and fix all failures. Do not skip or delete tests.`,
            [],
            {
              systemPrompt: ctx.systemPrompt + "\n\n[AUTONOMOUS MODE — Fix failing tests. Execute fully.]",
              router: ctx.router,
              toolRegistry: ctx.toolRegistry,
              toolContext: ctx.toolContext,
              maxIterations: 15,
            },
          );
          iterationsUsed += 1;

          // Re-run tests
          lastTestResults = await detectAndRunTests(opts.cwd);
          if (lastTestResults.passed > 0 || lastTestResults.failed > 0) {
            reporter.tests(lastTestResults.passed, lastTestResults.failed);
          }

          // ── Self-bisect ──────────────────────────────────────────────────
          // If tests still red AND self-bisect is on AND we have recorded edits,
          // binary-search the milestone's edit sequence to isolate the culprit.
          if (opts.selfBisect && lastTestResults.failed > 0 && milestoneEdits.length > 0) {
            reporter.phase("autopilot", `Self-bisecting ${milestoneEdits.length} edit(s) to find culprit...`);

            /**
             * Restore the working tree to the state after applying the first
             * `prefixLen` edits from the milestone's edit log. We write each file
             * to its pre/post content depending on which edits are in the prefix.
             */
            const restoreTreeToPrefix = async (prefixLen: number): Promise<void> => {
              // Build a map of filePath → content at this prefix boundary.
              // For files not yet touched (index >= prefixLen), use `before` of
              // first edit on that file. For files in the prefix, use `after` of
              // the last edit on that file within the prefix.
              const fileState = new Map<string, string>();
              // Seed with pre-edit (before) content for every touched file.
              for (const e of milestoneEdits) {
                if (!fileState.has(e.filePath)) {
                  fileState.set(e.filePath, e.before);
                }
              }
              // Apply edits up to prefixLen.
              for (let k = 0; k < prefixLen && k < milestoneEdits.length; k++) {
                fileState.set(milestoneEdits[k]!.filePath, milestoneEdits[k]!.after);
              }
              for (const [filePath, content] of fileState) {
                try {
                  await writeFile(filePath, content, "utf-8");
                } catch {
                  // best-effort
                }
              }
            };

            const bisectResult = await bisectEdits({
              edits: milestoneEdits,
              check: async () => {
                const r = await detectAndRunTests(opts.cwd);
                return r.failed === 0;
              },
              apply: restoreTreeToPrefix,
            });

            if (bisectResult.reason === "isolated" && bisectResult.culprit) {
              reporter.phase(
                "autopilot",
                `Bisect isolated culprit edit #${bisectResult.culpritIndex} (${bisectResult.probes} probes): ${bisectResult.culprit.label ?? bisectResult.culprit.filePath}`,
              );
              if (bisectResult.surgicalRevert) {
                reporter.phase("autopilot", `Surgical revert:\n${bisectResult.surgicalRevert}`);
                // Apply the surgical revert (restore to before state for culprit file).
                try {
                  await writeFile(bisectResult.culprit.filePath, bisectResult.culprit.before, "utf-8");
                  reporter.phase("autopilot", `Applied surgical revert to ${bisectResult.culprit.filePath}`);
                  // Re-verify after revert.
                  lastTestResults = await detectAndRunTests(opts.cwd);
                  reporter.tests(lastTestResults.passed, lastTestResults.failed);
                } catch {
                  reporter.warn("Surgical revert write failed — tree may be inconsistent");
                }
              }
            } else {
              reporter.phase("autopilot", `Bisect result: ${bisectResult.reason} (${bisectResult.probes} probes) — no single culprit isolated`);
            }
          }
        }

        // Commit milestone
        const commitMsg = `feat: ${ms.name.toLowerCase()}`;
        const committed = await gitCommit(opts.cwd, commitMsg);
        if (committed) {
          reporter.commit(commitMsg);
          totalCommits++;
        }

        milestonesCompleted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reporter.error(`Milestone "${ms.name}" failed: ${msg.slice(0, 200)}`);
        // Continue to next milestone
      }
    }

    // ── Phase 3: Wrap-up ───────────────────────────────────────

    reporter.phase("wrap-up", "Running final checks...");

    // Flush + print Pulse HUD summary before final test run.
    const hud = getPulseHud();
    if (hud) {
      await hud.close();
      reporter.phase("wrap-up", hud.summaryLine());
    }

    // Final test suite
    lastTestResults = await detectAndRunTests(opts.cwd);
    if (lastTestResults.passed > 0 || lastTestResults.failed > 0) {
      reporter.tests(lastTestResults.passed, lastTestResults.failed);
    }

    // Final commit if uncommitted changes remain
    const finalCommitted = await gitCommit(opts.cwd, "chore: final cleanup");
    if (finalCommitted) {
      reporter.commit("chore: final cleanup");
      totalCommits++;
    }

    return buildResult(
      reporter,
      lastTestResults.failed === 0,
      totalCommits,
      totalFilesCreated,
      lastTestResults,
      startTime,
      milestonesCompleted,
      milestones.length,
    );
  } finally {
    await ctx.cleanup();
  }
}

function buildResult(
  reporter: AutonomousReporter,
  success: boolean,
  commits: number,
  filesCreated: number,
  testResults: { passed: number; failed: number },
  startTime: number,
  milestoneDone: number,
  milestoneTotal: number,
): AutonomousResult {
  const duration = Date.now() - startTime;

  reporter.summary({
    filesCreated,
    testsPass: testResults.passed,
    testsFail: testResults.failed,
    commits,
    duration,
    milestones: { done: milestoneDone, total: milestoneTotal },
  });

  const summary = `${milestoneDone}/${milestoneTotal} milestones, ${commits} commits, ${testResults.passed} tests pass, ${testResults.failed} tests fail`;
  return { success, summary };
}
