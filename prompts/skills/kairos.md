---
name: kairos
description: Start autonomous KAIROS mode with terminal focus-aware behavior
trigger: /kairos
---

Activate KAIROS — autonomous agent mode. The agent will:

- **Detect terminal focus** to adjust autonomy level:
  - Focused (you're watching): Collaborative, asks before big changes
  - Unfocused (you're away): Full auto, commits and pushes independently
  - Unknown: Balanced default
- **Heartbeat loop**: Keeps working between your inputs (every 30s)
- **Push notifications**: macOS notification when done or on error
- **Auto-stop**: Stops when nothing is left to do or you say stop

Give KAIROS a goal to work on autonomously:

{{args}}
