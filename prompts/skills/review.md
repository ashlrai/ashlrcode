---
name: review
description: Review code for bugs, quality, and security issues
trigger: /review
---

Review the code changes for bugs, logic errors, security vulnerabilities, and quality issues. Focus on what actually matters.

## Steps:
1. Run `git diff` to see all current changes (or `git diff HEAD~1` for the last commit)
2. Read each changed file to understand context
3. Review for:
   - **Bugs**: Logic errors, off-by-one, null/undefined handling, race conditions
   - **Security**: Injection risks, credential exposure, unsafe operations
   - **Quality**: Unclear code, missing error handling at boundaries, complexity
   - **Conventions**: Does it match existing patterns in the codebase?

## Output format:
For each issue found, report:
- File and line number
- Severity: critical / warning / suggestion
- Description of the issue
- Recommended fix

Only report issues you're confident about. Don't flag style preferences or minor nits.

{{args}}
