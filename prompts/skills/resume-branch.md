---
name: resume-branch
description: Switch branches with full context restoration from Entire.io
trigger: /resume-branch
---

Switch to an existing branch and restore AI session context from Entire.io.

**Branch:** {{args}}

## Steps

1. Run `entire resume {{args}}` to switch to the branch and restore session context
2. If the branch doesn't exist locally, Entire will prompt to fetch from origin
3. After resume, run `entire explain --short` to show a summary of recent checkpoints on this branch
4. Run `git log --oneline -10` to see recent commits
5. Summarize the state of work on this branch:
   - What was previously accomplished (from checkpoints)
   - What commits exist
   - What files were recently modified
   - Any unfinished work or next steps visible from context

## Notes

- This replaces a plain `git checkout` -- it also restores the Entire session log
- If no checkpoints exist on the branch, fall back to `git checkout {{args}}` and summarize from git log
- Works across all Ashlar projects
