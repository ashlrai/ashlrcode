---
name: debug
description: Systematic debugging with error analysis
trigger: /debug
---

Debug the issue described below using a systematic approach.

Steps:
1. **Reproduce**: Identify how to reproduce the issue
2. **Locate**: Use Grep and Read to find the relevant code paths
3. **Diagnose**: Trace the execution path, identify the root cause
4. **Fix**: Make the minimal change that fixes the root cause
5. **Verify**: Run the fix and confirm the issue is resolved
6. **Prevent**: Check if similar issues exist elsewhere

Rules:
- Fix the root cause, not symptoms
- Don't add workarounds unless the root cause is unfixable
- Make the smallest change possible
- Verify the fix doesn't break other functionality

{{args}}
