---
name: test
description: Run tests and fix any failures
trigger: /test
---

Run the project's test suite and fix any failures.

Steps:
1. Look for test configuration: package.json scripts, bun test, jest, vitest, pytest, etc.
2. Run the test command
3. If tests fail:
   - Read the failing test to understand what's expected
   - Read the source code being tested
   - Fix the source code (not the test) unless the test is clearly wrong
   - Re-run tests to verify the fix
4. Report results: total tests, passed, failed, skipped

{{args}}
