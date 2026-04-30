/**
 * `runUntilEmpty` — drain the autopilot work queue to completion.
 *
 * Unlike the heartbeat `AutopilotLoop`, this mode is one-shot: it walks the
 * queue, executes each `artist_build` item once, writes per-item NDJSON
 * progress + a final JSON/Markdown report, and exits when no `discovered`
 * items remain.
 *
 * The executor is injectable (via `mockExecutor`) so tests can exercise drain
 * logic without spinning up the coordinator. The default executor runs the
 * static-DAG `build-artist` coordinator config, matching the dispatch path in
 * `AutopilotLoop.executeItem`.
 */

import { existsSync } from "fs";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { WorkQueue } from "./queue.ts";
import type { WorkItem } from "./types.ts";
import {
  probeEnv,
  missingDeployCapabilities,
  type EnvProbeResult,
} from "./env-probe.ts";
import { createDrainLogger, type DrainLogger } from "./drain-logger.ts";
import { getConfigDir } from "../config/settings.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import {
  BucketRegistry,
  BudgetExceededError,
  budgetGuardFor,
  type CostBucket,
  type CostBucketEvent,
} from "./cost-bucket.ts";

/* ── Types ────────────────────────────────────────────────────── */

export type DrainItemStatus = "success" | "failed" | "deferred" | "skipped";

export interface DrainPerArtist {
  slug: string;
  status: DrainItemStatus;
  durationMs: number;
  costUsd: number | null;
  warnings: string[];
  error?: string;
  capabilitiesUsed: Partial<Record<keyof EnvProbeResult, boolean>>;
}

export interface DrainReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalProcessed: number;
  byStatus: { success: number; failed: number; deferred: number; skipped: number };
  totalCostUsd: number;
  /**
   * Per-artist results. Ordering reflects **completion order**, not seed
   * order — when `concurrency > 1`, fast items finish before slow ones even
   * if they were claimed later.
   */
  perArtist: DrainPerArtist[];
}

export interface MockExecutorInput {
  item: WorkItem;
  slug: string;
  capabilities: EnvProbeResult;
  budgetUsd?: number;
  dryRun: boolean;
  /**
   * Per-slug cost bucket for this run. Present when
   * `budgetUsdPerArtist` (or item-level `budgetUsd`) is set. The real
   * executor wires `bucket`'s guard into the coordinator's ToolContext;
   * tests may call `bucket.settle(...)` to simulate real spend.
   */
  bucket?: CostBucket;
}

export interface MockExecutorOutput {
  status: "success" | "failed";
  durationMs: number;
  costUsd: number | null;
  warnings?: string[];
  error?: string;
}

export type DrainExecutor = (input: MockExecutorInput) => Promise<MockExecutorOutput>;

export interface UntilEmptyOptions {
  /** Project cwd — same hash as WorkQueue for queue/progress/report paths. */
  cwd?: string;
  /** When true, defer items missing any deploy capability instead of running dry. */
  requireDeployEnv?: boolean;
  /** Per-artist budget in USD, piped through as `{{budgetUsd}}`. */
  budgetUsdPerArtist?: number;
  /** Env overrides for probing (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Test seam — replaces real coordinator dispatch. */
  mockExecutor?: DrainExecutor;
  /** Logger override — tests pass a non-TTY collector. */
  logger?: DrainLogger;
  /** Hard cap on iterations, safety valve. Default: 1000. */
  maxItems?: number;
  /**
   * Run up to N items in parallel. Default 1 (serial, byte-equivalent to the
   * pre-concurrency behavior). Coerced to [1, 8] — values above 4 are likely
   * to trigger shared-credential rate limits on LLM/HTTP APIs.
   */
  concurrency?: number;
  /** Real-executor-only — required when `mockExecutor` is not supplied. */
  coordinator?: {
    router: ProviderRouter;
    toolRegistry: ToolRegistry;
    toolContext: ToolContext;
    systemPrompt: string;
    teamId?: string;
    maxParallel?: number;
  };
}

/* ── Paths (shared hash logic with WorkQueue) ─────────────────── */

function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function autopilotDir(): string {
  return join(getConfigDir(), "autopilot");
}

function progressPath(cwd: string): string {
  return join(autopilotDir(), `${hashCwd(cwd)}.progress.ndjson`);
}

function reportJsonPath(cwd: string): string {
  return join(autopilotDir(), `${hashCwd(cwd)}.report.json`);
}

function reportMdPath(cwd: string): string {
  return join(autopilotDir(), `${hashCwd(cwd)}.report.md`);
}

/* ── Cost helper ──────────────────────────────────────────────── */

/**
 * Best-effort cost read from `~/.cache/enrich/<slug>/cost.ndjson`.
 * Each NDJSON line is expected to carry a numeric `costUsd` field; we sum
 * whatever we can parse. Returns null if the file is absent or unreadable.
 */
async function readCostFor(slug: string): Promise<number | null> {
  const path = join(homedir(), ".cache", "enrich", slug, "cost.ndjson");
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    let total = 0;
    let seen = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { costUsd?: unknown };
        const n = typeof obj.costUsd === "number" ? obj.costUsd : Number(obj.costUsd);
        if (Number.isFinite(n)) {
          total += n;
          seen = true;
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return seen ? total : null;
  } catch {
    return null;
  }
}

/* ── Default (real) executor ──────────────────────────────────── */

function buildDefaultExecutor(opts: UntilEmptyOptions): DrainExecutor {
  return async ({ item, slug, budgetUsd, bucket }) => {
    const start = Date.now();
    if (!opts.coordinator) {
      return {
        status: "failed",
        durationMs: 0,
        costUsd: null,
        error: "runUntilEmpty: no coordinator config and no mockExecutor provided",
      };
    }
    try {
      const { loadCoordinatorConfig } = await import("../agent/coordinator-config.ts");
      const { coordinateWithTasks } = await import("../agent/coordinator.ts");
      const vars: Record<string, string> = { slug };
      if (typeof budgetUsd === "number") vars.budgetUsd = String(budgetUsd);
      const { config: cfg, tasks } = await loadCoordinatorConfig("build-artist", vars);
      // Install per-slug budget guard on a forked ToolContext so the
      // coordinator's tool calls consult THIS bucket, not a shared one.
      const toolContext: ToolContext = bucket
        ? { ...opts.coordinator.toolContext, budgetGuard: budgetGuardFor(bucket) }
        : opts.coordinator.toolContext;
      const result = await coordinateWithTasks(tasks, `build-artist: ${slug}`, {
        router: opts.coordinator.router,
        toolRegistry: opts.coordinator.toolRegistry,
        toolContext,
        systemPrompt: opts.coordinator.systemPrompt,
        teamId: opts.coordinator.teamId,
        maxParallel: cfg.maxParallel ?? opts.coordinator.maxParallel ?? 3,
        autoVerify: false,
      });
      const success = result.tasks.length > 0 && result.tasks.every((t) => t.success);
      const costUsd = await readCostFor(slug);
      return {
        status: success ? "success" : "failed",
        durationMs: Date.now() - start,
        costUsd,
        error: success
          ? undefined
          : `coordinator failed: ${result.tasks.filter((t) => !t.success).length} task(s) failed`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        durationMs: Date.now() - start,
        costUsd: null,
        error: msg.slice(0, 400),
      };
    }
  };
}

/* ── Main entrypoint ──────────────────────────────────────────── */

export async function runUntilEmpty(opts: UntilEmptyOptions = {}): Promise<DrainReport> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const capabilities = probeEnv(env);
  const missing = missingDeployCapabilities(capabilities);
  const dryRun = missing.length > 0;
  const executor = opts.mockExecutor ?? buildDefaultExecutor(opts);
  const logger = opts.logger ?? createDrainLogger({});
  const maxItems = opts.maxItems ?? 1000;

  await mkdir(autopilotDir(), { recursive: true });

  const queue = new WorkQueue(cwd);
  await queue.load();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const perArtist: DrainPerArtist[] = [];
  const tally = { success: 0, failed: 0, deferred: 0, skipped: 0 };

  if (dryRun && !opts.requireDeployEnv) {
    logger.info(
      `[until-empty] deploy env incomplete (${missing.join(", ")}) — running in dryRun mode`,
    );
  } else if (opts.requireDeployEnv && dryRun) {
    logger.info(
      `[until-empty] --require-deploy-env set; missing (${missing.join(", ")}) — eligible items will be deferred`,
    );
  }

  // Reset progress NDJSON
  await writeFile(progressPath(cwd), "", "utf-8");

  async function writeProgress(line: Record<string, unknown>): Promise<void> {
    await appendFile(progressPath(cwd), JSON.stringify(line) + "\n", "utf-8");
  }

  // Snapshot initial pending count for the progress indicator.
  const initialTotal = queue
    .getAll()
    .filter((i) => i.status === "discovered" && i.type === "artist_build").length;
  let index = 0;

  // Keep a set of item ids we've already deferred so we don't loop forever.
  const deferredIds = new Set<string>();

  // Per-slug cost buckets. Created lazily per item in the worker below.
  // Events are captured into the bucket-event log and surfaced as per-item
  // warnings in the DrainReport.
  const bucketEvents = new Map<string, CostBucketEvent[]>();
  const bucketRegistry = new BucketRegistry({
    onEvent: (ev) => {
      const arr = bucketEvents.get(ev.slug) ?? [];
      arr.push(ev);
      bucketEvents.set(ev.slug, arr);
    },
  });

  // Concurrency: clamp to [1, 8]. Worker pool + in-flight slug tracking.
  const HARD_CAP = 8;
  const requested = opts.concurrency ?? 1;
  const concurrency = Math.max(1, Math.min(HARD_CAP, Math.floor(requested)));
  const inflight = new Map<string, { slug: string; startedAt: number }>();

  // Serialize queue.save() to avoid racy interleaved writes across workers.
  let savePromise: Promise<void> = Promise.resolve();
  function scheduleSave(): Promise<void> {
    savePromise = savePromise.then(() => queue.save()).catch(() => {});
    return savePromise;
  }

  function emitProgress(): void {
    if (concurrency === 1 || inflight.size === 0) return;
    const now = Date.now();
    const slugs = Array.from(inflight.values());
    const summary = slugs
      .map((s) => `${s.slug}(${Math.round((now - s.startedAt) / 1000)}s)`)
      .join(", ");
    logger.progress({
      index,
      total: initialTotal,
      slug: summary,
      phase: `${inflight.size}/${concurrency} parallel`,
      spentUsd: 0,
      elapsedMs: 0,
    });
  }

  // Worker: repeatedly claim the next discovered artist_build item and process
  // it until the queue is empty. Exits when claimNext returns null.
  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (index >= maxItems) return;

      const claimed = queue.claimNext(
        (i) => i.type === "artist_build" && !deferredIds.has(i.id),
      );
      if (!claimed) return;

      index++;
      const localIndex = index;
      const slug = claimed.slug ?? claimed.file?.replace(/^.*\/(.*)\.json$/, "$1") ?? claimed.id;
      const budgetUsd = claimed.budgetUsd ?? opts.budgetUsdPerArtist;

      // --require-deploy-env gating: flip back to discovered + defer.
      if (opts.requireDeployEnv && dryRun) {
        claimed.status = "discovered";
        queue.deferItem(claimed.id);
        deferredIds.add(claimed.id);
        tally.deferred++;
        const entry: DrainPerArtist = {
          slug,
          status: "deferred",
          durationMs: 0,
          costUsd: null,
          warnings: [`missing deploy capabilities: ${missing.join(", ")}`],
          capabilitiesUsed: {},
        };
        perArtist.push(entry);
        await writeProgress({ ts: new Date().toISOString(), slug, status: "deferred", missing });
        logger.info(
          `[${localIndex}/${initialTotal}] deferred ${slug} (missing: ${missing.join(", ")})`,
        );
        await scheduleSave();
        continue;
      }

      const itemStart = Date.now();
      inflight.set(claimed.id, { slug, startedAt: itemStart });

      if (concurrency === 1) {
        logger.progress({
          index: localIndex,
          total: initialTotal,
          slug,
          phase: "executing",
          spentUsd: 0,
          elapsedMs: 0,
        });
      } else {
        emitProgress();
      }
      await writeProgress({
        ts: new Date().toISOString(),
        slug,
        status: "started",
        worker: workerId,
        dryRun,
        budgetUsd,
      });

      // Per-slug bucket: only created when a budget was actually specified,
      // so drains without `--budget-usd-per-artist` keep their current
      // zero-overhead behaviour.
      const bucket =
        typeof budgetUsd === "number" && budgetUsd > 0
          ? bucketRegistry.getBucket(slug, budgetUsd)
          : undefined;

      let out: MockExecutorOutput;
      let attempts = 0;
      const MAX_RATE_LIMIT_RETRIES = 3;
      // 429-aware backoff loop. On a rate-limit error we retry the SAME
      // item with exponential backoff (1s → 2s → 4s, cap 60s) up to 3
      // times. On the 4th failure, or any non-429 error, we surface the
      // failure normally.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          out = await executor({
            item: claimed,
            slug,
            capabilities,
            budgetUsd,
            dryRun,
            bucket,
          });
          break;
        } catch (err) {
          // Budget breach → fail the item, don't halt the whole drain.
          if (err instanceof BudgetExceededError) {
            out = {
              status: "failed",
              durationMs: Date.now() - itemStart,
              costUsd: bucket?.spent ?? null,
              error: `budget exceeded: ${err.slug} $${err.spentUsd.toFixed(4)} / $${err.budgetUsd.toFixed(4)}`,
            };
            break;
          }
          // 429 detection: no dedicated `RateLimitError` class exists in
          // this codebase yet (router.ts surfaces 429 as a generic Error
          // whose message contains "429"/"rate_limit"/"quota"). We match
          // on that plus an `.status === 429` fallback for future
          // Anthropic/SDK upgrades. TODO: promote to a real `RateLimitError`
          // class exported from providers/router.ts.
          const msg = err instanceof Error ? err.message : String(err);
          const status = (err as { status?: unknown })?.status;
          const isRateLimit =
            status === 429 ||
            /\b429\b|rate[_ ]?limit|quota/i.test(msg);
          if (isRateLimit && attempts < MAX_RATE_LIMIT_RETRIES) {
            const delayMs = Math.min(60_000, 1000 * Math.pow(2, attempts));
            attempts++;
            logger.info(
              `[until-empty] rate-limited on ${slug} (attempt ${attempts}/${MAX_RATE_LIMIT_RETRIES}) — backing off ${delayMs}ms`,
            );
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          out = {
            status: "failed",
            durationMs: Date.now() - itemStart,
            costUsd: bucket?.spent ?? null,
            error: msg.slice(0, 400),
          };
          break;
        }
      }

      const costUsd =
        bucket !== undefined
          ? bucket.spent
          : out.costUsd ?? (await readCostFor(slug));

      if (out.status === "success") {
        queue.completeItem(claimed.id);
        tally.success++;
      } else {
        queue.failItem(claimed.id, out.error ?? "executor returned failed");
        tally.failed++;
      }

      const capsUsed: Partial<Record<keyof EnvProbeResult, boolean>> = {};
      for (const k of Object.keys(capabilities) as Array<keyof EnvProbeResult>) {
        if (capabilities[k]) capsUsed[k] = true;
      }

      const warnings = [...(out.warnings ?? [])];
      // Surface bucket events (warn/halt) as per-artist warnings.
      const events = bucketEvents.get(slug) ?? [];
      for (const ev of events) {
        if (ev.type === "warn" || ev.type === "halt") {
          warnings.push(
            `budget ${ev.type}: $${ev.spentUsd.toFixed(4)}/$${ev.budgetUsd.toFixed(4)} on "${ev.transform}"${ev.message ? ` — ${ev.message}` : ""}`,
          );
        }
      }

      const entry: DrainPerArtist = {
        slug,
        status: out.status,
        durationMs: out.durationMs,
        costUsd,
        warnings,
        error: out.error,
        capabilitiesUsed: capsUsed,
      };
      perArtist.push(entry);

      await writeProgress({
        ts: new Date().toISOString(),
        slug,
        status: out.status,
        worker: workerId,
        durationMs: out.durationMs,
        costUsd,
        error: out.error,
      });

      inflight.delete(claimed.id);
      await scheduleSave();

      logger.progress({
        index: localIndex,
        total: initialTotal,
        slug,
        phase: out.status,
        spentUsd: costUsd ?? 0,
        elapsedMs: out.durationMs,
      });
      logger.info(
        `[${localIndex}/${initialTotal}] ${out.status} ${slug} — cost: ${costUsd === null ? "n/a" : `$${costUsd.toFixed(2)}`} — ${(out.durationMs / 1000).toFixed(1)}s`,
      );
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);
  // Final save flush.
  await scheduleSave();

  logger.close();

  const finishedAtMs = Date.now();
  const totalCostUsd = perArtist.reduce((s, a) => s + (a.costUsd ?? 0), 0);

  const report: DrainReport = {
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    totalProcessed: perArtist.length,
    byStatus: tally,
    totalCostUsd,
    perArtist,
  };

  await writeFile(reportJsonPath(cwd), JSON.stringify(report, null, 2), "utf-8");
  await writeFile(reportMdPath(cwd), renderReportMarkdown(report), "utf-8");

  bucketRegistry.dispose();

  return report;
}

/* ── Markdown report ──────────────────────────────────────────── */

export function renderReportMarkdown(report: DrainReport): string {
  const lines: string[] = [];
  lines.push(`# Autopilot Drain Report`);
  lines.push("");
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Finished: ${report.finishedAt}`);
  lines.push(`- Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Total processed: ${report.totalProcessed}`);
  lines.push(
    `- Success: ${report.byStatus.success} · Failed: ${report.byStatus.failed} · Deferred: ${report.byStatus.deferred} · Skipped: ${report.byStatus.skipped}`,
  );
  lines.push(`- Total cost: $${report.totalCostUsd.toFixed(2)}`);
  lines.push("");
  lines.push(`## Per-artist`);
  lines.push("");
  lines.push(`| Slug | Status | Duration (s) | Cost (USD) | Warnings | Error |`);
  lines.push(`| ---- | ------ | ------------ | ---------- | -------- | ----- |`);
  for (const a of report.perArtist) {
    const cost = a.costUsd === null ? "n/a" : `$${a.costUsd.toFixed(2)}`;
    const warnings = a.warnings.length > 0 ? a.warnings.join("; ") : "";
    const err = (a.error ?? "").replace(/\|/g, "\\|").slice(0, 120);
    lines.push(
      `| ${a.slug} | ${a.status} | ${(a.durationMs / 1000).toFixed(1)} | ${cost} | ${warnings} | ${err} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
