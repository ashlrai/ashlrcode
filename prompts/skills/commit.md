---
name: commit
description: Create a well-crafted git commit and push to GitHub
trigger: /commit
---

Create a git commit for the current changes. Follow these steps:

1. Run `git status` to see all changes and `git diff` to see the actual modifications.
2. Run `git log --oneline -5` to match the repo's commit message style.
3. Analyze ALL changes (staged and unstaged) and draft a commit message:
   - Summarize the nature: new feature, bug fix, refactor, docs, etc.
   - Focus on WHY, not WHAT
   - Keep it concise (1-2 sentences)
4. Stage specific files by name (NEVER use `git add -A` or `git add .`)
5. Do NOT commit files that contain secrets (.env, credentials, API keys)
6. Create the commit:

```bash
git commit -m "$(cat <<'EOF'
Your commit message here.

Co-Authored-By: AshlrCode <noreply@ashlr.ai>
EOF
)"
```

7. After commit, run `git status` to verify success.
8. Push to remote if the user asked for it.

IMPORTANT:
- Always create NEW commits, never amend
- Never skip hooks (--no-verify)
- Never force push to main/master

{{args}}
