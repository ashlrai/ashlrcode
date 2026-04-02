---
name: deep-work
description: Strategic session kickoff with parallel exploration before acting
trigger: /deep-work
---

You are starting a deep work session. Thoroughly investigate before acting. Follow these phases in order. Scale effort to task complexity.

**User's task:** {{args}}

---

## Phase 0: Context Recovery (conditional)

**Skip this phase if** you've already recovered context this session (e.g., via `/resume-branch`, `entire resume`, or earlier in the conversation). Don't duplicate work.

If context has NOT been recovered yet:

1. Read project memory files -- search for entries relevant to this task
2. Check git state: run `git status` and `git log --oneline -10`
3. If on a non-main branch, run `entire resume <branch>` for session context
4. Scan the project's configuration for conventions relevant to this task

Output a brief **Current State** summary (3-5 lines): branch, recent changes, relevant memory entries. If skipping, state "Context already recovered" and move on.

---

## Phase 1: Task Classification (immediate, no agents)

Analyze the user's task and classify it:

**Type:** feature | bug | refactor | investigation | optimization | architecture
**Scope:** surgical (1-2 files) | focused (3-10 files) | broad (10+ files) | architectural (system-wide)
**Familiarity:** known territory | partially known | unexplored

Map to exploration depth:

| Scope | Agents to Deploy | Delivery Mode |
|-------|-----------------|---------------|
| surgical | 1 (patterns) | Brief + draft plan + questions together |
| focused | 2 (patterns + impact) | Brief + draft plan + questions together |
| broad | 3 (patterns + impact + risk) | Brief + questions first, then plan after answers |
| architectural | 3+ (full spectrum) | Brief + questions first, then plan after answers |

State your classification and depth explicitly before proceeding.

---

## Phase 2: Parallel Exploration (adaptive agent deployment)

Deploy agents **in parallel** based on depth from Phase 1. The **Patterns & Conventions** agent is the most critical -- give it the heaviest workload. Other agents should be targeted, not broad.

### Agent Missions

| Agent | Mission | Deploy When |
|-------|---------|-------------|
| **Patterns & Conventions** (primary) | How does the codebase handle similar things? What utilities/patterns exist to reuse? What conventions must be followed? Search for analogous implementations. Find the specific files, functions, and patterns that this task should mirror. | Always -- this is the workhorse agent |
| **Impact & Dependencies** | What specifically will this change touch? What imports/calls the affected code? What tests cover it? Map the concrete dependency graph -- files and functions, not abstractions. | Focused+ |
| **Risk & Edge Cases** | Specific security implications for THIS change? Concrete performance concerns? Actual error scenarios based on the code paths involved? Skip generic risk lists. | Broad+ |
| **Architecture & Design** | Design options with concrete tradeoffs specific to this codebase. How does this fit the existing system architecture? What precedents exist for similar decisions? | Architectural only |
| **Prior Art & History** | Has this been attempted before? Check git log for related commits, memory files for past decisions, session transcripts for context. | Architectural or unfamiliar territory only |

Each agent must report: **findings**, **relevant file paths with line numbers**, **reusable utilities**, and **risks/unknowns**.

Deploy all applicable agents in a **single message** (parallel execution).

---

## Phase 3: Synthesis Brief

After all agents complete, combine findings into this structure:

```
## Situation
[Current state of the relevant code/subsystem -- 2-4 sentences]

## Approach
[What needs to change and the recommended path -- be specific about strategy]

## Key Findings
- [Patterns/conventions to follow -- with file paths]
- [Existing utilities to reuse -- with file:line references]
- [Dependencies and impact areas]

## Risks & Unknowns
- [Risk 1 -- proposed mitigation]
- [Unknown 1 -- needs user input]
```

Keep it concise. No filler. Every bullet should be actionable or inform a decision.

---

## Phase 4: Questions + Plan (merged for speed)

**For surgical/focused scope:** Present the synthesis brief, a draft execution plan, AND strategic questions in a single response. Frame questions as: "Here's what I'd do -- but these decisions could change the approach:"

**For broad/architectural scope:** Present the synthesis brief and strategic questions first. Wait for answers before producing the plan, since the answers materially change the approach.

### Question Quality Rules

Questions must be:
- **Specific** -- emerged from actual exploration, not generic
- **Decision-forcing** -- present concrete options with tradeoffs discovered in Phase 2
- **Minimal** -- only ask what you genuinely can't decide autonomously

Good: "The auth middleware uses session-based auth but this endpoint needs API key support. Should we extend the existing middleware or create a separate auth path?"
Bad: "What authentication approach do you prefer?"

### Execution Plan Structure

1. **Files to create/modify** -- specific paths, what changes in each
2. **Sequence** -- ordered by dependencies (what must happen first)
3. **Reuse** -- existing code/utilities to leverage (with file:line references)
4. **Verification** -- how to test end-to-end (specific commands, browser checks, etc.)

After the user responds (answers questions and/or approves plan), begin implementation directly.

---

## Key Principles

- **Adaptive depth** -- a 1-file bug fix gets 1 agent and ships fast; a system redesign gets full investigation. Never over-investigate simple tasks.
- **Patterns agent is king** -- for convention-heavy codebases, the patterns agent does the most valuable work. Other agents should be targeted, not broad. Don't deploy agents that will return generic findings.
- **Reuse-first** -- agents specifically look for existing patterns and utilities. Don't reinvent.
- **Memory-aware** -- check past session context before exploring from scratch. Don't duplicate `/resume-branch` work.
- **Speed over ceremony** -- for surgical/focused tasks, merge the brief + plan + questions into one response. Don't create blocking pauses between phases.
- **Strategic questions over volume** -- ask the RIGHT questions, not many questions.
- **Show your work** -- output the classification, agent findings summary, and brief so the user sees the thinking.
