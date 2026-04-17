---
name: commit
description: Create a well-crafted git commit with conventional format and intelligent staging
trigger: /commit
---

Create a high-quality git commit for the current changes. Follow this workflow precisely.

## Step 1: Gather context

Run these commands in parallel:
- `git status` — see all changed, staged, and untracked files
- `git diff --staged` — see what's already staged
- `git diff` — see unstaged changes
- `git log --oneline -10` — match the repo's commit style

## Step 2: Determine what to commit

If nothing is staged (`git diff --staged` is empty), analyze ALL unstaged changes and untracked files.
If something is already staged, focus on the staged changes but mention if unstaged changes exist.

## Step 3: Classify the change

Determine the commit type from the changes:
- **feat**: new feature or capability
- **fix**: bug fix
- **refactor**: code restructuring without behavior change
- **style**: formatting, whitespace, missing semicolons
- **docs**: documentation only
- **test**: adding or updating tests
- **chore**: build, CI, dependencies, tooling
- **perf**: performance improvement

Identify the scope (module or area affected) if applicable.

## Step 4: Generate the commit message

Format: `type(scope): subject` (scope optional)

Rules:
- Subject line: imperative mood, max 50 characters, no period
- Body: explain WHY the change was made, not WHAT changed (the diff shows what)
- If the change is trivial (typo fix, version bump), body is optional
- If multiple logical changes exist, suggest splitting into separate commits

## Step 5: Stage files

Stage specific files by name. NEVER use `git add -A` or `git add .`.

**Always exclude:**
- `.env`, `.env.*` — secrets
- `credentials.json`, `*.key`, `*.pem` — keys
- `node_modules/`, `dist/`, `build/` — artifacts
- `.DS_Store`, `Thumbs.db` — OS files

If you find files that might contain secrets, WARN the user and do not stage them.

## Step 6: Create the commit

```bash
git commit -m "$(cat <<'EOF'
type(scope): subject line here

Body explaining why this change was needed.
What problem it solves or what improvement it makes.

Co-Authored-By: AshlrCode <noreply@ashlr.ai>
EOF
)"
```

## Step 7: Verify and optionally push

Run `git status` to confirm the commit succeeded.

If the user said "push", "and push", or included push-related args:
1. Check if branch tracks a remote: `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`
2. If tracking, run `git push`
3. If not tracking, run `git push -u origin $(git branch --show-current)`
4. NEVER force push to main or master

If the user did NOT ask to push, mention they can push when ready.

## Rules
- Always create NEW commits — never amend unless explicitly asked
- Never skip hooks (`--no-verify`)
- Never force push to main/master
- If pre-commit hooks fail, fix the issue and create a new commit (do NOT amend)
- If changes span multiple unrelated concerns, recommend splitting into atomic commits

{{args}}
