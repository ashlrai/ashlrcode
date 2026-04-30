/**
 * `CostBucket` — per-slug LLM-budget guard for concurrent autopilot drains.
 *
 * Why this exists: `runUntilEmpty` runs up to N workers in parallel, all
 * sharing a single `router.costTracker`. If each worker happens to process a
 * different artist concurrently, they'd all see the same (shared) spent total
 * and none would independently halt at its own per-artist budget ceiling — a
 * 4-way concurrent drain could silently blow past `--budget-usd-per-artist`
 * on every artist simultaneously.
 *
 * The `CostBucket` is a *per-slug* accounting sibling to
 * `packages/enrich/src/cost-guard.ts`. Factory-side and ashlrcode-side
 * buckets are intentionally separate instances; this file never imports the
 * factory code.
 *
 * API mirrors `packages/enrich/src/cost-guard.ts`:
 *   - `reserve(estimatedUsd, transform)` → throws `BudgetExceededError` when
 *     projected spend would breach the budget.
 *   - `settle(actualUsd, transform)` → reconciles actual spend after the call
 *     completes. Can go negative in reservation terms (if we over-estimate).
 *   - `tick`/`warn`/`halt` events emitted through the optional `onEvent` cb.
 *
 * Concurrency model: this is a single-process Node/Bun runtime. All
 * `reserve`/`settle` calls happen on the main event loop between awaits; no
 * real mutex is needed. The `BucketRegistry` does the same — `getBucket`
 * is synchronous and returns the same instance for repeated slug lookups.
 */

export class BudgetExceededError extends Error {
  constructor(
    public readonly slug: string,
    public readonly spentUsd: number,
    public readonly budgetUsd: number,
    public readonly transform: string,
  ) {
    super(
      `budget exceeded: ${slug} $${spentUsd.toFixed(4)} / $${budgetUsd.toFixed(4)} (would breach on "${transform}")`,
    );
    this.name = "BudgetExceededError";
  }
}

export type CostBucketEventType = "tick" | "warn" | "halt";

export interface CostBucketEvent {
  type: CostBucketEventType;
  slug: string;
  spentUsd: number;
  budgetUsd: number;
  transform: string;
  message?: string;
}

export interface CostBucketOptions {
  slug: string;
  budgetUsd: number;
  /** Emit a `warn` event when spent exceeds this threshold (once). Defaults to 0.8 * budget. */
  warnUsd?: number;
  onEvent?: (ev: CostBucketEvent) => void;
}

export interface CostBucketReport {
  slug: string;
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  halted: boolean;
  warned: boolean;
}

/**
 * Single-slug cost bucket. Not thread-safe in the general sense — relies on
 * single-threaded JS event-loop semantics. All reserve/settle calls must
 * happen synchronously (between `await` boundaries) to stay consistent.
 */
export class CostBucket {
  readonly slug: string;
  readonly budgetUsd: number;
  readonly warnUsd: number;
  private _spent = 0;
  private _reserved = 0;
  private _halted = false;
  private _warned = false;
  private readonly onEvent?: (ev: CostBucketEvent) => void;

  constructor(opts: CostBucketOptions) {
    this.slug = opts.slug;
    this.budgetUsd = opts.budgetUsd;
    this.warnUsd = opts.warnUsd ?? opts.budgetUsd * 0.8;
    this.onEvent = opts.onEvent;
  }

  get spent(): number {
    return this._spent;
  }

  get reserved(): number {
    return this._reserved;
  }

  get remaining(): number {
    return Math.max(0, this.budgetUsd - this._spent - this._reserved);
  }

  get halted(): boolean {
    return this._halted;
  }

  get warned(): boolean {
    return this._warned;
  }

  /**
   * Reserve budget for an upcoming call. Throws `BudgetExceededError` if the
   * projected spend would breach the budget. The caller should call `settle`
   * after the actual call completes to reconcile.
   */
  reserve(estimatedUsd: number, transform: string): void {
    const projected = this._spent + this._reserved + Math.max(0, estimatedUsd);
    if (projected > this.budgetUsd) {
      if (!this._halted) {
        this._halted = true;
        this.emit("halt", transform, `would breach budget: projected $${projected.toFixed(4)}`);
      }
      throw new BudgetExceededError(this.slug, this._spent, this.budgetUsd, transform);
    }
    this._reserved += Math.max(0, estimatedUsd);
    this.emit("tick", transform);
  }

  /**
   * Settle an actual spend. Reduces reservation by the original estimate (best
   * effort — caller may pass the same estimate they reserved, or just the
   * actual cost; this implementation treats `settle` as "reduce reservation
   * by actual and accumulate actual into spent"). Emits `warn` once when
   * crossing `warnUsd`.
   */
  settle(actualUsd: number, transform: string): void {
    const amount = Math.max(0, actualUsd);
    // Drain the reservation by up to `amount`, but don't go negative.
    this._reserved = Math.max(0, this._reserved - amount);
    this._spent += amount;
    if (!this._warned && this._spent >= this.warnUsd && this._spent < this.budgetUsd) {
      this._warned = true;
      this.emit("warn", transform, `spent $${this._spent.toFixed(4)} ≥ warn threshold $${this.warnUsd.toFixed(4)}`);
    }
    if (!this._halted && this._spent >= this.budgetUsd) {
      this._halted = true;
      this.emit("halt", transform, `actual spend reached budget: $${this._spent.toFixed(4)}`);
    }
    this.emit("tick", transform);
  }

  getReport(): CostBucketReport {
    return {
      slug: this.slug,
      budgetUsd: this.budgetUsd,
      spentUsd: this._spent,
      reservedUsd: this._reserved,
      halted: this._halted,
      warned: this._warned,
    };
  }

  private emit(type: CostBucketEventType, transform: string, message?: string): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        type,
        slug: this.slug,
        spentUsd: this._spent,
        budgetUsd: this.budgetUsd,
        transform,
        message,
      });
    } catch {
      /* event callback errors are swallowed — accounting must not fail */
    }
  }
}

/**
 * Registry of per-slug buckets. Created at the start of `runUntilEmpty`,
 * disposed at the end. `getBucket` is idempotent — repeated calls with the
 * same slug return the same instance.
 */
export class BucketRegistry {
  private readonly buckets = new Map<string, CostBucket>();
  private readonly onEvent?: (ev: CostBucketEvent) => void;

  constructor(opts: { onEvent?: (ev: CostBucketEvent) => void } = {}) {
    this.onEvent = opts.onEvent;
  }

  getBucket(slug: string, budgetUsd: number): CostBucket {
    const existing = this.buckets.get(slug);
    if (existing) return existing;
    const bucket = new CostBucket({ slug, budgetUsd, onEvent: this.onEvent });
    this.buckets.set(slug, bucket);
    return bucket;
  }

  has(slug: string): boolean {
    return this.buckets.has(slug);
  }

  getReport(): Record<string, CostBucketReport> {
    const out: Record<string, CostBucketReport> = {};
    for (const [slug, bucket] of this.buckets) {
      out[slug] = bucket.getReport();
    }
    return out;
  }

  dispose(): void {
    this.buckets.clear();
  }
}

/**
 * `BudgetGuard` — the narrow callback threaded through `ToolContext` so that
 * tool calls (particularly ones wrapping LLM requests) can consult the
 * per-slug bucket without knowing about the registry or the autopilot.
 *
 * Signature intentionally matches a function rather than an object so it can
 * be passed via the existing `--var` / closure mechanisms without schema
 * changes to the coordinator config.
 */
export type BudgetGuard = (estimatedUsd: number, transform: string) => void;

/** Build a `BudgetGuard` closure bound to a specific bucket. */
export function budgetGuardFor(bucket: CostBucket): BudgetGuard {
  return (estimatedUsd: number, transform: string) => {
    bucket.reserve(estimatedUsd, transform);
  };
}
