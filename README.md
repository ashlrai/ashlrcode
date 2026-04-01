# AshlrCode (ac)

Multi-provider AI coding agent CLI. Built for the AshlrAI team as a Claude Code alternative that runs on xAI Grok when Claude usage is exhausted.

## Quick Start

```bash
# Install
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install
bun link  # makes 'ac' and 'ashlrcode' available globally

# Set your xAI API key
export XAI_API_KEY="your-key-here"

# Run
ac                          # interactive REPL
ac "list all TypeScript files in src/"  # single-shot mode
```

## Features

**Provider Flexibility**
- Primary: xAI Grok 4.1 Fast ($0.20/$0.50 per million tokens, 2M context)
- Fallback: Anthropic Claude (when available)
- Auto-failover on rate limits with cost tracking

**15 Built-in Tools**
- File operations: Read, Write, Edit
- Search: Glob (file patterns), Grep (content search)
- Execution: Bash (shell commands)
- Research: WebFetch (HTTP requests)
- Interaction: AskUser (structured questions with options)
- Planning: EnterPlan, PlanWrite, ExitPlan
- Multi-agent: Agent (spawn sub-agents for exploration)
- Task tracking: TaskCreate, TaskUpdate, TaskList

**Plan Mode**
- Enter plan mode for read-only codebase exploration
- Model asks strategic questions with structured options
- Writes a detailed plan to disk before executing
- User approves plan, then execution begins

**Context Management**
- 3-tier compression: autoCompact, snipCompact, token estimation
- Automatic compaction when approaching context limits
- Session persistence with JSONL logs and resume support

**Session Persistence**
- Conversations saved to `~/.ashlrcode/sessions/`
- Resume with `ac --resume <session-id>`
- List sessions with `/sessions` command

## Commands (in REPL)

| Command | Description |
|---------|-------------|
| `/plan` | Show plan mode status |
| `/cost` | Show token usage and costs |
| `/compact` | Manually compress context |
| `/sessions` | List saved sessions |
| `/model` | Show current model |
| `/clear` | Clear conversation |
| `/help` | Show all commands |
| `/quit` | Exit |

## Bifrost: Use Claude Code with Grok

You can also route Claude Code itself through xAI Grok using Bifrost:

```bash
# Terminal 1: Start Bifrost proxy
./scripts/bifrost-setup.sh

# Terminal 2: Use Claude Code with Grok
ANTHROPIC_BASE_URL=http://localhost:8080/anthropic ANTHROPIC_API_KEY=dummy-key claude
```

## Configuration

**Environment Variables**
- `XAI_API_KEY` — xAI API key (primary)
- `ANTHROPIC_API_KEY` — Claude API key (fallback)
- `AC_MODEL` — Override model (default: `grok-4-1-fast-reasoning`)

**Files**
- `~/.ashlrcode/settings.json` — Provider configuration
- `~/.ashlrcode/sessions/` — Saved sessions
- `~/.ashlrcode/plans/` — Plan files
- `~/.ashlrcode/memory/` — Per-project memory
- `./ASHLR.md` or `./CLAUDE.md` — Project-level instructions

## Architecture

Built with TypeScript + Bun. Inspired by Claude Code's 12-layer architecture.

```
src/
├── cli.ts              # Entry point + REPL
├── agent/
│   ├── loop.ts         # Core agent loop (AsyncGenerator streaming)
│   ├── context.ts      # Context compression (3-tier)
│   └── sub-agent.ts    # Sub-agent spawning
├── providers/
│   ├── types.ts        # Unified provider interface
│   ├── xai.ts          # xAI Grok (OpenAI SDK)
│   ├── anthropic.ts    # Claude (Anthropic SDK)
│   └── router.ts       # Provider selection + failover
├── tools/              # 15 tools with registry pattern
├── planning/           # Plan mode + plan tools
├── persistence/        # Sessions + memory
└── config/             # Settings + permissions
```

## License

Private — AshlrAI internal tooling.
