---
name: weekly-plan
description: Weekly progress review and priority setting across projects
trigger: /weekly-plan
---

Weekly planning session to review progress and set priorities.

## Steps

1. **Aggregate Last Week's Completions**
   - Find notes with `status: completed` modified in last 7 days
   - Summarize GSD phases completed
   - Count features shipped, bugs fixed per project

2. **Show Carried-Over Items**
   - Find items that were planned but not completed
   - Identify stale inbox items (> 7 days old)

3. **Cross-Project Resource Analysis**
   - Show current allocation between projects
   - Identify conflicts (same person, same week)

4. **This Week's Priorities**
   - Pull from GSD roadmaps
   - Suggest 3-5 key objectives
   - Ask for approval or edits

5. **Update Weekly Review Note**
   - Create/update `07-Dashboards/Weekly-Review.md` with:
     - Week's objectives
     - Key decisions made
     - Metrics (if tracked)

## Output Format

```
Weekly Planning - Week of [Date]

--- LAST WEEK ---
[completed items per project]

--- CARRIED OVER ---
[unfinished items and stale inbox]

--- THIS WEEK ---
Primary Focus: [project]
1. Objective one
2. Objective two
3. Objective three

--- TEAM ---
[team member]: [Project A] (X%), [Project B] (Y%)

Confirm this week's plan? (y/n)
```

## Notes
- Run at start of week (Monday morning)
- Save decisions to `02-Projects/*/Decisions/`
- Update GSD STATE.md files if priorities change

{{args}}
