/**
 * Skill Marketplace — install, update, remove, and discover skill packages.
 *
 * Packages are directories in ~/.ashlrcode/marketplace/<name>/ containing:
 *   - package.json (SkillPackage metadata)
 *   - *.md files (skill definitions)
 *
 * The marketplace registry is a JSON index fetched from a URL or loaded
 * from a local file. Each entry points to a tarball or git repo.
 */

import { existsSync } from "fs";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";
import type { SkillDefinition, SkillPackage } from "./types.ts";
import { validateSkillFile } from "./validator.ts";

// ── Paths ────────────────────────────────────────────────────────────

function getMarketplaceDir(): string {
  return join(getConfigDir(), "marketplace");
}

function getPackageDir(name: string): string {
  return join(getMarketplaceDir(), name);
}

function getRegistryPath(): string {
  return join(getConfigDir(), "marketplace-registry.json");
}

// ── Registry ─────────────────────────────────────────────────────────

export interface RegistryEntry {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** URL to download the package (tar.gz or git repo) */
  url: string;
  /** Number of skills in the package */
  skillCount: number;
}

/**
 * Load the local registry cache.
 */
async function loadRegistry(): Promise<RegistryEntry[]> {
  const path = getRegistryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as RegistryEntry[];
  } catch {
    return [];
  }
}

/**
 * Refresh the registry from a remote URL.
 */
export async function refreshRegistry(registryUrl?: string): Promise<RegistryEntry[]> {
  const url =
    registryUrl ??
    process.env.AC_SKILL_REGISTRY_URL ??
    "https://raw.githubusercontent.com/ashlrai/ashlrcode-skills/main/registry.json";

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const entries = (await response.json()) as RegistryEntry[];
    await writeFile(getRegistryPath(), JSON.stringify(entries, null, 2), "utf-8");
    return entries;
  } catch (err) {
    // Fall back to cached registry
    return loadRegistry();
  }
}

// ── Install / Update / Remove ────────────────────────────────────────

/**
 * Install a skill package from a URL or registry name.
 */
export async function installSkill(nameOrUrl: string): Promise<{
  package: SkillPackage;
  skills: string[];
  warnings: string[];
}> {
  const marketplaceDir = getMarketplaceDir();
  await mkdir(marketplaceDir, { recursive: true });

  let url: string;
  let packageName: string;

  if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
    // Direct URL
    url = nameOrUrl;
    packageName =
      nameOrUrl
        .split("/")
        .pop()
        ?.replace(/\.tar\.gz$/, "")
        .replace(/\.git$/, "") ?? "unknown";
  } else {
    // Look up in registry
    const registry = await loadRegistry();
    const entry = registry.find((e) => e.name === nameOrUrl);
    if (!entry) {
      // Try refreshing registry first
      const fresh = await refreshRegistry();
      const freshEntry = fresh.find((e) => e.name === nameOrUrl);
      if (!freshEntry) {
        throw new Error(`Package "${nameOrUrl}" not found in registry. Try /skills search ${nameOrUrl}`);
      }
      url = freshEntry.url;
      packageName = freshEntry.name;
    } else {
      url = entry.url;
      packageName = entry.name;
    }
  }

  const destDir = getPackageDir(packageName);

  // Validate URL to prevent injection
  let validatedUrl: string;
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("Only HTTP/HTTPS URLs are allowed");
    }
    validatedUrl = parsed.toString();
  } catch (err) {
    if (err instanceof TypeError) throw new Error(`Invalid URL: ${url}`);
    throw err;
  }

  // If it's a git repo, clone it
  if (validatedUrl.endsWith(".git") || validatedUrl.includes("github.com")) {
    // Clean up existing
    if (existsSync(destDir)) {
      await rm(destDir, { recursive: true });
    }
    const proc = Bun.spawn(["git", "clone", "--depth", "1", validatedUrl, destDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } else {
    // Download and extract tarball
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: HTTP ${response.status}`);

    await mkdir(destDir, { recursive: true });

    // Write tarball to temp and extract
    const buffer = await response.arrayBuffer();
    const tmpTar = join(destDir, "__tmp.tar.gz");
    await writeFile(tmpTar, new Uint8Array(buffer));
    const proc = Bun.spawn(["tar", "-xzf", tmpTar, "-C", destDir, "--strip-components=1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    await rm(tmpTar).catch(() => {});
  }

  // Read package.json
  const pkgPath = join(destDir, "package.json");
  let pkg: SkillPackage;
  if (existsSync(pkgPath)) {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as SkillPackage;
  } else {
    // Auto-generate from .md files
    const mdFiles = (await readdir(destDir)).filter((f) => f.endsWith(".md"));
    pkg = {
      name: packageName,
      version: "0.0.0",
      description: `Installed from ${url}`,
      skills: mdFiles,
    };
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
  }

  // Validate all skill files
  const warnings: string[] = [];
  const skills: string[] = [];
  const mdFiles = (await readdir(destDir)).filter((f) => f.endsWith(".md"));

  for (const file of mdFiles) {
    const content = await readFile(join(destDir, file), "utf-8");
    const result = validateSkillFile(content);
    if (!result.valid) {
      warnings.push(`${file}: ${result.errors.join(", ")}`);
    } else {
      skills.push(file);
      warnings.push(...result.warnings.map((w) => `${file}: ${w}`));
    }
  }

  return { package: pkg, skills, warnings };
}

/**
 * Update an installed skill package (re-install from same source).
 */
export async function updateSkill(name: string): Promise<{
  package: SkillPackage;
  skills: string[];
  warnings: string[];
} | null> {
  const dir = getPackageDir(name);
  if (!existsSync(dir)) return null;

  // Try to find the URL from the registry
  const registry = await loadRegistry();
  const entry = registry.find((e) => e.name === name);
  if (!entry) {
    // Try git pull if it's a git repo
    const gitDir = join(dir, ".git");
    if (existsSync(gitDir)) {
      const proc = Bun.spawn(["git", "pull"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      // Re-read package info
      return installSkill(name);
    }
    return null;
  }

  return installSkill(entry.url);
}

/**
 * Remove an installed skill package.
 */
export async function removeSkill(name: string): Promise<boolean> {
  // Prevent path traversal attacks
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error("Invalid skill package name");
  }
  const dir = getPackageDir(name);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true });
  return true;
}

/**
 * List installed skill packages.
 */
export async function listInstalled(): Promise<SkillPackage[]> {
  const dir = getMarketplaceDir();
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const packages: SkillPackage[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as SkillPackage;
        packages.push(pkg);
      } catch {
        // Skip corrupt packages
      }
    }
  }

  return packages;
}

/**
 * Search the registry for matching packages.
 */
export async function searchSkills(query: string): Promise<RegistryEntry[]> {
  let registry = await loadRegistry();
  if (registry.length === 0) {
    registry = await refreshRegistry();
  }

  const q = query.toLowerCase();
  return registry.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
}

/**
 * Load all skill definitions from installed marketplace packages.
 * Called by the skill loader to include marketplace skills.
 */
export async function loadMarketplaceSkills(): Promise<SkillDefinition[]> {
  const dir = getMarketplaceDir();
  if (!existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pkgDir = join(dir, entry.name);
    const pkgPath = join(pkgDir, "package.json");
    let pkg: SkillPackage | null = null;

    if (existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as SkillPackage;
      } catch {}
    }

    // Load all .md files in the package directory
    const mdFiles = (await readdir(pkgDir)).filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      const content = await readFile(join(pkgDir, file), "utf-8");
      const parsed = parseSkillFromMarketplace(content, pkg);
      if (parsed) skills.push(parsed);
    }
  }

  return skills;
}

/**
 * Parse a skill definition from marketplace .md, adding marketplace metadata.
 */
function parseSkillFromMarketplace(content: string, pkg: SkillPackage | null): SkillDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const prompt = match[2]!.trim();

  const name = extractField(frontmatter, "name");
  const description = extractField(frontmatter, "description");
  const trigger = extractField(frontmatter, "trigger");

  if (!name || !trigger) return null;

  return {
    name,
    description: description ?? name,
    trigger,
    prompt,
    version: pkg?.version,
    author: typeof pkg?.author === "object" ? pkg.author.name : undefined,
    source: "marketplace",
  };
}

function extractField(frontmatter: string, field: string): string | null {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}
