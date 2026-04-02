# Getting Started with AshlrCode

AshlrCode (`ac`) is a multi-provider AI coding agent that runs in your terminal. It reads your code, makes changes, runs commands, and answers questions — powered by xAI Grok, Anthropic Claude, or any OpenAI-compatible model.

## Installation

### Prerequisites
- [Bun](https://bun.sh) (v1.0+)
- An API key from [xAI](https://console.x.ai/) or [Anthropic](https://console.anthropic.com/)

### Install from source

```bash
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install
bun link
```

This makes `ac` and `ashlrcode` available as global commands.

### Verify installation

```bash
ac --version
# AshlrCode v1.5.0
```

## First Run

Run `ac` in any project directory:

```bash
cd ~/my-project
ac
```

If this is your first time, the setup wizard will guide you:

```
  Welcome to AshlrCode
  Multi-provider AI coding agent CLI

  Let's get you set up. This takes about 30 seconds.

  Step 1: Choose your AI provider

  1. xAI Grok — $0.20/$0.50 per M tokens, 2M context (recommended)
  2. Anthropic Claude — $3/$15 per M tokens, 200K context
  3. Both — xAI primary, Claude fallback

  Provider [1/2/3]: 1

  Get an xAI API key at: https://console.x.ai/

  xAI API key: xai-...

  Setup complete!
  Config saved to: ~/.ashlrcode/settings.json
```

Alternatively, set your API key as an environment variable:

```bash
export XAI_API_KEY="xai-your-key-here"
ac
```

## Your First Task

Once inside AshlrCode, just type what you want done:

```
  AshlrCode v1.5.0 | xai:grok-4-1-fast-reasoning
  /Users/you/my-project
  Type a message to start. /help for commands, /skills for skills, Ctrl+C to exit.

❯ find all TypeScript files that import React and list them
```

AshlrCode will:
1. Use the **Glob** tool to find `.tsx` files
2. Use **Grep** to search for React imports
3. Return the results with file paths

## Common Workflows

### Fix a bug
```
❯ the signup form crashes when the email field is empty. debug and fix it.
```

### Add a feature
```
❯ add input validation to the login form. email must be valid, password min 8 chars.
```

### Review code
```
❯ /review
```
The `/review` skill analyzes your recent changes for bugs, security issues, and code quality.

### Commit your changes
```
❯ /commit
```
The `/commit` skill runs `git status`, `git diff`, drafts a message, stages files, and commits.

### Explore a new codebase
```
❯ /explore
```
The `/explore` skill maps the directory structure, reads key files, and explains the architecture.

## Modes

### Interactive mode (default)
```bash
ac
```
Opens a REPL where you type messages and see streaming responses.

### Single-shot mode
```bash
ac "add a loading spinner to the dashboard"
```
Runs one task and exits.

### YOLO mode (skip all permission prompts)
```bash
ac --yolo "refactor the auth module"
```
Auto-approves all tool calls. Use when you trust the model.

### Print mode (for scripting)
```bash
ac --print "explain this error" | pbcopy
```
Outputs only the model's text — no spinner, no tool UI, no cost summary.

### Plan mode
```
❯ /plan-task add user authentication with OAuth
```
Enters read-only mode: explores the codebase, asks you strategic questions, writes a plan, then waits for approval before making changes.

## Session Management

Your conversations are automatically saved:

```bash
# Resume your last session in this directory
ac --continue
ac -c

# Resume a specific session
ac --resume abc123

# List all saved sessions
# (inside REPL)
❯ /sessions
```

## Cost Tracking

Every request shows cost:
```
Total: $0.003 | 12,450 in / 234 out / 890 reasoning
  xai: $0.003 (grok-4-1-fast-reasoning)
```

Set a spending limit:
```bash
ac --max-cost 1.00
```

View cumulative cost in the REPL:
```
❯ /cost
```

## Project Configuration

Create an `ASHLR.md` file in your project root to give AshlrCode project-specific context:

```bash
❯ /init
```

Or create it manually:

```markdown
# My Project

## Architecture
- Next.js 14 with App Router
- Tailwind CSS for styling
- Prisma + PostgreSQL for data

## Commands
- `bun run dev` — start dev server
- `bun test` — run tests
- `bun run build` — production build

## Conventions
- Components in src/components/
- API routes in src/app/api/
- Use server components by default
```

## Getting Help

```
❯ /help          # all REPL commands
❯ /tools         # list all 30 tools
❯ /skills        # list all 15 skills
```

## Next Steps

- Read the [Tool Reference](tools.md) for detailed documentation of all 30 tools
- Read the [Skills Guide](skills.md) to learn about slash commands
- Read the [Configuration Guide](configuration.md) to customize hooks, MCP servers, and permissions
- Read the [CLI Reference](cli-reference.md) for all flags and options
- Read [Examples](examples.md) for 20 real-world usage patterns
