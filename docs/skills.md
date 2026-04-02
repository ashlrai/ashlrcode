# AshlrCode Skills Reference

Skills are reusable prompt templates invoked via slash commands. When you type a slash command like `/commit`, AshlrCode loads the matching skill file, expands template variables, and executes the prompt.

---

## Built-in Skills

### /commit

**Description:** Create a well-crafted git commit and push to GitHub

**What it does:** Runs `git status` and `git diff` to analyze all changes, checks recent commit messages to match the repo's style, then stages specific files (never `git add -A`) and creates a commit with a descriptive message focused on "why" not "what." Appends a `Co-Authored-By: AshlrCode` trailer. Optionally pushes to remote.

**Example usage:**
```
ac "/commit"
ac "/commit push to origin"
```

**Tips:**
- Never amends existing commits -- always creates new ones
- Automatically skips files containing secrets (.env, credentials, API keys)
- Never force pushes to main/master

---

### /review

**Description:** Review code for bugs, quality, and security issues

**What it does:** Reads the current diff (or last commit), examines each changed file in context, and reviews for bugs (logic errors, null handling, race conditions), security vulnerabilities (injection, credential exposure), code quality (missing error handling, complexity), and convention adherence. Reports issues with file, line number, severity, and a recommended fix.

**Example usage:**
```
ac "/review"
ac "/review focus on the auth module"
```

**Tips:**
- Only reports high-confidence issues -- no style nits
- Severity levels: critical, warning, suggestion
- Run before `/commit` to catch problems early

---

### /simplify

**Description:** Simplify and refine code for clarity and maintainability

**What it does:** Identifies recently changed files via `git diff --name-only`, reads each file, and looks for unnecessary abstractions, overly complex logic, redundant error handling, dead code, unused imports, and repeated patterns (3+ occurrences). Applies simplifications and verifies the code still works.

**Example usage:**
```
ac "/simplify"
ac "/simplify src/utils/"
```

**Tips:**
- Behavior-preserving only -- never changes what the code does
- Does not add explanatory comments to already-clear code
- Only extracts patterns when they appear 3 or more times

---

### /pr

**Description:** Create a pull request on GitHub

**What it does:** Analyzes all commits on the current branch (not just the latest), ensures the branch is pushed to the remote with tracking, then creates a PR via `gh pr create` with a concise title (under 70 characters), a summary section with bullet points, and a test plan checklist. Returns the PR URL.

**Example usage:**
```
ac "/pr"
ac "/pr target the staging branch"
```

**Tips:**
- Automatically pushes the branch if it is not yet on the remote
- Reviews all commits on the branch, not just the most recent one
- Requires the `gh` CLI to be installed and authenticated

---

### /plan-task

**Description:** Enter plan mode for structured exploration and planning

**What it does:** Activates plan mode and creates a detailed implementation plan before making any changes. Explores relevant code using Read, Glob, and Grep, asks strategic questions if direction is ambiguous, then writes a plan covering context (what problem this solves), approach (what files to modify and how), and verification (how to test the changes).

**Example usage:**
```
ac "/plan-task add user authentication"
ac "/plan-task migrate the database schema to support multi-tenancy"
```

**Tips:**
- Use this before tackling complex tasks that touch many files
- The plan is written for your review before any code changes happen
- Great for getting alignment on approach before investing time in implementation

---

### /test

**Description:** Run tests and fix any failures

**What it does:** Detects the project's test framework (jest, vitest, pytest, bun test, etc.) from configuration files, runs the test suite, and if tests fail, reads both the failing test and the source code to diagnose the issue. Fixes the source code (not the test, unless the test is clearly wrong) and re-runs to verify. Reports total, passed, failed, and skipped counts.

**Example usage:**
```
ac "/test"
ac --yolo "/test"
ac "/test only run the auth tests"
```

**Tips:**
- Use `--yolo` to let it run tests and apply fixes without confirmation prompts
- Defaults to fixing source code rather than changing tests
- Auto-detects test runners from package.json, Cargo.toml, etc.

---

### /debug

**Description:** Systematic debugging with error analysis

**What it does:** Follows a structured debugging workflow: reproduce the issue, locate relevant code paths using Grep and Read, diagnose by tracing execution, apply the minimal fix that addresses the root cause, verify the fix works, then check if similar issues exist elsewhere in the codebase.

**Example usage:**
```
ac "/debug TypeError: Cannot read properties of undefined"
ac "/debug the API returns 500 when the user has no profile"
```

**Tips:**
- Fixes root causes, not symptoms -- avoids workarounds
- Makes the smallest possible change to fix the issue
- Checks for similar bugs elsewhere after fixing

---

### /explore

**Description:** Deep codebase exploration and architecture analysis

**What it does:** Maps the directory structure with Glob, reads key files (package.json, README, config files, entry points), uses Grep to find patterns (exports, classes, routes, handlers), identifies the architecture and framework, and maps module dependencies. Produces a report covering project type, directory structure, key entry points, architecture patterns, notable dependencies, and areas of complexity or tech debt.

**Example usage:**
```
ac "/explore"
ac "/explore focus on the API layer"
```

**Tips:**
- Great first command when starting on an unfamiliar codebase
- Run before `/plan-task` to build context for complex changes
- The report identifies tech debt and complexity hotspots

---

### /refactor

**Description:** Refactor code for clarity without changing behavior

**What it does:** Reads all affected code to understand the full picture, then makes incremental improvements: extracting repeated patterns (3+ occurrences), simplifying complex conditionals, improving naming, removing dead code, and reducing nesting depth. Verifies after each change that nothing is broken.

**Example usage:**
```
ac "/refactor src/api/handlers.ts"
ac --yolo "/refactor"
```

**Tips:**
- Strictly behavior-preserving -- will not change what the code does
- Will not change public APIs without discussing it first
- Will not add unnecessary abstractions or "improve" already-clear code

---

### /init

**Description:** Initialize AshlrCode for a new project (create ASHLR.md)

**What it does:** Explores the project structure, reads package.json / Cargo.toml / requirements.txt and README.md, identifies the framework, language, test commands, build commands, and coding conventions, then creates an ASHLR.md file with sections for architecture, commands (build, test, run), and conventions. This file helps AshlrCode work effectively on the project in future sessions.

**Example usage:**
```
ac "/init"
```

**Tips:**
- Run this once when you first start using AshlrCode on a project
- The generated ASHLR.md is concise and focused on what an AI assistant needs
- Edit the generated file to add project-specific instructions or conventions

---

### /deep-work

**Description:** Strategic session kickoff with parallel exploration before acting

**What it does:** Runs a multi-phase investigation before writing any code. First recovers context from memory files, git state, and Entire.io sessions. Then classifies the task by type (feature, bug, refactor, etc.) and scope (surgical to architectural). Deploys parallel exploration agents scaled to task complexity -- always a Patterns and Conventions agent, plus Impact, Risk, Architecture, and Prior Art agents for larger tasks. Synthesizes findings into a brief with situation, approach, key findings, and risks. Finally presents strategic questions and an execution plan.

**Example usage:**
```
ac "/deep-work add Stripe payment integration"
ac "/deep-work refactor the notification system to support multiple channels"
```

**Tips:**
- Scales investigation depth to task complexity -- simple tasks get 1 agent and ship fast
- The Patterns agent is the most important -- it finds existing code to reuse
- For small tasks (1-2 files), the brief, plan, and questions come in a single response
- For large tasks, questions come first so your answers can shape the plan

---

### /polish

**Description:** Autonomous polish pipeline -- commit, lint, review, security, fix loop until clean

**What it does:** Runs an autonomous multi-step pipeline: (1) commits current changes, (2) runs lint and type-checking, fixing any errors, (3) launches parallel code review and simplification agents, (4) performs a security audit checking for injection, auth gaps, secrets, XSS, and CSRF issues, (5) applies all fixes and re-checks, (6) re-commits and loops back up to 3 iterations until the code is clean. Pushes after each commit. Produces a final summary with iteration count, findings fixed, and commit hashes.

**Example usage:**
```
ac "/polish"
ac --yolo "/polish"
```

**Tips:**
- Runs fully autonomously -- no confirmation prompts between steps
- Maximum 3 iterations to avoid infinite loops
- Combines the work of `/commit`, `/review`, `/simplify`, and a security audit in one command
- Best used when you want to ship clean code quickly

---

### /daily-review

**Description:** Morning status check across projects, inbox, and blockers

**What it does:** Checks the Obsidian inbox for captured items (highlighting urgent ones), reads each project's STATE.md to show current phase and progress with visual progress bars, lists any active blockers across projects, and presents quick action options: process inbox, continue GSD work, or plan the day. Optionally creates a daily note from a template.

**Example usage:**
```
ac "/daily-review"
```

**Tips:**
- Best run at the start of each workday
- Integrates with GSD project tracking and Obsidian inbox
- Presents a menu of next actions so you can jump straight into productive work

---

### /weekly-plan

**Description:** Weekly progress review and priority setting across projects

**What it does:** Aggregates completions from the past 7 days (phases completed, features shipped, bugs fixed), identifies carried-over and stale items, analyzes cross-project resource allocation and conflicts, suggests 3-5 key objectives for the week pulled from GSD roadmaps, and updates the weekly review dashboard. Asks for approval before finalizing.

**Example usage:**
```
ac "/weekly-plan"
```

**Tips:**
- Best run on Monday morning
- Saves decisions to project decision logs
- Updates GSD STATE.md files if priorities change
- Shows team allocation percentages across projects

---

### /resume-branch

**Description:** Switch branches with full context restoration from Entire.io

**What it does:** Switches to an existing branch and restores AI session context from Entire.io using `entire resume`. Shows a summary of recent checkpoints and commits on the branch, identifies what was previously accomplished, what files were recently modified, and any unfinished work or next steps. Falls back to a plain `git checkout` with git log summary if no Entire checkpoints exist.

**Example usage:**
```
ac "/resume-branch feature/auth-flow"
ac "/resume-branch fix/login-crash"
```

**Tips:**
- Replaces a plain `git checkout` by also restoring session context
- Works across all Ashlar projects
- If no checkpoints exist on the branch, it falls back gracefully to git log

---

## Creating Custom Skills

You can create your own skills by writing a Markdown file with YAML frontmatter and a prompt body.

### Skill File Format

```markdown
---
name: my-skill
description: A short description of what this skill does
trigger: /my-skill
---

Your prompt instructions go here. These are sent to the AI
when the user types the trigger command.

Use {{args}} to capture everything the user types after the command.

For example, if the user types:
  /my-skill fix the login page

Then {{args}} will contain "fix the login page".
```

### Required Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for the skill |
| `description` | No | Human-readable description (defaults to `name` if omitted) |
| `trigger` | Yes | The slash command that invokes this skill (e.g., `/my-skill`) |

### Template Variables

- `{{args}}` -- Replaced with everything the user types after the slash command. This is the primary way to pass context into a skill.

### Where Skills Are Loaded From

Skills are loaded from three locations, in order of precedence:

1. **Built-in skills** -- `prompts/skills/*.md` (shipped with AshlrCode)
2. **User skills** -- `~/.ashlrcode/skills/*.md` (your personal skills, available in all projects)
3. **Project skills** -- `.ashlrcode/skills/*.md` (project-specific skills, in the repo root)

If the same skill name appears in multiple locations, later sources override earlier ones. This means:
- Project skills override user skills
- User skills override built-in skills

This lets you customize built-in behavior per-project or globally.

### Example Custom Skill

Create `~/.ashlrcode/skills/changelog.md`:

```markdown
---
name: changelog
description: Generate a changelog entry from recent commits
trigger: /changelog
---

Generate a changelog entry for the latest release.

1. Run `git log --oneline` from the last tag to HEAD
2. Group commits by type (features, fixes, refactors)
3. Write a human-readable changelog entry in Keep a Changelog format
4. Append to CHANGELOG.md

{{args}}
```

Then use it: `ac "/changelog for version 2.1.0"`
