import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadProjectConfig } from "../config/project-config.ts";
import { setConfigDirForTests } from "../config/settings.ts";

describe("loadProjectConfig", () => {
  let rootDir: string;
  let configDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "ashlrcode-project-config-"));
    configDir = join(rootDir, ".config");
    mkdirSync(configDir, { recursive: true });
    setConfigDirForTests(configDir);
  });

  afterEach(() => {
    setConfigDirForTests(null);
    if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
  });

  test("loads global, parent, and cwd instructions in increasing precedence order", async () => {
    const parentDir = join(rootDir, "workspace");
    const childDir = join(parentDir, "app");
    mkdirSync(childDir, { recursive: true });

    writeFileSync(join(configDir, "ASHLR.md"), "global rule", "utf-8");
    writeFileSync(join(parentDir, "ASHLR.md"), "parent rule", "utf-8");
    writeFileSync(join(childDir, "CLAUDE.md"), "child rule", "utf-8");

    const config = await loadProjectConfig(childDir);

    expect(config.sources).toEqual([
      join(configDir, "ASHLR.md"),
      join(parentDir, "ASHLR.md"),
      join(childDir, "CLAUDE.md"),
    ]);
    expect(config.instructions.indexOf("global rule")).toBeLessThan(
      config.instructions.indexOf("parent rule")
    );
    expect(config.instructions.indexOf("parent rule")).toBeLessThan(
      config.instructions.indexOf("child rule")
    );
  });

  test("walks ancestor directories and includes both ASHLR.md and CLAUDE.md", async () => {
    const parentDir = join(rootDir, "workspace");
    const childDir = join(parentDir, "app");
    mkdirSync(childDir, { recursive: true });

    writeFileSync(join(rootDir, "ASHLR.md"), "root rule", "utf-8");
    writeFileSync(join(parentDir, "CLAUDE.md"), "parent claude", "utf-8");

    const config = await loadProjectConfig(childDir);

    expect(config.sources).toContain(join(rootDir, "ASHLR.md"));
    expect(config.sources).toContain(join(parentDir, "CLAUDE.md"));
    expect(config.instructions).toContain("root rule");
    expect(config.instructions).toContain("parent claude");
  });
});
