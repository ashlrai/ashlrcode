/**
 * Smoke test for buildMinimalCoordinatorContext — the extracted REPL init
 * that `ac-autopilot --until-empty` uses for real coordinator dispatch.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  buildMinimalCoordinatorContext,
  registerStandardTools,
} from "../agent/bootstrap.ts";
import { ToolRegistry } from "../tools/registry.ts";

let tmpCfg: string;

beforeEach(() => {
  tmpCfg = mkdtempSync(join(tmpdir(), "ashlrcode-bootstrap-"));
  setConfigDirForTests(tmpCfg);
});

afterEach(() => {
  setConfigDirForTests(null);
  try {
    rmSync(tmpCfg, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("buildMinimalCoordinatorContext", () => {
  test("returns expected shape with all fields populated", async () => {
    const ctx = await buildMinimalCoordinatorContext(process.cwd(), {
      systemPromptOverride: "test prompt",
    });

    expect(ctx.router).toBeDefined();
    expect(ctx.toolRegistry).toBeDefined();
    expect(ctx.toolContext).toBeDefined();
    expect(ctx.toolContext.cwd).toBe(process.cwd());
    expect(ctx.systemPrompt).toBe("test prompt");
    expect(typeof ctx.cleanup).toBe("function");

    // Tool registry should have the standard set — at least bash + file tools.
    const tools = ctx.toolRegistry.getAll().map((t) => t.name);
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");

    // cleanup should be callable and idempotent.
    await ctx.cleanup();
    await ctx.cleanup();
  });

  test("yolo mode is default (unattended autopilot-safe)", async () => {
    const ctx = await buildMinimalCoordinatorContext(process.cwd(), {
      systemPromptOverride: "x",
    });
    // requestPermission returns true in yolo without prompting.
    const allowed = await ctx.toolContext.requestPermission!("Bash", "rm -rf");
    expect(allowed).toBe(true);
    await ctx.cleanup();
  });
});

describe("registerStandardTools", () => {
  test("registers the core tool set on an empty registry", () => {
    const registry = new ToolRegistry();
    registerStandardTools(registry);
    const tools = registry.getAll().map((t) => t.name);
    expect(tools).toContain("Bash");
    expect(tools).toContain("Grep");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Agent");
    expect(tools).toContain("Coordinate");
  });
});
