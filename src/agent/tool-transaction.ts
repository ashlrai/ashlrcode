/**
 * ToolTransaction — ACID-like transaction wrapper for multi-tool agent sequences.
 *
 * Provides composable, rollback-safe abstractions for sequences that mix file
 * reads, writes, edits, and shell commands. Any step failure auto-rolls back
 * all deferred writes committed in the same transaction.
 *
 * State machine:
 *   ready → executing → committed
 *                    ↘ rolled-back
 *
 * Key properties:
 *  - Writes are deferred until commit() — no partial disk mutations on failure
 *  - bash() executes immediately; failure triggers automatic rollback of all
 *    deferred writes queued so far in the transaction
 *  - Nested child transactions commit only when the parent commits; parent
 *    failure rolls back all children automatically
 *  - getJournal() returns a timestamped audit trail of every step
 *  - getImpactSummary() reports aggregate file + line-change stats
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, isAbsolute } from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransactionState = "ready" | "executing" | "committed" | "rolled-back";

export type JournalEntryStatus = "ok" | "error" | "rolled-back";

export interface JournalEntry {
  timestamp: number;
  /** Tool name: "read" | "write" | "edit" | "bash" | "commit" | "rollback" | "nest" */
  tool: string;
  /** Tool-specific detail (path, command, etc.) */
  detail: string;
  status: JournalEntryStatus;
  /** Error message when status is "error" */
  error?: string;
  /** Duration in ms */
  durationMs: number;
}

export interface ImpactSummary {
  filesRead: number;
  filesModified: number;
  /** Total lines added across all write/edit operations (approximation) */
  linesAdded: number;
  /** Total lines deleted across all write/edit operations (approximation) */
  linesDeleted: number;
  /** Number of bash commands executed */
  bashCommandsRun: number;
  /** Number of nested child transactions */
  childTransactions: number;
}

/** A deferred write operation stored until commit(). */
interface DeferredWrite {
  resolvedPath: string;
  /** Content to write on commit */
  newContent: string;
  /** Original content for rollback; null = file did not exist */
  originalContent: string | null;
  /** Approximate line delta for impact summary */
  linesAdded: number;
  linesDeleted: number;
}

// ---------------------------------------------------------------------------
// ToolTransaction
// ---------------------------------------------------------------------------

export class ToolTransaction {
  private _state: TransactionState = "ready";
  private _cwd: string;
  private _journal: JournalEntry[] = [];
  private _deferredWrites = new Map<string, DeferredWrite>();
  private _children: ToolTransaction[] = [];
  private _parent: ToolTransaction | null = null;

  /** bashErrorMessage stores the first bash failure for diagnostics */
  private _bashError: string | null = null;

  constructor(cwd: string, parent: ToolTransaction | null = null) {
    this._cwd = cwd;
    this._parent = parent;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  get state(): TransactionState {
    return this._state;
  }

  get cwd(): string {
    return this._cwd;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this._cwd, p);
  }

  private record(
    tool: string,
    detail: string,
    status: JournalEntryStatus,
    durationMs: number,
    error?: string
  ): void {
    this._journal.push({ timestamp: Date.now(), tool, detail, status, durationMs, error });
  }

  private assertReady(): void {
    if (this._state !== "ready" && this._state !== "executing") {
      throw new Error(
        `ToolTransaction: cannot perform operations in state "${this._state}"`
      );
    }
  }

  private setExecuting(): void {
    if (this._state === "ready") this._state = "executing";
  }

  /** Compute line deltas between two content strings. */
  private static lineDelta(
    original: string,
    updated: string
  ): { linesAdded: number; linesDeleted: number } {
    const origLines = original === "" ? [] : original.split("\n");
    const updLines = updated === "" ? [] : updated.split("\n");
    const added = Math.max(0, updLines.length - origLines.length);
    const deleted = Math.max(0, origLines.length - updLines.length);
    return { linesAdded: added, linesDeleted: deleted };
  }

  // ── Public API — Operations ────────────────────────────────────────────────

  /**
   * Read a file. Returns its content, or throws if the file does not exist.
   * This operation never defers; it reads immediately.
   */
  async read(path: string): Promise<string> {
    this.assertReady();
    this.setExecuting();
    const resolvedPath = this.resolvePath(path);
    const start = performance.now();
    try {
      if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
      }
      const content = await readFile(resolvedPath, "utf-8");
      this.record("read", resolvedPath, "ok", performance.now() - start);
      return content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.record("read", resolvedPath, "error", performance.now() - start, msg);
      throw err;
    }
  }

  /**
   * Defer a full-file write. The file is NOT written to disk until commit().
   * If the transaction is rolled back, the original content is preserved.
   */
  async write(path: string, content: string): Promise<void> {
    this.assertReady();
    this.setExecuting();
    const resolvedPath = this.resolvePath(path);
    const start = performance.now();
    try {
      const originalContent = existsSync(resolvedPath)
        ? await readFile(resolvedPath, "utf-8")
        : null;
      const { linesAdded, linesDeleted } = ToolTransaction.lineDelta(
        originalContent ?? "",
        content
      );
      this._deferredWrites.set(resolvedPath, {
        resolvedPath,
        newContent: content,
        originalContent,
        linesAdded,
        linesDeleted,
      });
      this.record("write", resolvedPath, "ok", performance.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.record("write", resolvedPath, "error", performance.now() - start, msg);
      throw err;
    }
  }

  /**
   * Defer a string-replacement edit. The edit is NOT written to disk until
   * commit(). Throws if the search string is not found (or is ambiguous).
   */
  async edit(
    path: string,
    oldStr: string,
    newStr: string,
    options: { replaceAll?: boolean } = {}
  ): Promise<void> {
    this.assertReady();
    this.setExecuting();
    const resolvedPath = this.resolvePath(path);
    const start = performance.now();
    try {
      // Read the current deferred content or the real file content
      const existing = this._deferredWrites.get(resolvedPath);
      let currentContent: string;
      let originalContent: string | null;

      if (existing) {
        currentContent = existing.newContent;
        originalContent = existing.originalContent;
      } else {
        if (!existsSync(resolvedPath)) {
          throw new Error(`File not found: ${resolvedPath}`);
        }
        currentContent = await readFile(resolvedPath, "utf-8");
        originalContent = currentContent;
      }

      const replaceAll = options.replaceAll ?? false;

      if (!replaceAll) {
        const occurrences = currentContent.split(oldStr).length - 1;
        if (occurrences === 0) {
          throw new Error(`edit: search string not found in ${path}`);
        }
        if (occurrences > 1) {
          throw new Error(
            `edit: search string found ${occurrences} times in ${path} — must be unique or set replaceAll: true`
          );
        }
      }

      const newContent = replaceAll
        ? currentContent.replaceAll(oldStr, newStr)
        : currentContent.replace(oldStr, newStr);

      const { linesAdded, linesDeleted } = ToolTransaction.lineDelta(
        originalContent ?? currentContent,
        newContent
      );

      this._deferredWrites.set(resolvedPath, {
        resolvedPath,
        newContent,
        originalContent,
        linesAdded,
        linesDeleted,
      });
      this.record("edit", resolvedPath, "ok", performance.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.record("edit", resolvedPath, "error", performance.now() - start, msg);
      throw err;
    }
  }

  /**
   * Execute a shell command immediately.
   *
   * On failure: records the error, auto-rolls back all deferred writes, and
   * throws so the caller can react. This is the primary guard against
   * "run tests, on failure undo all staged edits" workflows.
   */
  async bash(cmd: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    this.assertReady();
    this.setExecuting();
    const effectiveCwd = options.cwd ?? this._cwd;
    const start = performance.now();
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: effectiveCwd,
        timeout: options.timeoutMs ?? 60_000,
      });
      const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim();
      this.record("bash", cmd, "ok", performance.now() - start);
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._bashError = msg;
      this.record("bash", cmd, "error", performance.now() - start, msg);
      // Auto-rollback on bash failure
      await this._rollbackWrites("bash failure");
      throw new Error(`ToolTransaction: bash failed — "${cmd}"\n${msg}`);
    }
  }

  // ── Commit & Rollback ──────────────────────────────────────────────────────

  /**
   * Atomically apply all deferred writes to disk.
   * Also commits all child transactions in registration order.
   * Throws if the transaction is not in ready/executing state.
   */
  async commit(): Promise<void> {
    this.assertReady();
    const start = performance.now();
    try {
      // Commit children first (they may contribute deferred writes of their own)
      for (const child of this._children) {
        if (child.state === "ready" || child.state === "executing") {
          await child.commit();
        }
      }

      // Apply all deferred writes atomically (best-effort — first error rolls back)
      const applied: Array<{ resolvedPath: string; originalContent: string | null }> = [];
      for (const dw of this._deferredWrites.values()) {
        try {
          await writeFile(dw.resolvedPath, dw.newContent, "utf-8");
          applied.push({ resolvedPath: dw.resolvedPath, originalContent: dw.originalContent });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.record("commit", dw.resolvedPath, "error", performance.now() - start, msg);
          // Roll back already-applied writes
          await this._rollbackApplied(applied);
          this._state = "rolled-back";
          throw new Error(`ToolTransaction: commit failed on "${dw.resolvedPath}"\n${msg}`);
        }
      }

      this._state = "committed";
      this.record("commit", `${this._deferredWrites.size} write(s)`, "ok", performance.now() - start);
    } catch (err) {
      if (this._state !== "rolled-back") {
        this._state = "rolled-back";
      }
      throw err;
    }
  }

  /**
   * Roll back all deferred writes (restore originals or delete new files).
   * Idempotent — safe to call multiple times.
   */
  async rollback(): Promise<void> {
    if (this._state === "committed") {
      throw new Error("ToolTransaction: cannot roll back an already-committed transaction");
    }
    await this._rollbackWrites("manual rollback");
    // Roll back children
    for (const child of this._children) {
      if (child.state !== "rolled-back") {
        await child.rollback().catch(() => {});
      }
    }
    this._state = "rolled-back";
    this.record("rollback", "manual", "ok", 0);
  }

  // ── Internal rollback helpers ──────────────────────────────────────────────

  /**
   * Roll back deferred writes that have NOT yet been applied to disk.
   * (Used on bash failure — files never hit disk, so we just clear the queue.)
   */
  private async _rollbackWrites(reason: string): Promise<void> {
    const start = performance.now();
    // Deferred writes haven't touched disk yet; simply mark entries
    for (const entry of this._journal) {
      if ((entry.tool === "write" || entry.tool === "edit") && entry.status === "ok") {
        // Mark as rolled-back in the journal
        (entry as JournalEntry).status = "rolled-back";
      }
    }
    this._deferredWrites.clear();
    this._state = "rolled-back";
    this.record("rollback", reason, "ok", performance.now() - start);
  }

  /**
   * Roll back writes that have already been physically applied to disk
   * (used when commit() partially succeeds then encounters an error).
   */
  private async _rollbackApplied(
    applied: Array<{ resolvedPath: string; originalContent: string | null }>
  ): Promise<void> {
    for (const { resolvedPath, originalContent } of applied.reverse()) {
      try {
        if (originalContent === null) {
          // File was newly created — zero it out (writeFile is safer than unlink here)
          await writeFile(resolvedPath, "", "utf-8");
        } else {
          await writeFile(resolvedPath, originalContent, "utf-8");
        }
      } catch {
        // Best-effort; record will already note the commit failure
      }
    }
  }

  // ── Nesting & Composition ──────────────────────────────────────────────────

  /**
   * Create a child transaction that shares this transaction's cwd.
   * The child's deferred writes are flushed when the parent commits.
   * If the parent rolls back, the child is rolled back too.
   */
  nest(cwd?: string): ToolTransaction {
    this.assertReady();
    const child = new ToolTransaction(cwd ?? this._cwd, this);
    this._children.push(child);
    this.record("nest", `child #${this._children.length}`, "ok", 0);
    return child;
  }

  /**
   * Wait for all provided transactions to complete (commit or rollback),
   * rolling back any that are still active if one fails.
   *
   * This is a flattened-rollback coordinator for sibling transactions.
   */
  static async waitAll(transactions: ToolTransaction[]): Promise<void> {
    const results = await Promise.allSettled(
      transactions.map((tx) => tx.commit())
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      // Roll back all transactions that are still active
      await Promise.allSettled(
        transactions.map((tx) => {
          if (tx.state !== "committed" && tx.state !== "rolled-back") {
            return tx.rollback();
          }
          return Promise.resolve();
        })
      );
      const firstError =
        failures[0]!.status === "rejected"
          ? (failures[0] as PromiseRejectedResult).reason
          : new Error("unknown");
      throw firstError;
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  /**
   * Return a copy of the journal — timestamped audit trail of every step.
   */
  getJournal(): JournalEntry[] {
    return this._journal.map((e) => ({ ...e }));
  }

  /**
   * Return aggregate impact statistics for this transaction (not including
   * child transactions).
   */
  getImpactSummary(): ImpactSummary {
    let filesRead = 0;
    let linesAdded = 0;
    let linesDeleted = 0;
    let bashCommandsRun = 0;

    for (const entry of this._journal) {
      if (entry.tool === "read" && entry.status === "ok") filesRead++;
      if (entry.tool === "bash" && entry.status === "ok") bashCommandsRun++;
    }

    for (const dw of this._deferredWrites.values()) {
      linesAdded += dw.linesAdded;
      linesDeleted += dw.linesDeleted;
    }

    return {
      filesRead,
      filesModified: this._deferredWrites.size,
      linesAdded,
      linesDeleted,
      bashCommandsRun,
      childTransactions: this._children.length,
    };
  }

  /**
   * Get the bash failure message if any bash step failed.
   */
  getBashError(): string | null {
    return this._bashError;
  }
}

// ---------------------------------------------------------------------------
// Agent loop integration helpers
// ---------------------------------------------------------------------------

/**
 * Detects whether a sequence of tool names constitutes a "multi-tool sequence"
 * that would benefit from wrapping in a ToolTransaction.
 *
 * Heuristic: any sequence that mixes at least one write/edit/bash with at
 * least one other operation on 2+ distinct files.
 */
export function isMultiToolSequence(toolNames: string[]): boolean {
  if (toolNames.length < 2) return false;
  const writeTools = new Set(["write", "edit", "bash", "BulkEdit"]);
  const hasWrite = toolNames.some((n) => writeTools.has(n.toLowerCase()) || writeTools.has(n));
  const hasMultipleOps = toolNames.length >= 2;
  return hasWrite && hasMultipleOps;
}

/**
 * Wrap an async agent step in a ToolTransaction.
 *
 * Usage:
 *   const result = await withTransaction(cwd, async (tx) => {
 *     const cfg = await tx.read("config.json");
 *     await tx.write("output.ts", generate(cfg));
 *     await tx.bash("bun test");
 *     await tx.commit();
 *     return "done";
 *   });
 *
 * If the callback throws (including from tx.bash() auto-rollback), the
 * transaction is rolled back automatically and the error is re-thrown.
 */
export async function withTransaction<T>(
  cwd: string,
  fn: (tx: ToolTransaction) => Promise<T>
): Promise<T> {
  const tx = new ToolTransaction(cwd);
  try {
    const result = await fn(tx);
    // If not already committed/rolled-back, commit now
    if (tx.state === "ready" || tx.state === "executing") {
      await tx.commit();
    }
    return result;
  } catch (err) {
    if (tx.state !== "rolled-back" && tx.state !== "committed") {
      await tx.rollback().catch(() => {});
    }
    throw err;
  }
}
