/**
 * Git utilities — repo analysis, VCS detection, and system prompt enrichment.
 */

import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

export interface GitContext {
  isRepo: boolean;
  branch?: string;
  status?: string;
  remoteUrl?: string;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

async function runGit(cwd: string, args: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args.split(" ")], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// VCS detection
// ---------------------------------------------------------------------------

/** Detect the VCS type of a directory. */
export async function detectVCS(cwd: string): Promise<"git" | "svn" | "hg" | "none"> {
  if (existsSync(join(cwd, ".git"))) return "git";
  if (existsSync(join(cwd, ".svn"))) return "svn";
  if (existsSync(join(cwd, ".hg"))) return "hg";
  return "none";
}

/** Check if directory is inside a git repo (works for nested dirs). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, "rev-parse --is-inside-work-tree");
  return result === "true";
}

// ---------------------------------------------------------------------------
// Branch / remote
// ---------------------------------------------------------------------------

/** Get current git branch. */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  return runGit(cwd, "rev-parse --abbrev-ref HEAD");
}

/** Get git remote URL (for repo identification). */
export async function getRemoteUrl(cwd: string): Promise<string | null> {
  return runGit(cwd, "remote get-url origin");
}

/** Get a short hash of the remote URL (for session association). */
export async function getRepoHash(cwd: string): Promise<string | null> {
  const url = await getRemoteUrl(cwd);
  if (!url) return null;
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Status / history
// ---------------------------------------------------------------------------

/** Get recent commits summary. */
export async function getRecentCommits(cwd: string, count: number = 5): Promise<string[]> {
  const output = await runGit(cwd, `log --oneline -${count}`);
  return output ? output.split("\n") : [];
}

/** Get git status summary (counts). */
export async function getGitStatus(cwd: string): Promise<{ modified: number; untracked: number; staged: number }> {
  const output = await runGit(cwd, "status --porcelain");
  if (!output) return { modified: 0, untracked: 0, staged: 0 };
  const lines = output.split("\n").filter(Boolean);
  return {
    modified: lines.filter(l => l.startsWith(" M") || l.startsWith("M ")).length,
    untracked: lines.filter(l => l.startsWith("??")).length,
    staged: lines.filter(l => l.startsWith("A ") || l.startsWith("M ")).length,
  };
}

// ---------------------------------------------------------------------------
// Legacy aggregate context (used by cli.ts today)
// ---------------------------------------------------------------------------

/**
 * Detect git repo context for the current working directory.
 */
export async function getGitContext(cwd: string): Promise<GitContext> {
  if (!existsSync(join(cwd, ".git"))) {
    return { isRepo: false };
  }

  const branch = await runGit(cwd, "rev-parse --abbrev-ref HEAD");
  const status = await runGit(cwd, "status --porcelain");
  const remoteUrl = await runGit(cwd, "config --get remote.origin.url");

  return {
    isRepo: true,
    branch: branch ?? undefined,
    status: status ?? undefined,
    remoteUrl: remoteUrl ?? undefined,
  };
}

/**
 * Format git context for inclusion in system prompt.
 */
export function formatGitPrompt(ctx: GitContext): string {
  if (!ctx.isRepo) return "";

  const lines = ["# Git Context"];
  if (ctx.branch) lines.push(`- Branch: ${ctx.branch}`);
  if (ctx.remoteUrl) lines.push(`- Remote: ${ctx.remoteUrl}`);
  if (ctx.status) {
    const changes = ctx.status.split("\n").filter(Boolean).length;
    lines.push(`- ${changes} uncommitted change(s)`);
  } else {
    lines.push("- Clean working tree");
  }

  return lines.join("\n");
}
