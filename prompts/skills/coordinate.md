---
name: coordinate
description: Break a complex task into subtasks and dispatch to multiple agents
trigger: /coordinate
---

Use coordinator mode to tackle a complex task with multiple agents working in parallel.

## How it works:
1. **Plan**: A planning agent breaks your goal into independent subtasks
2. **Dispatch**: Each subtask is assigned to a specialized sub-agent (explorer, implementer, test-writer, code-reviewer)
3. **Execute**: Agents work in parallel waves (up to 3 concurrent)
4. **Verify**: Optional verification agent checks the combined output
5. **Report**: Summary of what each agent accomplished

## Usage:
Describe the complex task you want to coordinate. Be specific about the goal and any constraints.

Example: "Refactor the auth module to use JWT tokens, update all tests, and review for security issues"

{{args}}
