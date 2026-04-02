# AshlrCode Usage Examples

Real-world examples showing how to use AshlrCode for common development tasks.

---

## 1. Fix a Bug

```
ac "the login form crashes when email is empty"
```

AshlrCode searches the codebase for login form code, identifies the crash (likely a missing null check or unvalidated input), applies the fix, and verifies the form handles empty email gracefully. It reads test files if they exist and ensures the fix does not break other behavior.

---

## 2. Add a Feature

```
ac "add dark mode toggle to the settings page"
```

AshlrCode explores the existing settings page component, identifies the styling approach (CSS variables, Tailwind, styled-components, etc.), adds a toggle component following existing UI patterns, wires it to a theme state (localStorage or user preferences), and updates related styles. It follows the project's component conventions found in ASHLR.md or by scanning existing code.

---

## 3. Refactor Code

```
ac --yolo "/refactor src/api/handlers/"
```

AshlrCode reads all handler files, identifies repeated patterns, complex conditionals, dead code, and poor naming. It makes incremental improvements -- extracting shared logic, simplifying nested conditions, improving variable names -- and verifies after each change that nothing breaks. The `--yolo` flag lets it apply changes without asking for confirmation at each step.

---

## 4. Review a PR

```
ac "/review"
```

AshlrCode runs `git diff` to see all current changes, reads each modified file for full context, and produces a review organized by severity. Example output:

```
src/auth/session.ts:42 [critical]
  Token expiry is compared with `>` instead of `>=`, allowing expired tokens
  for 1 second. Fix: change to `>=`.

src/api/users.ts:88 [warning]
  Missing error handling if database query returns null.
  Fix: add null check before accessing user.email.
```

---

## 5. Create a Commit

```
ac "/commit"
```

AshlrCode runs `git status` and `git diff`, analyzes all changes, checks recent commit messages to match the repo's style, then stages files individually (never `git add .`) and creates a commit. It skips any files containing secrets. The commit message focuses on why the change was made, not just what changed.

---

## 6. Debug an Error

```
ac "/debug TypeError: Cannot read properties of undefined"
```

AshlrCode searches for the error source by grepping for the property access pattern, traces the code path to find where the undefined value originates, identifies the root cause (e.g., an API response missing an expected field), applies the minimal fix (adding a null check or default value at the right level), and checks for similar patterns elsewhere in the codebase.

---

## 7. Explore a New Codebase

```
ac "/explore"
```

AshlrCode maps the directory structure, reads package.json and config files, greps for patterns like exports, routes, and class definitions, and produces a structured report:

```
Project: React + Express monorepo
Framework: Next.js 14 (App Router) + Express API
Structure: apps/web, apps/api, packages/shared
Entry points: apps/web/app/layout.tsx, apps/api/src/index.ts
Key patterns: Server components, tRPC for type-safe API calls
Dependencies: Prisma ORM, NextAuth, Tailwind CSS
Tech debt: Mixed auth patterns (JWT in API, session in web)
```

---

## 8. Run and Fix Tests

```
ac --yolo "/test"
```

AshlrCode detects the test framework from package.json (e.g., vitest), runs the test suite, and if any tests fail, reads the failing tests and source code to diagnose the issue. It fixes the source code (not the tests) and re-runs until all tests pass. The `--yolo` flag allows it to run commands and apply fixes without pausing for confirmation.

---

## 9. Create a PR

```
ac "/pr"
```

AshlrCode analyzes all commits on the current branch, pushes to the remote if needed, and creates a pull request via `gh pr create`:

```
Created PR #47: Add email validation to signup flow
https://github.com/your-org/your-repo/pull/47

## Summary
- Add client-side email format validation
- Add server-side validation with descriptive error messages
- Handle edge cases: empty input, whitespace-only, missing @ symbol

## Test plan
- [ ] Submit form with empty email
- [ ] Submit form with invalid format
- [ ] Submit form with valid email
```

---

## 10. Script Automation

```
ac --print --yolo "list all TODO comments with file and line number" > todos.txt
```

The `--print` flag outputs results as plain text (no interactive UI), and `--yolo` allows running grep/search commands without confirmation. This pipes the output directly to a file. Useful for CI pipelines, reports, and scripting. Other examples:

```
ac --print "summarize what changed in the last 5 commits" > changelog-draft.txt
ac --print --yolo "find all API endpoints and their HTTP methods" > api-map.txt
```

---

## 11. Initialize a Project

```
ac "/init"
```

AshlrCode scans the project structure, reads config files and README, and creates an ASHLR.md file:

```markdown
# MyApp

SaaS dashboard built with Next.js and Supabase.

## Architecture
- Next.js 14 App Router with React Server Components
- Supabase for auth, database, and realtime
- Tailwind CSS + shadcn/ui components

## Commands
- Dev server: `npm run dev`
- Tests: `npm test`
- Build: `npm run build`
- Lint: `npm run lint`

## Conventions
- Components in PascalCase, one per file
- API routes use Route Handlers in app/api/
- Database queries go through lib/db.ts
```

Run this once when starting a new project. Edit the generated file to add anything AshlrCode should know.

---

## 12. Plan a Complex Task

```
ac "/plan-task add user authentication with OAuth and email/password"
```

AshlrCode enters plan mode: it explores the codebase for existing auth patterns, reads the database schema, checks what auth libraries are already installed, then writes a detailed plan covering which files to create or modify, the implementation sequence, existing utilities to reuse, and how to verify the feature works end-to-end. You review and approve the plan before any code changes happen.

---

## 13. Switch Models

Inside an AshlrCode session, type:

```
/model grok-4
```

This switches the underlying model for the current session. Useful for:
- Switching to a faster model for simple tasks
- Using a specific provider's model for specialized work
- Testing how different models handle the same prompt

---

## 14. Resume a Session

```
ac --continue
```

Resumes the most recent AshlrCode session with its full conversation history. The AI picks up exactly where you left off, with all context about what was discussed and changed. No need to re-explain the task or re-explore the codebase.

---

## 15. Set Up an MCP Server

Add an MCP server to your settings file (`~/.ashlrcode/settings.json`):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432/mydb"]
    }
  }
}
```

MCP servers give AshlrCode access to external tools -- databases, APIs, browsers, and more. Once configured, the tools are available automatically in every session.

---

## 16. Create a Custom Skill

Create a file at `~/.ashlrcode/skills/migrate.md`:

```markdown
---
name: migrate
description: Generate and run a database migration
trigger: /migrate
---

Create a database migration for the requested schema change.

1. Read the current schema from prisma/schema.prisma (or equivalent)
2. Add the requested change to the schema
3. Run the migration command: `npx prisma migrate dev --name {{args}}`
4. Verify the migration was created and applied successfully
5. If using Prisma, run `npx prisma generate` to update the client

{{args}}
```

Now use it:

```
ac "/migrate add verified_at timestamp to users table"
```

The skill is loaded automatically from `~/.ashlrcode/skills/` and available in all projects.

---

## 17. Add a Hook

Add a pre-command hook to your settings (`~/.ashlrcode/settings.json`) to block dangerous operations:

```json
{
  "hooks": {
    "preCommand": [
      {
        "pattern": "rm -rf /",
        "action": "block",
        "message": "Blocked: recursive delete from root"
      },
      {
        "pattern": "git push.*--force.*main",
        "action": "block",
        "message": "Blocked: force push to main"
      },
      {
        "pattern": "DROP TABLE|DROP DATABASE",
        "action": "confirm",
        "message": "This will drop database objects. Are you sure?"
      }
    ]
  }
}
```

Hooks intercept commands before they run. Use `"action": "block"` to prevent execution entirely, or `"action": "confirm"` to require manual approval.

---

## 18. Cost Tracking

Inside a session, type:

```
/cost
```

AshlrCode displays token usage and estimated cost for the current session:

```
Session cost: $0.42
  Input tokens:  125,000
  Output tokens:  18,500
  Cache reads:    85,000
```

To set a spending limit for a session:

```
ac --max-cost 2.00 "refactor the entire API layer"
```

AshlrCode will pause and ask before continuing if the session approaches the $2.00 limit. Useful for keeping costs predictable on large tasks.

---

## 19. File Undo

After AshlrCode makes a bad edit, use the restore command inside the session:

```
/restore src/api/auth.ts
```

This reverts the file to its state before AshlrCode modified it. Works for any file changed during the current session. You can also undo all changes:

```
/restore --all
```

This is safer than `git checkout` because it only undoes AshlrCode's changes, preserving any manual edits you made before the session.

---

## 20. Multi-Provider Fallback

Configure multiple providers in `~/.ashlrcode/settings.json`:

```json
{
  "providers": [
    {
      "name": "anthropic",
      "apiKey": "sk-ant-...",
      "models": ["claude-sonnet-4-20250514"]
    },
    {
      "name": "openrouter",
      "apiKey": "sk-or-...",
      "models": ["anthropic/claude-sonnet-4-20250514"],
      "fallback": true
    }
  ]
}
```

When the primary provider (Anthropic) is rate-limited or experiencing an outage, AshlrCode automatically fails over to the next provider (OpenRouter) without interrupting your session. You see a brief notification:

```
[provider] Anthropic rate limited, switching to OpenRouter
```

The session continues seamlessly with the same model via the fallback provider. When the primary provider recovers, subsequent sessions use it again automatically.
