---
name: daily-review
description: Morning status check across projects, inbox, and blockers
trigger: /daily-review
---

Morning routine to prepare for the day's work.

## Steps

1. **Show Inbox Status**
   - Count notes in `00-Inbox/` with `status: captured`
   - Highlight any with `urgency: now`
   - Format: `Inbox: X items (Y urgent)`

2. **Display Today's GSD Focus**
   - Read each project's STATE.md current focus
   - Show current phase, description, and progress for each active project
   - Format as boxed sections per project with progress bars

3. **List Active Blockers**
   - Search for notes with `status: blocked` in all projects
   - Show any GSD phases that are stuck
   - Format: `Blockers: [Project] Feature X blocked by: ...`

4. **Quick Actions**
   Present options:
   - Process inbox (`/process-inbox`)
   - Continue GSD work (`/gsd:progress`)
   - Plan today's tasks (manual)

5. **Create Daily Note (Optional)**
   - If user approves, create today's daily note in `01-Daily/`
   - Use template from `01-Daily/_templates/daily-note.md`
   - Pre-fill with GSD status and inbox count

## Output Format

```
Daily Review - [Date]

Inbox: X items (Y urgent)

Focus
+-- Project A --------------------+
| Phase: [phase name]             |
| Progress: [progress bar] XX%   |
| Current: [current task]        |
+---------------------------------+
+-- Project B --------------------+
| Phase: [phase name]             |
| Progress: [progress bar] XX%   |
| Current: [current task]        |
+---------------------------------+

Blockers: None

What would you like to do?
1. Process inbox
2. Continue [Project A] work
3. Continue [Project B] work
4. Something else
```

{{args}}
