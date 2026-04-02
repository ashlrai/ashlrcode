---
name: refactor
description: Refactor code for clarity without changing behavior
trigger: /refactor
---

Refactor the specified code for improved clarity and maintainability.

Rules:
1. **Never change behavior** — refactoring must be behavior-preserving
2. Read all affected code first to understand the full picture
3. Make changes incrementally — one improvement at a time
4. Verify after each change that nothing is broken
5. Common refactoring targets:
   - Extract repeated patterns (only if 3+ occurrences)
   - Simplify complex conditionals
   - Improve naming for clarity
   - Remove dead code
   - Reduce nesting depth
6. Do NOT:
   - Add unnecessary abstractions
   - Change public APIs without discussion
   - "Improve" code that's already clear
   - Add comments to self-documenting code

{{args}}
