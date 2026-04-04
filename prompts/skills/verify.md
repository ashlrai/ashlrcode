---
name: verify
description: Run verification agent to validate recent code changes
trigger: /verify
---

Run the Verify tool to spawn a verification sub-agent that checks recent code changes for correctness.

The verification agent will:
1. Read the git diff and all modified files
2. Check for syntax errors, logic bugs, missing imports, type mismatches
3. Report PASS or FAIL with specific issues (file, line, severity)

Use after making non-trivial changes to validate they work correctly.
This is the feature that "doubles completion rates" — catching bugs before they ship.

{{args}}
