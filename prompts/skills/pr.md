---
name: pr
description: Create a pull request on GitHub
trigger: /pr
---

Create a pull request for the current branch. Follow these steps:

1. Run `git status`, `git diff`, and `git log --oneline -10` to understand all changes
2. Check if the branch tracks a remote: `git rev-parse --abbrev-ref --symbolic-full-name @{u}`
3. If not tracking, push with: `git push -u origin $(git branch --show-current)`
4. Analyze ALL commits on this branch (not just the latest)
5. Create the PR:

```bash
gh pr create --title "concise title under 70 chars" --body "$(cat <<'EOF'
## Summary
- bullet point 1
- bullet point 2

## Test plan
- [ ] test item 1
- [ ] test item 2
EOF
)"
```

6. Return the PR URL when done.

{{args}}
