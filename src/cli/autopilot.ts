#!/usr/bin/env bun
/**
 * `ac-autopilot` — one-shot autopilot drain CLI.
 *
 * Intended for overnight runs: drains the artist-build work queue until no
 * `discovered` items remain, writes JSON + Markdown reports to
 * `~/.ashlrcode/autopilot/<hash>.report.{json,md}`, and streams per-item
 * progress to `<hash>.progress.ndjson`.
 *
 * Usage:
 *   ac-autopilot --until-empty [--cwd <path>] [--mock]
 *                [--require-deploy-env]
 *                [--budget-usd-per-artist <n>]
 *                [--concurrency <n>]
 *
 * `--mock` uses a stub executor that marks every item success with $0 cost —
 * used for drain-logic rehearsals and CI. Without `--mock`, the CLI runs real
 * coordinator dispatch using the same bootstrap (`buildMinimalCoordinatorContext`)
 * as the REPL.
 */

import { resolve } from "path";
import { runUntilEmpty, type DrainExecutor, type DrainReport } from "../autopilot/until-empty.ts";

interface CliOpts {
  cwd: string;
  untilEmpty: boolean;
  mock: boolean;
  requireDeployEnv: boolean;
  budgetUsdPerArtist?: number;
  concurrency?: number;
  printJson: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    cwd: process.cwd(),
    untilEmpty: false,
    mock: false,
    requireDeployEnv: false,
    printJson: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--until-empty":
        opts.untilEmpty = true;
        break;
      case "--mock":
        opts.mock = true;
        break;
      case "--require-deploy-env":
        opts.requireDeployEnv = true;
        break;
      case "--json":
        opts.printJson = true;
        break;
      case "--cwd":
        opts.cwd = resolve(argv[++i] ?? opts.cwd);
        break;
      case "--budget-usd-per-artist": {
        const n = Number(argv[++i] ?? "");
        if (Number.isFinite(n)) opts.budgetUsdPerArtist = n;
        break;
      }
      case "--concurrency": {
        const n = Number(argv[++i] ?? "");
        if (Number.isFinite(n)) opts.concurrency = n;
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("--cwd=")) {
          opts.cwd = resolve(a.slice("--cwd=".length));
        } else if (a.startsWith("--budget-usd-per-artist=")) {
          const n = Number(a.slice("--budget-usd-per-artist=".length));
          if (Number.isFinite(n)) opts.budgetUsdPerArtist = n;
        } else if (a.startsWith("--concurrency=")) {
          const n = Number(a.slice("--concurrency=".length));
          if (Number.isFinite(n)) opts.concurrency = n;
        } else {
          console.error(`[ac-autopilot] unknown arg: ${a}`);
          process.exit(2);
        }
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`ac-autopilot — drain the autopilot work queue until empty

Usage:
  ac-autopilot --until-empty [flags]

Flags:
  --cwd <path>                  Project cwd (hash keys queue + reports). Default: pwd.
  --mock                        Use a stub executor (no real coordinator). Safe for rehearsal.
  --require-deploy-env          Defer items missing deploy capabilities (VERCEL_TOKEN, etc).
  --budget-usd-per-artist <n>   Per-artist LLM budget, passed through as --var budgetUsd=<n>.
  --concurrency <n>             Run up to N artists in parallel (default 1, hard cap 8).
                                  Values >4 likely hit shared-API rate limits.
  --json                        Print DrainReport JSON to stdout on completion.
  -h, --help                    Show this help.

Example (overnight drain, 3 in parallel):
  ac-autopilot --until-empty --cwd ../artist-encyclopedia-factory --concurrency 3
`);
}

const MOCK_EXECUTOR: DrainExecutor = async ({ slug }) => {
  // Stub that marks every item as success with zero cost. Used for drain-logic
  // rehearsals without touching real coordinator, Vercel, Anthropic, etc.
  return {
    status: "success",
    durationMs: 1,
    costUsd: 0,
    warnings: [`mock executor: no real work done for ${slug}`],
  };
};

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.untilEmpty) {
    console.error("[ac-autopilot] --until-empty is required (no other modes yet).");
    printHelp();
    process.exit(2);
  }

  // Real-coordinator bootstrap (skipped for --mock).
  let coordinator: any = undefined;
  let cleanup: (() => Promise<void>) | null = null;

  if (!opts.mock) {
    const { buildMinimalCoordinatorContext } = await import("../agent/bootstrap.ts");
    const ctx = await buildMinimalCoordinatorContext(opts.cwd, { mode: "yolo" });
    coordinator = {
      router: ctx.router,
      toolRegistry: ctx.toolRegistry,
      toolContext: ctx.toolContext,
      systemPrompt: ctx.systemPrompt,
    };
    cleanup = ctx.cleanup;
  }

  try {
    const report: DrainReport = await runUntilEmpty({
      cwd: opts.cwd,
      requireDeployEnv: opts.requireDeployEnv,
      budgetUsdPerArtist: opts.budgetUsdPerArtist,
      concurrency: opts.concurrency,
      mockExecutor: opts.mock ? MOCK_EXECUTOR : undefined,
      coordinator: opts.mock ? undefined : (coordinator as any),
    });

    if (opts.printJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `\n[ac-autopilot] done — processed ${report.totalProcessed}: ` +
          `${report.byStatus.success} success · ${report.byStatus.failed} failed · ` +
          `${report.byStatus.deferred} deferred — total $${report.totalCostUsd.toFixed(2)}`,
      );
    }

    if (report.byStatus.failed > 0) process.exit(1);
  } finally {
    if (cleanup) await cleanup().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[ac-autopilot] fatal:", err);
  process.exit(1);
});
