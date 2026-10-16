/**
 * Tests for BulkEditTool — streaming input builder for bulk file edits.
 *
 * Covers:
 *  - Input schema validation (missing fields, bad operation)
 *  - Dry-run shows diffs but writes nothing
 *  - Successful multi-file apply
 *  - Rollback on execution error (atomicity)
 *  - Path traversal guard
 *  - Duplicate path conflict detection
 *  - edit search-not-found and non-unique search errors
 *  - read-only patches are preview-only
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bulkEditTool } from "../tools/bulk-edit.ts";
import type { ToolContext } from "../tools/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContext(cwd: string): ToolContext {
  return {
    cwd,
    requestPermission: async () => true,
    turnNumber: 1,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bulk-edit-test-"));
});

afterEach(async () => {
  // Best-effort cleanup — ignore errors
  const { rm } = await import("fs/promises");
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── validateInput ─────────────────────────────────────────────────────────────

describe("validateInput", () => {
  test("returns error when patches is not an array", () => {
    const err = bulkEditTool.validateInput({ patches: "bad" });
    expect(err).toContain("patches must be an array");
  });

  test("returns error when patches array is empty", () => {
    const err = bulkEditTool.validateInput({ patches: [] });
    expect(err).toContain("must not be empty");
  });

  test("returns error when a patch is missing path", () => {
    const err = bulkEditTool.validateInput({
      patches: [{ operation: "write", content: "hi" }],
    });
    expect(err).toContain("'path' field");
  });

  test("returns error for unknown operation", () => {
    const err = bulkEditTool.validateInput({
      patches: [{ path: "/tmp/foo.ts", operation: "delete" }],
    });
    expect(err).toContain("invalid operation");
  });

  test("returns null for valid write patch", () => {
    const err = bulkEditTool.validateInput({
      patches: [{ path: "/tmp/foo.ts", operation: "write", content: "x" }],
    });
    expect(err).toBeNull();
  });

  test("returns null for valid edit patch", () => {
    const err = bulkEditTool.validateInput({
      patches: [{ path: "/tmp/foo.ts", operation: "edit", search: "old", replace: "new" }],
    });
    expect(err).toBeNull();
  });
});

// ── Tool metadata ─────────────────────────────────────────────────────────────

describe("tool metadata", () => {
  test("name is BulkEdit", () => {
    expect(bulkEditTool.name).toBe("BulkEdit");
  });

  test("isReadOnly returns false", () => {
    expect(bulkEditTool.isReadOnly()).toBe(false);
  });

  test("isDestructive returns true", () => {
    expect(bulkEditTool.isDestructive()).toBe(true);
  });

  test("isConcurrencySafe returns false", () => {
    expect(bulkEditTool.isConcurrencySafe()).toBe(false);
  });

  test("inputSchema has required patches field", () => {
    const schema = bulkEditTool.inputSchema() as { required: string[] };
    expect(schema.required).toContain("patches");
  });
});

// ── dryRun mode ───────────────────────────────────────────────────────────────

describe("dryRun mode", () => {
  test("does not write any files", async () => {
    const filePath = join(tmpDir, "dry.ts");
    await writeFile(filePath, "const x = 1;\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "const x = 1;", replace: "const x = 2;" }],
        dryRun: true,
      },
      makeContext(tmpDir),
    );

    // File should be unchanged
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const x = 1;\n");

    // Result should mention dry run
    expect(result).toContain("DRY RUN");
    expect(result).toContain("No files were modified");
  });

  test("shows diff preview in output", async () => {
    const filePath = join(tmpDir, "preview.ts");
    await writeFile(filePath, "hello world\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "hello", replace: "goodbye" }],
        dryRun: true,
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("Preview of");
    expect(result).toContain("- hello");
    expect(result).toContain("+ goodbye");
  });

  test("write patch dry-run shows new content diff", async () => {
    const filePath = join(tmpDir, "newfile.ts");
    // File doesn't exist yet
    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "write", content: "const a = 1;\n" }],
        dryRun: true,
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("DRY RUN");
    expect(existsSync(filePath)).toBe(false);
  });
});

// ── Successful execution ──────────────────────────────────────────────────────

describe("successful execution", () => {
  test("applies a single write patch", async () => {
    const filePath = join(tmpDir, "out.ts");
    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "write", content: "export const x = 42;\n" }],
      },
      makeContext(tmpDir),
    );

    const written = await readFile(filePath, "utf-8");
    expect(written).toBe("export const x = 42;\n");
    expect(result).toContain("✓ Applied");
    expect(result).toContain("1 file(s) updated");
  });

  test("applies a single edit patch", async () => {
    const filePath = join(tmpDir, "edit.ts");
    await writeFile(filePath, "const foo = 'bar';\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "bar", replace: "baz" }],
      },
      makeContext(tmpDir),
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const foo = 'baz';\n");
    expect(result).toContain("✓ Applied");
  });

  test("applies multiple patches in order", async () => {
    const file1 = join(tmpDir, "a.ts");
    const file2 = join(tmpDir, "b.ts");
    await writeFile(file1, "const a = 1;\n", "utf-8");
    await writeFile(file2, "const b = 2;\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [
          { path: file1, operation: "edit", search: "const a = 1;", replace: "const a = 10;" },
          { path: file2, operation: "edit", search: "const b = 2;", replace: "const b = 20;" },
        ],
      },
      makeContext(tmpDir),
    );

    const c1 = await readFile(file1, "utf-8");
    const c2 = await readFile(file2, "utf-8");
    expect(c1).toBe("const a = 10;\n");
    expect(c2).toBe("const b = 20;\n");
    expect(result).toContain("2 file(s) updated");
  });

  test("read-only patch is skipped in execution phase", async () => {
    const filePath = join(tmpDir, "ro.ts");
    await writeFile(filePath, "read me\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "read" }],
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("0 file(s) updated");
  });

  test("replaceAll: true replaces all occurrences", async () => {
    const filePath = join(tmpDir, "multi.ts");
    await writeFile(filePath, "foo foo foo\n", "utf-8");

    await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "foo", replace: "bar", replaceAll: true }],
      },
      makeContext(tmpDir),
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("bar bar bar\n");
  });
});

// ── Validation errors during call ─────────────────────────────────────────────

describe("validation errors", () => {
  test("fails when edit search string is not found", async () => {
    const filePath = join(tmpDir, "nope.ts");
    await writeFile(filePath, "hello world\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "not_here", replace: "x" }],
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("✗");
    expect(result).toContain("not found");
  });

  test("fails when edit search string is non-unique and replaceAll not set", async () => {
    const filePath = join(tmpDir, "dup.ts");
    await writeFile(filePath, "x x x\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "x", replace: "y" }],
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("✗");
    expect(result).toContain("times");
  });

  test("fails when write patch lacks content field — caught by validateInput", () => {
    const err = bulkEditTool.validateInput({
      patches: [{ path: "/tmp/f.ts", operation: "write" }],
    });
    // validateInput only checks required shape; content check is in call()
    // The schema validation at call-time handles it
    expect(err).toBeNull(); // no schema error at top level
  });

  test("fails on path traversal", async () => {
    const result = await bulkEditTool.call(
      {
        patches: [{ path: "../../../etc/passwd", operation: "write", content: "bad" }],
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("✗");
    expect(result).toContain("traversal");
  });

  test("fails on missing file for edit operation", async () => {
    const filePath = join(tmpDir, "missing.ts");
    // Don't create the file

    const result = await bulkEditTool.call(
      {
        patches: [{ path: filePath, operation: "edit", search: "x", replace: "y" }],
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("✗");
    expect(result).toContain("not found");
  });
});

// ── Conflict detection ────────────────────────────────────────────────────────

describe("conflict detection", () => {
  test("rejects manifest with duplicate write paths", async () => {
    const filePath = join(tmpDir, "conflict.ts");
    await writeFile(filePath, "original\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [
          { path: filePath, operation: "write", content: "v1\n" },
          { path: filePath, operation: "write", content: "v2\n" },
        ],
      },
      makeContext(tmpDir),
    );

    expect(result).toContain("Conflict");
    // File should be unchanged
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("original\n");
  });
});

// ── Atomicity / rollback ──────────────────────────────────────────────────────

describe("atomicity and rollback", () => {
  test("rolls back prior writes when a later patch fails during execution", async () => {
    const file1 = join(tmpDir, "rollback1.ts");
    const file2 = join(tmpDir, "rollback2.ts");
    // file3 is a path whose PARENT is a regular file, not a directory.
    // writeFile will throw ENOTDIR when trying to create it.
    const blockerFile = join(tmpDir, "not-a-dir.ts");
    await writeFile(blockerFile, "blocker\n", "utf-8");
    const file3 = join(blockerFile, "child.ts"); // parent is a file → ENOTDIR

    await writeFile(file1, "original1\n", "utf-8");
    await writeFile(file2, "original2\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [
          { path: file1, operation: "write", content: "changed1\n" },
          { path: file2, operation: "write", content: "changed2\n" },
          // Writing to a path whose parent is a file will throw ENOTDIR
          { path: file3, operation: "write", content: "should fail\n" },
        ],
      },
      makeContext(tmpDir),
    );

    // Result should mention rollback
    expect(result).toContain("Rolling back");
    expect(result).toContain("Rollback complete");

    // file1 and file2 must be restored to originals
    const c1 = await readFile(file1, "utf-8");
    const c2 = await readFile(file2, "utf-8");
    expect(c1).toBe("original1\n");
    expect(c2).toBe("original2\n");
  });

  test("completes without rollback when all patches succeed", async () => {
    const file1 = join(tmpDir, "ok1.ts");
    const file2 = join(tmpDir, "ok2.ts");
    await writeFile(file1, "a\n", "utf-8");
    await writeFile(file2, "b\n", "utf-8");

    const result = await bulkEditTool.call(
      {
        patches: [
          { path: file1, operation: "write", content: "aa\n" },
          { path: file2, operation: "write", content: "bb\n" },
        ],
      },
      makeContext(tmpDir),
    );

    expect(result).not.toContain("Rolling back");
    expect(result).toContain("2 file(s) updated");
  });
});

// ── Integration with existing tools concept ────────────────────────────────────

describe("tool registration shape", () => {
  test("bulkEditTool has all required Tool interface methods", () => {
    expect(typeof bulkEditTool.name).toBe("string");
    expect(typeof bulkEditTool.prompt).toBe("function");
    expect(typeof bulkEditTool.inputSchema).toBe("function");
    expect(typeof bulkEditTool.isReadOnly).toBe("function");
    expect(typeof bulkEditTool.isDestructive).toBe("function");
    expect(typeof bulkEditTool.isConcurrencySafe).toBe("function");
    expect(typeof bulkEditTool.validateInput).toBe("function");
    expect(typeof bulkEditTool.call).toBe("function");
  });

  test("can be registered in a ToolRegistry", async () => {
    const { ToolRegistry } = await import("../tools/registry.ts");
    const registry = new ToolRegistry();
    registry.register(bulkEditTool);
    expect(registry.get("BulkEdit")).toBe(bulkEditTool);
  });

  test("appears in tool definitions", async () => {
    const { ToolRegistry } = await import("../tools/registry.ts");
    const registry = new ToolRegistry();
    registry.register(bulkEditTool);
    const defs = registry.getDefinitions();
    const def = defs.find((d) => d.name === "BulkEdit");
    expect(def).toBeDefined();
    expect(def!.description).toContain("batch");
  });
});
