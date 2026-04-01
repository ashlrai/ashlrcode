/**
 * Git context — detect repo info for system prompt enrichment.
 */

import { existsSync } from "fs";
import { join } from "path";

export interface GitContext {
  isRepo: boolean;
  branch?: string;
  status?: string;
  remoteUrl?: string;
}

/**
 * Detect git repo context for the current working directory.
 */
export async function getGitContext(cwd: string): Promise<GitContext> {
  // Quick check — is this a git repo?
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
