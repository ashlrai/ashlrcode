# AshlrCode (ac)

Multi-provider AI coding agent CLI with Claude Code-level features. Built for the AshlrAI team — runs on xAI Grok ($0.001/request) when Claude usage is exhausted.

**26 tools | 10 skills | MCP support | 88 tests | 7,000+ lines TypeScript/Bun**

## Quick Start

```bash
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install
bun link        # makes 'ac' and 'ashlrcode' available globally

export XAI_API_KEY="your-key"
ac              # interactive REPL
ac "do something"           # single-shot
ac --continue               # resume last session
ac --resume <id>            # resume specific session
```

## Features

### 26 Built-in Tools

| Category | Tools |
|----------|-------|
| **File Operations** | Read, Write, Edit, NotebookEdit, LS |
| **Search** | Glob, Grep, ToolSearch, WebSearch |
| **Execution** | Bash (with live streaming) |
| **Research** | WebFetch, WebSearch |
| **Interaction** | AskUser (structured options) |
| **Agent** | Agent (sub-agents), SendMessage |
| **Tasks** | TaskCreate, TaskUpdate, TaskList |
| **Planning** | EnterPlan, PlanWrite, ExitPlan |
| **Memory** | MemorySave, MemoryList, MemoryDelete |
| **Config** | Config (view/modify settings) |
| **Git** | EnterWorktree, ExitWorktree |

### 10 Built-in Skills (Slash Commands)

| Skill | Description |
|-------|-------------|
| `/commit` | Git commit with proper protocol |
| `/review` | Code review for bugs and security |
| `/simplify` | Refine code for clarity |
| `/pr` | Create a pull request |
| `/plan-task` | Enter plan mode for complex tasks |
| `/test` | Run tests and fix failures |
| `/debug` | Systematic debugging |
| `/explore` | Deep codebase analysis |
| `/refactor` | Behavior-preserving improvements |
| `/init` | Generate ASHLR.md for new projects |

### MCP Server Support

Connect external tools via Model Context Protocol:

```json
// ~/.ashlrcode/settings.json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

MCP tools appear as `mcp__<server>__<tool>` and work like any built-in tool.

### Hook System

Pre/post tool execution hooks for automation:

```json
{
  "hooks": {
    "preToolUse": [
      { "toolName": "Bash", "inputPattern": "rm -rf", "action": "deny", "message": "Refusing rm -rf" }
    ],
    "postToolUse": [
      { "toolName": "Edit", "command": "bun run lint --fix $TOOL_INPUT" }
    ]
  }
}
```

### Parallel Tool Execution

Concurrency-safe tools (Read, Glob, Grep, etc.) run in parallel via `Promise.all()`. Unsafe tools (Bash, Write, Edit) run sequentially.

### Context Management

3-tier compression keeps conversations efficient:
1. **autoCompact** — summarize older messages when approaching token limits
2. **snipCompact** — truncate verbose tool results
3. **Token tracking** — per-provider cost and token display

### Session Persistence

- Conversations saved as JSONL at `~/.ashlrcode/sessions/`
- `ac --continue` resumes the last session in the current directory
- `ac --resume <id>` resumes a specific session
- `ac --fork-session <id>` copies history into a new session

### Permission System

- Read-only tools auto-allowed (no prompts)
- `[y]es / [a]lways / [n]o / [d]eny-always` for write tools
- Choices persist across sessions in `~/.ashlrcode/permissions.json`

### File Undo

Every Write/Edit operation snapshots the file first. `/restore <path>` reverts to the previous version.

## CLI Commands

| Command | Description |
|---------|-------------|
| `/plan` | Show plan mode status |
| `/cost` | Token usage and costs |
| `/history` | Conversation turn history |
| `/undo` | Remove last turn |
| `/restore [path]` | Undo file changes |
| `/diff` | Git diff --stat |
| `/git` | Branch, remote, changes |
| `/tools` | List all registered tools |
| `/skills` | List available skills |
| `/memory` | View project memories |
| `/sessions` | List saved sessions |
| `/model [name]` | Show/switch model |
| `/compact` | Compress context |
| `/clear` | Clear conversation |
| `/help` | All commands |
| `/quit` | Exit |

Multi-line input: end a line with `\` to continue.

## Providers

| Provider | Model | Cost | Context |
|----------|-------|------|---------|
| xAI (primary) | grok-4-1-fast-reasoning | $0.20/$0.50 per M tokens | 2M |
| Anthropic (fallback) | claude-sonnet-4-6 | $3/$15 per M tokens | 200K |

Auto-failover on rate limits. Model aliases: `grok-fast`, `grok-4`, `grok-3`, `sonnet`, `opus`, `haiku`.

## Bifrost: Use Claude Code with Grok

Route Claude Code itself through xAI Grok:

```bash
./scripts/bifrost-setup.sh                    # Terminal 1: start proxy
ANTHROPIC_BASE_URL=http://localhost:8080/anthropic claude  # Terminal 2
```

## Configuration

| Path | Purpose |
|------|---------|
| `~/.ashlrcode/settings.json` | Providers, hooks, MCP servers |
| `~/.ashlrcode/permissions.json` | Tool permission rules |
| `~/.ashlrcode/sessions/` | Saved sessions (JSONL) |
| `~/.ashlrcode/plans/` | Plan files |
| `~/.ashlrcode/memory/` | Per-project memory |
| `~/.ashlrcode/tasks/` | Persisted task boards |
| `~/.ashlrcode/skills/` | Custom skill definitions |
| `./ASHLR.md` or `./CLAUDE.md` | Project-level instructions |

## Architecture

```
src/
├── cli.ts                  # Entry point, REPL, commands
├── agent/
│   ├── loop.ts             # Core agent loop (AsyncGenerator)
│   ├── context.ts          # 3-tier context compression
│   ├── sub-agent.ts        # Sub-agent spawning
│   ├── tool-executor.ts    # Parallel tool execution
│   └── error-handler.ts    # Error categorization + retry
├── providers/
│   ├── types.ts            # Unified provider interface
│   ├── xai.ts              # xAI Grok (OpenAI SDK)
│   ├── anthropic.ts        # Claude (Anthropic SDK)
│   └── router.ts           # Selection, failover, cost tracking
├── tools/                  # 26 tools
├── mcp/                    # MCP client + manager
├── skills/                 # Skill loader + registry
├── planning/               # Plan mode + tools
├── persistence/            # Sessions + memory
├── config/                 # Settings, hooks, permissions, git
├── state/                  # File history (undo)
└── ui/                     # Spinner, markdown renderer
```

## Testing

```bash
bun test                    # 88 tests, ~120ms
```

## Development

```bash
bun run start               # Run CLI
bun run dev                  # Run with watch mode
bunx tsc --noEmit           # Type check
```

## License

Private — AshlrAI internal tooling.
