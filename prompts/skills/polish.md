---
name: polish
description: Autonomous polish pipeline -- commit, lint, review, security, fix loop until clean
trigger: /polish
---

Autonomous loop: commit, lint/type-check, code review, simplify, security audit, fix, re-commit. Runs until clean or max 3 iterations.

## Step 1 -- Initial Commit

1. Run `git status` and `git diff` to understand all changes
2. Run `git log -3 --oneline` to match commit message style
3. Stage related files in logical groups
4. Generate a commit message using these conventions:
   - Format: `<type>: <summary>` (feat/fix/refactor/style/docs/test/chore)
   - Summary: max 50 chars, present tense, no period
   - Body: explain "why" not "what", wrap at 72 chars
5. Commit and push to origin

## Step 2 -- Lint + Type-check

1. Check `package.json` for available tooling (eslint, tsc, biome in scripts or devDependencies)
2. If ESLint available: run `npx eslint --fix` on the changed files only
3. If TypeScript available: run `npx tsc --noEmit` to surface type errors
4. If lint/type errors found that couldn't be auto-fixed: fix them manually
5. If any fixes were made: commit with message `style: fix lint and type errors`

## Step 3 -- Code Review + Simplify (Parallel)

Launch **two agents in parallel**:

**Agent 1: Code Review**
- Review the diff from the latest commit(s) in this session
- Focus on: bugs, logic errors, missing edge cases, broken patterns, code quality
- Only report high-confidence issues that truly matter

**Agent 2: Simplify**
- Review changed files for clarity, consistency, and maintainability
- Focus on: unnecessary complexity, dead code, DRY violations, unclear naming
- Preserve all existing functionality

Collect findings from both agents.

## Step 4 -- Security Audit

Review all changed files for security vulnerabilities:

- **Injection**: unescaped user input, `innerHTML`, `dangerouslySetInnerHTML`, SQL without parameterized queries
- **Auth/AuthZ**: missing auth checks on API routes, privilege escalation paths
- **Secrets**: hardcoded API keys, tokens, passwords, connection strings
- **Validation**: missing input validation at API boundaries, unchecked array access
- **XSS**: unsanitized output in templates/JSX
- **CSRF/CORS**: missing or misconfigured protections

## Step 5 -- Apply All Fixes

1. Apply fixes from code review, simplify, and security audit
2. Re-run lint + type-check to ensure fixes don't introduce new issues
3. If a build script exists, run `npm run build` to verify compilation

## Step 6 -- Re-commit & Loop

1. If fixes were applied: commit with descriptive message and push
2. **Loop decision** (max 3 iterations):
   - If this was iteration 3: stop, report summary
   - If fixes were made: loop back to Step 3 (skip lint since we just ran it)
   - If no issues found: stop, report summary

## Final Summary

After the loop completes, output a summary:

```
## Polish Complete

**Iterations**: X
**Initial commit**: <hash> -- <message>
**Review findings fixed**: <count>
**Simplifications made**: <count>
**Security issues resolved**: <count>
**Lint/type fixes**: <count>
**Final commit**: <hash> -- <message>
```

## Important Rules

- Do NOT ask for user confirmation between steps -- run autonomously
- Do NOT skip steps -- every iteration must include review + simplify + security
- Do NOT make cosmetic-only changes that don't improve the code meaningfully
- Do NOT touch files outside the current changeset unless fixing a bug found during review
- If `npm run build` or lint fails after fixes, debug and resolve before re-committing
- Always push after each commit

{{args}}
