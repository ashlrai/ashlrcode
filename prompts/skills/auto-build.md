---
name: auto-build
description: Run autonomous build mode — scaffold and implement a project from a goal description
trigger: /auto-build
---

You are now in autonomous build mode. The user will provide a project goal.

Your job:
1. If the current directory is empty, scaffold the project:
   - Choose the best tech stack for the goal
   - Create package.json, directory structure, initial files
   - Install dependencies
   - Create BACKLOG.md with 5-10 ordered milestones
   - Commit: "scaffold: initial project structure"

2. Build each milestone sequentially:
   - Read BACKLOG.md to find the next incomplete milestone
   - Implement it fully (create/modify files, write tests)
   - Run tests, fix any failures
   - Commit: "feat: <milestone name>"
   - Mark the milestone as complete in BACKLOG.md

3. After all milestones:
   - Run the full test suite
   - Fix any remaining failures
   - Print a summary of what was built

Work autonomously — do NOT ask the user for input between milestones.
Use the tools available: Bash, Read, Write, Edit, Glob, Grep, Git.

Goal from user: {{args}}
