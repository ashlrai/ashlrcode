---
name: plan
description: Break a task into numbered steps with files, dependencies, and complexity estimates
trigger: /plan
---

Create a detailed, executable implementation plan for the task described below.

## Step 1: Understand the task

Read the task description carefully. If it is ambiguous or underspecified:
- Ask 1-3 targeted clarifying questions before planning
- Each question should reference specific code or architecture decisions, not be generic

If the task is clear enough to plan, proceed directly.

## Step 2: Explore the codebase

Before planning any changes:
1. Use Glob to find files related to the task
2. Use Grep to find patterns, imports, and usages relevant to the work
3. Read key files to understand existing patterns and conventions
4. Identify reusable utilities, helpers, or abstractions that already exist
5. Map the dependency chain — what calls what, what imports what

## Step 3: Create the plan

Output a structured plan with this format:

```
## Plan: <Task Title>

### Context
What problem this solves and why it matters.
What existing code/patterns this builds on.

### Steps

#### Step 1: <Title> [simple|medium|hard]
**Files**: `path/to/file.ts`, `path/to/other.ts`
**Depends on**: none
**Changes**:
- Specific change 1
- Specific change 2

#### Step 2: <Title> [simple|medium|hard]
**Files**: `path/to/file.ts`
**Depends on**: Step 1
**Changes**:
- Specific change 1
- Specific change 2

...

### Verification
- [ ] How to verify Step 1 works
- [ ] How to verify Step 2 works
- [ ] End-to-end verification

### Risks
- Risk 1 and mitigation
- Risk 2 and mitigation
```

## Planning rules

1. **Be specific**: Name exact files, functions, and line ranges. "Update the handler" is not a step — "Add error handling to `processRequest()` in `src/api/handler.ts`" is.
2. **Order by dependencies**: Steps that don't depend on each other can note they're parallelizable.
3. **Complexity ratings**:
   - **simple**: Single file, < 20 lines, straightforward change
   - **medium**: 2-3 files, requires understanding interactions, 20-100 lines
   - **hard**: 4+ files, architectural implications, new patterns, > 100 lines
4. **Include verification**: Each step should have a way to confirm it works (run a test, check output, etc.)
5. **Surface risks**: What could go wrong? What assumptions are you making?
6. **Atomic steps**: Each step should be independently committable if possible.

## Step 4: Review and execute

After presenting the plan:
1. Wait for the user to review and approve
2. If the user approves, offer to execute step by step
3. For each step, implement the changes, verify they work, then move to the next
4. If a step reveals the plan needs adjustment, update the plan before continuing

Do NOT start implementing until the user approves the plan.

{{args}}
