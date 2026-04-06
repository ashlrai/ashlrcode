import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  loadMarketplaceSkills,
  searchSkills,
  listInstalled,
} from "../skills/marketplace.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-marketplace-test-"));
  setConfigDirForTests(configDir);
});

afterEach(() => {
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

describe("loadMarketplaceSkills", () => {
  test("returns empty array when marketplace dir does not exist", async () => {
    const skills = await loadMarketplaceSkills();
    expect(skills).toEqual([]);
  });

  test("loads skills from .md files in package directories", async () => {
    const pkgDir = join(configDir, "marketplace", "test-pkg");
    mkdirSync(pkgDir, { recursive: true });

    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "test-pkg", version: "1.0.0", description: "Test", skills: ["deploy.md"] }),
    );
    writeFileSync(
      join(pkgDir, "deploy.md"),
      "---\nname: deploy\ntrigger: /deploy\ndescription: Deploy it\n---\nRun the deploy.",
    );

    const skills = await loadMarketplaceSkills();
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("deploy");
    expect(skills[0]!.trigger).toBe("/deploy");
    expect(skills[0]!.prompt).toBe("Run the deploy.");
  });

  test("skips .md files without valid frontmatter", async () => {
    const pkgDir = join(configDir, "marketplace", "bad-pkg");
    mkdirSync(pkgDir, { recursive: true });

    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "bad-pkg", version: "1.0.0", description: "Bad", skills: [] }));
    writeFileSync(join(pkgDir, "README.md"), "# Just a readme, no frontmatter");

    const skills = await loadMarketplaceSkills();
    expect(skills).toEqual([]);
  });
});

describe("searchSkills", () => {
  test("filters by name and description from local registry", async () => {
    // Write a local registry cache
    const registryPath = join(configDir, "marketplace-registry.json");
    const registry = [
      { name: "deploy-aws", version: "1.0.0", description: "Deploy to AWS", url: "https://example.com/deploy.tar.gz", skillCount: 1 },
      { name: "lint-fix", version: "1.0.0", description: "Auto-fix lint errors", url: "https://example.com/lint.tar.gz", skillCount: 2 },
      { name: "docker-compose", version: "2.0.0", description: "Manage Docker containers", url: "https://example.com/docker.tar.gz", skillCount: 3 },
    ];
    writeFileSync(registryPath, JSON.stringify(registry));

    // Search by name
    const byName = await searchSkills("deploy");
    expect(byName.length).toBe(1);
    expect(byName[0]!.name).toBe("deploy-aws");

    // Search by description
    const byDesc = await searchSkills("docker");
    expect(byDesc.length).toBe(1);
    expect(byDesc[0]!.name).toBe("docker-compose");

    // Search with no matches
    const noMatch = await searchSkills("kubernetes");
    expect(noMatch).toEqual([]);
  });
});

describe("listInstalled", () => {
  test("returns packages from marketplace dir", async () => {
    const mktDir = join(configDir, "marketplace");

    // Create two packages
    const pkg1Dir = join(mktDir, "skill-a");
    mkdirSync(pkg1Dir, { recursive: true });
    writeFileSync(
      join(pkg1Dir, "package.json"),
      JSON.stringify({ name: "skill-a", version: "1.0.0", description: "Skill A", skills: ["a.md"] }),
    );

    const pkg2Dir = join(mktDir, "skill-b");
    mkdirSync(pkg2Dir, { recursive: true });
    writeFileSync(
      join(pkg2Dir, "package.json"),
      JSON.stringify({ name: "skill-b", version: "2.0.0", description: "Skill B", skills: ["b.md"] }),
    );

    const installed = await listInstalled();
    expect(installed.length).toBe(2);
    const names = installed.map((p) => p.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  test("returns empty array when marketplace dir does not exist", async () => {
    const installed = await listInstalled();
    expect(installed).toEqual([]);
  });

  test("skips directories without package.json", async () => {
    const mktDir = join(configDir, "marketplace");
    const noPkgDir = join(mktDir, "no-pkg");
    mkdirSync(noPkgDir, { recursive: true });
    writeFileSync(join(noPkgDir, "readme.md"), "# Nothing here");

    const installed = await listInstalled();
    expect(installed).toEqual([]);
  });
});
