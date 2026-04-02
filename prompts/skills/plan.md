---
name: plan
description: Enter plan mode for structured exploration and planning
trigger: /plan-task
---

I need you to enter plan mode and create a detailed implementation plan before making any changes.

Steps:
1. Call EnterPlan to activate plan mode
2. Use Read, Glob, and Grep to explore the relevant code
3. Ask me strategic questions using AskUser if you need direction
4. Write a detailed plan using PlanWrite that includes:
   - Context: what problem this solves
   - Approach: what files to modify and how
   - Verification: how to test the changes
5. Call ExitPlan when the plan is ready for my review

{{args}}
