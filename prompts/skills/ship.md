---
name: ship
description: Start ProductAgent — autonomous product-building mode that finds and fixes issues
trigger: /ship
---

Start the **ProductAgent** — an autonomous agent that works toward a product goal.

Unlike KAIROS (which does tasks you give it), ProductAgent **finds its own work** by:
1. Scanning the codebase against your goal
2. Identifying bugs, missing features, quality gaps, security issues
3. Prioritizing by user impact (critical → high → medium → low)
4. Executing each fix with sub-agents (small items directly, large items via coordinator)
5. Verifying every change automatically
6. Optionally auto-committing verified changes

## Usage
```
/ship Make ashlrcode production-ready for paying users
/ship Ensure all tools work correctly and have proper error handling
/ship Add comprehensive test coverage for all agent modules
/ship stop
```

## Safety
- Skips complex changes when you're away (terminal unfocused)
- Respects cost budget (--max-cost)
- Verifies every change before moving on
- Max 20 items per session (configurable)
- You can /ship stop at any time

{{args}}
