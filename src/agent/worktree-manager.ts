/**
 * Worktree Manager — manages isolated git worktrees for sub-agents.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

export interface WorktreeInfo {
  path: string;
  branch: string;
  parentBranch: string;
}

const WORKTREE_DIR = join(homedir(), ".ashlrcode", "worktrees");

export async function createWorktree(name: string): Promise<WorktreeInfo> {
  await mkdir(WORKTREE_DIR, { recursive: true });

  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 50);
  const timestamp = Date.now();
  const branch = `agent/${safeName}-${timestamp}`;
  const wtPath = join(WORKTREE_DIR, `${safeName}-${timestamp}`);

  // Get current branch — read streams before awaiting exit to avoid deadlock
  const headProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const headStdoutPromise = new Response(headProc.stdout).text();
  const headStderrPromise = new Response(headProc.stderr).text();
  const headExit = await headProc.exited;
  const parentBranch = (await headStdoutPromise).trim();
  if (headExit !== 0 || !parentBranch) {
    const headStderr = await headStderrPromise;
    throw new Error(`Not inside a git repository: ${headStderr}`);
  }

  // Create worktree with new branch — same pattern: read streams before exit
  const proc = Bun.spawn(["git", "worktree", "add", "-b", branch, wtPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const procStdoutPromise = new Response(proc.stdout).text();
  const procStderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await procStderrPromise;
    throw new Error(`Failed to create worktree: ${stderr}`);
  }

  return { path: wtPath, branch, parentBranch };
}

export async function removeWorktree(path: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "worktree", "remove", path, "--force"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (pathLine && branchLine) {
      worktrees.push({
        path: pathLine.replace("worktree ", ""),
        branch: branchLine.replace("branch refs/heads/", ""),
        parentBranch: "main",
      });
    }
  }
  return worktrees;
}
