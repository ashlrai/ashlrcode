/**
 * Autonomous Mode — headless non-interactive execution.
 *
 * Scaffolds greenfield projects and builds them via the existing
 * Coordinator, all without human intervention.
 *
 * Usage: ac --autonomous --goal "Build X" [--initial-scaffold] [--max-iterations N] [--timeout S]
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { runAgentLoop } from "./loop.ts";
import { coordinate, type CoordinatorConfig } from "./coordinator.ts";
import { AutonomousReporter } from "./autonomous-reporter.ts";
import { buildMinimalCoordinatorContext, type MinimalCoordinatorContext } from "./bootstrap.ts";

export interface AutonomousOptions {
  goal: string;
  cwd: string;
  scaffold: boolean;
  maxIterations: number;
  /** Timeout in seconds */
  timeout: number;
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

/* ── Main entry point ─────────────────────────────────────────────── */

export async function runAutonomous(opts: AutonomousOptions): Promise<AutonomousResult> {
  const reporter = new AutonomousReporter();
  const startTime = Date.now();
  const timeoutMs = opts.timeout * 1000;
  let totalCommits = 0;
  let totalFilesCreated = 0;
  let lastTestResults = { passed: 0, failed: 0 };

  reporter.phase("init", `Goal: ${opts.goal}`);
  reporter.phase("init", `Working directory: ${opts.cwd}`);

  // Bootstrap the full coordinator context (router, tools, permissions, system prompt)
  let ctx: MinimalCoordinatorContext;
  try {
    ctx = await buildMinimalCoordinatorContext(opts.cwd, { mode: "yolo" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reporter.error(`Failed to initialize: ${msg}`);
    return { success: false, summary: `Init failed: ${msg}` };
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

        // Run tests after each milestone
        lastTestResults = await detectAndRunTests(opts.cwd);
        if (lastTestResults.passed > 0 || lastTestResults.failed > 0) {
          reporter.tests(lastTestResults.passed, lastTestResults.failed);
        }

        // If tests fail, attempt a fix pass
        if (lastTestResults.failed > 0) {
          reporter.phase("autopilot", "Attempting to fix test failures...");
          const fixResult = await runAgentLoop(
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
