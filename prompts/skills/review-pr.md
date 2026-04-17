---
name: review-pr
description: Review a pull request or branch diff for bugs, security issues, and quality
trigger: /review-pr
---

Perform a thorough code review of a pull request or the current branch's changes against main.

## Step 1: Get the diff

Determine the review target from arguments:

- **PR number** (e.g., `123`): Run `gh pr diff 123` and `gh pr view 123 --json title,body,files`
- **PR URL** (e.g., `https://github.com/org/repo/pull/123`): Extract the number and use `gh pr diff`
- **No argument**: Review current branch against main with `git diff main...HEAD`

Also gather context:
- `git log --oneline main..HEAD` — list of commits being reviewed
- Read the PR description if available — understand the author's intent

## Step 2: Understand the change

Before reviewing line-by-line:
1. Read the full diff to understand the overall change
2. Identify the purpose: feature, fix, refactor, etc.
3. Read related files for context (imports, callers, tests)
4. Check if tests were added or updated for the changes

## Step 3: Review for issues

Examine every changed file for these categories:

### Critical (must fix before merge)
- **Bugs**: Logic errors, off-by-one, null/undefined dereference, race conditions, infinite loops
- **Security**: SQL/command injection, XSS, credential exposure, path traversal, unsafe deserialization
- **Data loss**: Missing error handling on writes, uncaught exceptions that could corrupt state
- **Breaking changes**: API contract violations, removed exports, changed function signatures

### Warning (should fix)
- **Missing edge cases**: Empty arrays, null inputs, network failures, timeout handling
- **Error handling**: Swallowed errors, missing try/catch at async boundaries, unclear error messages
- **Performance**: N+1 queries, unbounded loops, missing pagination, large memory allocations
- **Concurrency**: Shared mutable state, missing locks, race conditions in async code

### Info (consider)
- **Readability**: Unclear variable names, complex conditionals that need comments, magic numbers
- **Conventions**: Deviations from existing codebase patterns, inconsistent naming
- **Testing gaps**: Untested branches, missing negative test cases
- **Documentation**: Missing JSDoc on public APIs, outdated comments

## Step 4: Output findings

For each issue found, report:

```
### [SEVERITY] file/path.ts:LINE — Short title

Description of the issue and why it matters.

**Suggestion:**
\`\`\`typescript
// Recommended fix
\`\`\`
```

Group findings by severity (Critical first, then Warning, then Info).

## Step 5: Overall assessment

End with a clear verdict:

- **Approve** — No critical issues, warnings are minor. Ship it.
- **Request Changes** — Critical issues or multiple warnings that need addressing before merge.
- **Comment** — No critical issues but significant suggestions worth discussing.

Include a 2-3 sentence summary of the overall quality: what was done well, what needs attention.

If no issues found, say so clearly — don't manufacture feedback for the sake of it.

{{args}}
