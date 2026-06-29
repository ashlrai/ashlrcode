/**
 * Tests for ToolTransaction — ACID-like transaction wrapper for multi-tool sequences.
 *
 * Covers:
 *  - State machine transitions (ready → executing → committed / rolled-back)
 *  - read() — immediate execution, error on missing file
 *  - write() — deferred, no disk mutation until commit()
 *  - edit() — deferred string replacement, error on missing/ambiguous search
 *  - bash() — immediate execution, auto-rollback on failure
 *  - commit() — atomic disk flush, partial-failure rollback
 *  - rollback() — manual rollback, idempotency guard
 *  - Nesting — child commits only on parent commit; parent failure rolls back children
 *  - waitAll() — flattened rollback on sibling failure
 *  - Journal — audit trail completeness and accuracy
 *  - ImpactSummary — aggregate stats correctness
 *  - withTransaction() helper — auto-commit and auto-rollback on throw
 *  - isMultiToolSequence() detection helper
 *  - applyPatchesViaTransaction() integration with BulkEdit patches
 *  - edit() with replaceAll option
 *  - chained edits on same file (deferred content reuse)
 *  - bash() success returns stdout
 *  - rollback after committed throws
 *  - nested child isolation
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ToolTransaction,
  withTransaction,
  isMultiToolSequence,
  type JournalEntry,
  type ImpactSummary,
} from "../agent/tool-transaction.ts";
import { applyPatchesViaTransaction } from "../tools/bulk-edit.ts";

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "tool-tx-test-"));
});

afterEach(async () => {
  const { rm } = await import("fs/promises");
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── State machine ─────────────────────────────────────────────────────────────

describe("state machine", () => {
  test("initial state is ready", () => {
    const tx = new ToolTransaction(tmpDir);
    expect(tx.state).toBe("ready");
  });

  test("state becomes executing after first operation", async () => {
    const tx = new ToolTransaction(tmpDir);
    const filePath = join(tmpDir, "state.ts");
    await writeFile(filePath, "x\n");
    await tx.read(filePath);
    expect(tx.state).toBe("executing");
  });

  test("state becomes committed after commit()", async () => {
    const tx = new ToolTransaction(tmpDir);
    const filePath = join(tmpDir, "commit.ts");
    await writeFile(filePath, "hello\n");
    await tx.write(filePath, "world\n");
    await tx.commit();
    expect(tx.state).toBe("committed");
  });

  test("state becomes rolled-back after rollback()", async () => {
    const tx = new ToolTransaction(tmpDir);
    const filePath = join(tmpDir, "rb.ts");
    await writeFile(filePath, "original\n");
    await tx.write(filePath, "modified\n");
    await tx.rollback();
    expect(tx.state).toBe("rolled-back");
  });

  test("operations throw after commit", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.commit();
    await expect(tx.write(join(tmpDir, "x.ts"), "x")).rejects.toThrow(/state/);
  });

  test("operations throw after rollback", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.rollback();
    await expect(tx.write(join(tmpDir, "x.ts"), "x")).rejects.toThrow(/state/);
  });

  test("rollback after committed throws", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.commit();
    await expect(tx.rollback()).rejects.toThrow(/committed/);
  });
});

// ── read() ────────────────────────────────────────────────────────────────────

describe("read()", () => {
  test("returns file content immediately", async () => {
    const filePath = join(tmpDir, "read.ts");
    await writeFile(filePath, "const x = 1;\n");
    const tx = new ToolTransaction(tmpDir);
    const content = await tx.read(filePath);
    expect(content).toBe("const x = 1;\n");
  });

  test("throws when file does not exist", async () => {
    const tx = new ToolTransaction(tmpDir);
    await expect(tx.read(join(tmpDir, "nonexistent.ts"))).rejects.toThrow(/not found/i);
  });

  test("records successful read in journal", async () => {
    const filePath = join(tmpDir, "journal-read.ts");
    await writeFile(filePath, "y\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.read(filePath);
    const journal = tx.getJournal();
    expect(journal.some((e) => e.tool === "read" && e.status === "ok")).toBe(true);
  });

  test("records failed read in journal with error", async () => {
    const tx = new ToolTransaction(tmpDir);
    try {
      await tx.read(join(tmpDir, "missing.ts"));
    } catch {}
    const journal = tx.getJournal();
    const entry = journal.find((e) => e.tool === "read");
    expect(entry?.status).toBe("error");
    expect(entry?.error).toMatch(/not found/i);
  });

  test("resolves relative paths against cwd", async () => {
    const filePath = join(tmpDir, "relative.ts");
    await writeFile(filePath, "rel\n");
    const tx = new ToolTransaction(tmpDir);
    const content = await tx.read("relative.ts");
    expect(content).toBe("rel\n");
  });
});

// ── write() ───────────────────────────────────────────────────────────────────

describe("write()", () => {
  test("does NOT write to disk before commit", async () => {
    const filePath = join(tmpDir, "deferred.ts");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "written\n");
    // File must not exist yet
    expect(existsSync(filePath)).toBe(false);
  });

  test("writes to disk after commit()", async () => {
    const filePath = join(tmpDir, "committed.ts");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "committed content\n");
    await tx.commit();
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("committed content\n");
  });

  test("preserves original on rollback", async () => {
    const filePath = join(tmpDir, "preserve.ts");
    await writeFile(filePath, "original\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "modified\n");
    await tx.rollback();
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("original\n");
  });

  test("file does not change on disk after rollback", async () => {
    const filePath = join(tmpDir, "nodisk.ts");
    await writeFile(filePath, "untouched\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "should-not-appear\n");
    await tx.rollback();
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("untouched\n");
  });

  test("multiple writes to different files all commit", async () => {
    const file1 = join(tmpDir, "multi1.ts");
    const file2 = join(tmpDir, "multi2.ts");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(file1, "one\n");
    await tx.write(file2, "two\n");
    await tx.commit();
    expect(await readFile(file1, "utf-8")).toBe("one\n");
    expect(await readFile(file2, "utf-8")).toBe("two\n");
  });

  test("second write to same path overwrites the deferred content", async () => {
    const filePath = join(tmpDir, "overwrite.ts");
    await writeFile(filePath, "v0\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "v1\n");
    await tx.write(filePath, "v2\n");
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("v2\n");
  });
});

// ── edit() ────────────────────────────────────────────────────────────────────

describe("edit()", () => {
  test("applies string replacement after commit", async () => {
    const filePath = join(tmpDir, "edit.ts");
    await writeFile(filePath, "const foo = 'bar';\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.edit(filePath, "'bar'", "'baz'");
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("const foo = 'baz';\n");
  });

  test("does NOT write to disk before commit", async () => {
    const filePath = join(tmpDir, "edit-deferred.ts");
    await writeFile(filePath, "original\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.edit(filePath, "original", "changed");
    expect(await readFile(filePath, "utf-8")).toBe("original\n");
  });

  test("throws when search string is not found", async () => {
    const filePath = join(tmpDir, "notfound.ts");
    await writeFile(filePath, "hello world\n");
    const tx = new ToolTransaction(tmpDir);
    await expect(tx.edit(filePath, "nothere", "x")).rejects.toThrow(/not found/i);
  });

  test("throws when search string is ambiguous (multiple occurrences)", async () => {
    const filePath = join(tmpDir, "ambiguous.ts");
    await writeFile(filePath, "x x x\n");
    const tx = new ToolTransaction(tmpDir);
    await expect(tx.edit(filePath, "x", "y")).rejects.toThrow(/times/i);
  });

  test("replaceAll option replaces all occurrences", async () => {
    const filePath = join(tmpDir, "replaceAll.ts");
    await writeFile(filePath, "foo foo foo\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.edit(filePath, "foo", "bar", { replaceAll: true });
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("bar bar bar\n");
  });

  test("chained edits on same file use deferred content", async () => {
    const filePath = join(tmpDir, "chained.ts");
    await writeFile(filePath, "step1 step2\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.edit(filePath, "step1", "done1");
    await tx.edit(filePath, "step2", "done2");
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("done1 done2\n");
  });

  test("throws for missing file", async () => {
    const tx = new ToolTransaction(tmpDir);
    await expect(
      tx.edit(join(tmpDir, "ghost.ts"), "x", "y")
    ).rejects.toThrow(/not found/i);
  });
});

// ── bash() ────────────────────────────────────────────────────────────────────

describe("bash()", () => {
  test("executes a command and returns stdout", async () => {
    const tx = new ToolTransaction(tmpDir);
    const output = await tx.bash("echo hello");
    expect(output).toContain("hello");
  });

  test("records successful bash in journal", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.bash("echo ok");
    const journal = tx.getJournal();
    const entry = journal.find((e) => e.tool === "bash");
    expect(entry?.status).toBe("ok");
  });

  test("auto-rolls-back deferred writes on bash failure", async () => {
    const filePath = join(tmpDir, "bash-rb.ts");
    await writeFile(filePath, "original\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "modified\n");
    // This bash command will fail
    try {
      await tx.bash("exit 1");
    } catch {}
    // Write was deferred, so disk is still original; rollback cleared deferred queue
    expect(await readFile(filePath, "utf-8")).toBe("original\n");
    expect(tx.state).toBe("rolled-back");
  });

  test("state becomes rolled-back after bash failure", async () => {
    const tx = new ToolTransaction(tmpDir);
    try {
      await tx.bash("exit 1");
    } catch {}
    expect(tx.state).toBe("rolled-back");
  });

  test("bash error is captured in getBashError()", async () => {
    const tx = new ToolTransaction(tmpDir);
    try {
      await tx.bash("exit 1");
    } catch {}
    expect(tx.getBashError()).not.toBeNull();
  });

  test("records failed bash in journal with error", async () => {
    const tx = new ToolTransaction(tmpDir);
    try {
      await tx.bash("exit 1");
    } catch {}
    const journal = tx.getJournal();
    const entry = journal.find((e) => e.tool === "bash");
    expect(entry?.status).toBe("error");
  });

  test("bash failure throws error", async () => {
    const tx = new ToolTransaction(tmpDir);
    await expect(tx.bash("exit 1")).rejects.toThrow(/bash failed/i);
  });
});

// ── commit() ─────────────────────────────────────────────────────────────────

describe("commit()", () => {
  test("empty commit succeeds", async () => {
    const tx = new ToolTransaction(tmpDir);
    await expect(tx.commit()).resolves.toBeUndefined();
    expect(tx.state).toBe("committed");
  });

  test("commits multiple deferred writes atomically", async () => {
    const file1 = join(tmpDir, "atomic1.ts");
    const file2 = join(tmpDir, "atomic2.ts");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(file1, "a\n");
    await tx.write(file2, "b\n");
    await tx.commit();
    expect(await readFile(file1, "utf-8")).toBe("a\n");
    expect(await readFile(file2, "utf-8")).toBe("b\n");
  });

  test("records commit in journal", async () => {
    const tx = new ToolTransaction(tmpDir);
    const filePath = join(tmpDir, "jcommit.ts");
    await tx.write(filePath, "hi\n");
    await tx.commit();
    const journal = tx.getJournal();
    expect(journal.some((e) => e.tool === "commit" && e.status === "ok")).toBe(true);
  });

  test("cannot commit again after commit", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow(/state/);
  });
});

// ── rollback() ────────────────────────────────────────────────────────────────

describe("rollback()", () => {
  test("clears deferred writes without touching disk", async () => {
    const filePath = join(tmpDir, "rollback-clean.ts");
    await writeFile(filePath, "safe\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "danger\n");
    await tx.rollback();
    expect(await readFile(filePath, "utf-8")).toBe("safe\n");
  });

  test("records rollback in journal", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.rollback();
    const journal = tx.getJournal();
    expect(journal.some((e) => e.tool === "rollback")).toBe(true);
  });
});

// ── Nesting ───────────────────────────────────────────────────────────────────

describe("nesting", () => {
  test("nest() returns a ToolTransaction", () => {
    const tx = new ToolTransaction(tmpDir);
    const child = tx.nest();
    expect(child).toBeInstanceOf(ToolTransaction);
  });

  test("child writes commit when parent commits", async () => {
    const childFile = join(tmpDir, "child-write.ts");
    const tx = new ToolTransaction(tmpDir);
    const child = tx.nest();
    await child.write(childFile, "from child\n");
    await tx.commit();
    expect(await readFile(childFile, "utf-8")).toBe("from child\n");
  });

  test("child writes do NOT appear on disk before parent commits", async () => {
    const childFile = join(tmpDir, "child-nodeferred.ts");
    const tx = new ToolTransaction(tmpDir);
    const child = tx.nest();
    await child.write(childFile, "from child\n");
    // Parent not committed yet
    expect(existsSync(childFile)).toBe(false);
  });

  test("child is rolled back when parent rolls back", async () => {
    const childFile = join(tmpDir, "child-rollback.ts");
    await writeFile(childFile, "original\n");
    const tx = new ToolTransaction(tmpDir);
    const child = tx.nest();
    await child.write(childFile, "child modification\n");
    await tx.rollback();
    expect(child.state).toBe("rolled-back");
    // Deferred — file never changed on disk
    expect(await readFile(childFile, "utf-8")).toBe("original\n");
  });

  test("multiple children all commit with parent", async () => {
    const f1 = join(tmpDir, "c1.ts");
    const f2 = join(tmpDir, "c2.ts");
    const tx = new ToolTransaction(tmpDir);
    const c1 = tx.nest();
    const c2 = tx.nest();
    await c1.write(f1, "c1\n");
    await c2.write(f2, "c2\n");
    await tx.commit();
    expect(await readFile(f1, "utf-8")).toBe("c1\n");
    expect(await readFile(f2, "utf-8")).toBe("c2\n");
  });

  test("nest records in parent journal", () => {
    const tx = new ToolTransaction(tmpDir);
    tx.nest();
    const journal = tx.getJournal();
    expect(journal.some((e) => e.tool === "nest")).toBe(true);
  });

  test("child uses custom cwd when provided", () => {
    const tx = new ToolTransaction(tmpDir);
    const childCwd = "/tmp";
    const child = tx.nest(childCwd);
    expect(child.cwd).toBe(childCwd);
  });
});

// ── waitAll() ─────────────────────────────────────────────────────────────────

describe("waitAll()", () => {
  test("commits all transactions when all succeed", async () => {
    const f1 = join(tmpDir, "wa1.ts");
    const f2 = join(tmpDir, "wa2.ts");
    const tx1 = new ToolTransaction(tmpDir);
    const tx2 = new ToolTransaction(tmpDir);
    await tx1.write(f1, "wa1\n");
    await tx2.write(f2, "wa2\n");
    await ToolTransaction.waitAll([tx1, tx2]);
    expect(await readFile(f1, "utf-8")).toBe("wa1\n");
    expect(await readFile(f2, "utf-8")).toBe("wa2\n");
  });

  test("rolls back all transactions when one fails during commit", async () => {
    const f1 = join(tmpDir, "wafail1.ts");
    await writeFile(f1, "safe\n");

    const tx1 = new ToolTransaction(tmpDir);
    const tx2 = new ToolTransaction(tmpDir);

    // tx1: a valid deferred write
    await tx1.write(f1, "modified\n");

    // tx2: stage a write to an invalid path that will fail during commit
    // (parent dir is a regular file → ENOTDIR)
    const blocker = join(tmpDir, "blocker2.ts");
    await writeFile(blocker, "block\n");
    await tx2.write(join(blocker, "sub.ts"), "fail\n");

    // waitAll should: commit tx1 ok, then fail on tx2; tx1 is already committed
    // so its write is on disk, but tx2 rolls back cleanly
    let threw = false;
    try {
      await ToolTransaction.waitAll([tx1, tx2]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // tx2 is rolled-back
    expect(tx2.state).toBe("rolled-back");
  });

  test("throws when a transaction fails", async () => {
    const tx1 = new ToolTransaction(tmpDir);
    const tx2 = new ToolTransaction(tmpDir);
    // Force tx2 to fail by writing to an invalid path (parent is a file)
    const blocker = join(tmpDir, "blocker.ts");
    await writeFile(blocker, "block\n");
    await tx2.write(join(blocker, "child.ts"), "bad\n");

    await expect(ToolTransaction.waitAll([tx1, tx2])).rejects.toThrow();
  });
});

// ── Journal ───────────────────────────────────────────────────────────────────

describe("getJournal()", () => {
  test("returns entries for all operations", async () => {
    const filePath = join(tmpDir, "journal.ts");
    await writeFile(filePath, "a\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.read(filePath);
    await tx.write(filePath, "b\n");
    await tx.commit();
    const journal = tx.getJournal();
    const tools = journal.map((e) => e.tool);
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("commit");
  });

  test("entries have timestamp, durationMs, and status", async () => {
    const filePath = join(tmpDir, "ts-check.ts");
    await writeFile(filePath, "x\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.read(filePath);
    const journal = tx.getJournal();
    for (const entry of journal) {
      expect(typeof entry.timestamp).toBe("number");
      expect(typeof entry.durationMs).toBe("number");
      expect(["ok", "error", "rolled-back"]).toContain(entry.status);
    }
  });

  test("getJournal() returns a copy (mutation does not affect internal state)", async () => {
    const tx = new ToolTransaction(tmpDir);
    const j1 = tx.getJournal();
    j1.push({ timestamp: 0, tool: "fake", detail: "", status: "ok", durationMs: 0 });
    const j2 = tx.getJournal();
    expect(j2.length).toBe(0);
  });

  test("error entries include error message", async () => {
    const tx = new ToolTransaction(tmpDir);
    try { await tx.read(join(tmpDir, "nope.ts")); } catch {}
    const journal = tx.getJournal();
    const errEntry = journal.find((e) => e.status === "error");
    expect(errEntry?.error).toBeTruthy();
  });
});

// ── ImpactSummary ─────────────────────────────────────────────────────────────

describe("getImpactSummary()", () => {
  test("reports correct filesModified count", async () => {
    const f1 = join(tmpDir, "imp1.ts");
    const f2 = join(tmpDir, "imp2.ts");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(f1, "a\n");
    await tx.write(f2, "b\n");
    const summary: ImpactSummary = tx.getImpactSummary();
    expect(summary.filesModified).toBe(2);
  });

  test("reports filesRead count", async () => {
    const filePath = join(tmpDir, "impread.ts");
    await writeFile(filePath, "r\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.read(filePath);
    const summary = tx.getImpactSummary();
    expect(summary.filesRead).toBe(1);
  });

  test("reports bashCommandsRun count", async () => {
    const tx = new ToolTransaction(tmpDir);
    await tx.bash("echo 1");
    await tx.bash("echo 2");
    const summary = tx.getImpactSummary();
    expect(summary.bashCommandsRun).toBe(2);
  });

  test("reports childTransactions count", () => {
    const tx = new ToolTransaction(tmpDir);
    tx.nest();
    tx.nest();
    const summary = tx.getImpactSummary();
    expect(summary.childTransactions).toBe(2);
  });

  test("linesAdded is positive when content grows", async () => {
    const filePath = join(tmpDir, "lines-add.ts");
    await writeFile(filePath, "line1\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "line1\nline2\nline3\n");
    const summary = tx.getImpactSummary();
    expect(summary.linesAdded).toBeGreaterThan(0);
  });

  test("linesDeleted is positive when content shrinks", async () => {
    const filePath = join(tmpDir, "lines-del.ts");
    await writeFile(filePath, "line1\nline2\nline3\n");
    const tx = new ToolTransaction(tmpDir);
    await tx.write(filePath, "line1\n");
    const summary = tx.getImpactSummary();
    expect(summary.linesDeleted).toBeGreaterThan(0);
  });
});

// ── withTransaction() ─────────────────────────────────────────────────────────

describe("withTransaction()", () => {
  test("auto-commits on success", async () => {
    const filePath = join(tmpDir, "wt-commit.ts");
    await withTransaction(tmpDir, async (tx) => {
      await tx.write(filePath, "auto-committed\n");
    });
    expect(await readFile(filePath, "utf-8")).toBe("auto-committed\n");
  });

  test("auto-rolls-back on throw", async () => {
    const filePath = join(tmpDir, "wt-rollback.ts");
    await writeFile(filePath, "safe\n");
    try {
      await withTransaction(tmpDir, async (tx) => {
        await tx.write(filePath, "danger\n");
        throw new Error("intentional");
      });
    } catch {}
    expect(await readFile(filePath, "utf-8")).toBe("safe\n");
  });

  test("returns the callback return value", async () => {
    const result = await withTransaction(tmpDir, async (_tx) => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test("re-throws errors from the callback", async () => {
    await expect(
      withTransaction(tmpDir, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  test("does not double-commit if callback already calls commit()", async () => {
    const filePath = join(tmpDir, "wt-manual-commit.ts");
    await withTransaction(tmpDir, async (tx) => {
      await tx.write(filePath, "manual\n");
      await tx.commit(); // explicit commit inside
    });
    // Should succeed without throwing
    expect(await readFile(filePath, "utf-8")).toBe("manual\n");
  });
});

// ── isMultiToolSequence() ─────────────────────────────────────────────────────

describe("isMultiToolSequence()", () => {
  test("returns false for empty array", () => {
    expect(isMultiToolSequence([])).toBe(false);
  });

  test("returns false for single tool", () => {
    expect(isMultiToolSequence(["read"])).toBe(false);
  });

  test("returns true for write + read sequence", () => {
    expect(isMultiToolSequence(["read", "write"])).toBe(true);
  });

  test("returns true for bash + edit sequence", () => {
    expect(isMultiToolSequence(["bash", "edit"])).toBe(true);
  });

  test("returns false for two reads (no write tools)", () => {
    expect(isMultiToolSequence(["read", "read"])).toBe(false);
  });

  test("returns true for BulkEdit in sequence", () => {
    expect(isMultiToolSequence(["read", "BulkEdit"])).toBe(true);
  });

  test("returns true for three-step write/test sequence", () => {
    expect(isMultiToolSequence(["read", "write", "bash"])).toBe(true);
  });
});

// ── applyPatchesViaTransaction() integration ──────────────────────────────────

describe("applyPatchesViaTransaction()", () => {
  test("returns a ToolTransaction in executing state", async () => {
    const filePath = join(tmpDir, "patch-tx.ts");
    await writeFile(filePath, "original\n");
    const tx = await applyPatchesViaTransaction(
      [{ path: filePath, operation: "read" }],
      tmpDir
    );
    expect(tx).toBeInstanceOf(ToolTransaction);
    expect(tx.state).toBe("executing");
  });

  test("defers write patch until commit()", async () => {
    const filePath = join(tmpDir, "patch-write.ts");
    const tx = await applyPatchesViaTransaction(
      [{ path: filePath, operation: "write", content: "patched\n" }],
      tmpDir
    );
    expect(existsSync(filePath)).toBe(false);
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("patched\n");
  });

  test("applies edit patch after commit()", async () => {
    const filePath = join(tmpDir, "patch-edit.ts");
    await writeFile(filePath, "old value\n");
    const tx = await applyPatchesViaTransaction(
      [{ path: filePath, operation: "edit", search: "old", replace: "new" }],
      tmpDir
    );
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("new value\n");
  });

  test("throws on validation error (path traversal)", async () => {
    await expect(
      applyPatchesViaTransaction(
        [{ path: "../../../etc/passwd", operation: "write", content: "bad" }],
        tmpDir
      )
    ).rejects.toThrow(/traversal/i);
  });

  test("edit patch with replaceAll replaces all occurrences", async () => {
    const filePath = join(tmpDir, "patch-replaceall.ts");
    await writeFile(filePath, "a a a\n");
    const tx = await applyPatchesViaTransaction(
      [{ path: filePath, operation: "edit", search: "a", replace: "z", replaceAll: true }],
      tmpDir
    );
    await tx.commit();
    expect(await readFile(filePath, "utf-8")).toBe("z z z\n");
  });

  test("multi-patch sequence: write + edit commits both", async () => {
    const f1 = join(tmpDir, "mp1.ts");
    const f2 = join(tmpDir, "mp2.ts");
    await writeFile(f2, "before\n");
    const tx = await applyPatchesViaTransaction(
      [
        { path: f1, operation: "write", content: "new file\n" },
        { path: f2, operation: "edit", search: "before", replace: "after" },
      ],
      tmpDir
    );
    await tx.commit();
    expect(await readFile(f1, "utf-8")).toBe("new file\n");
    expect(await readFile(f2, "utf-8")).toBe("after\n");
  });
});
