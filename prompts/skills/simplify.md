---
name: simplify
description: Simplify and refine code for clarity and maintainability
trigger: /simplify
---

Review recently changed code and simplify it. Focus on:

1. **Identify changed files**: Run `git diff --name-only` to find recently modified files
2. **Read each file** and look for:
   - Unnecessary abstractions that can be inlined
   - Overly complex logic that can be simplified
   - Redundant error handling or validation
   - Dead code or unused imports
   - Repeated patterns that should be extracted (only if 3+ occurrences)
3. **Apply simplifications** using Edit tool
4. **Verify** the code still compiles/runs after changes

Rules:
- Don't change behavior, only improve clarity
- Don't add comments to explain simple code
- Don't introduce new abstractions unless they reduce total code
- Preserve all existing functionality

{{args}}
