# AshlrCode (ac)

**Multi-provider AI coding agent CLI with Claude Code-level features.**

[![Version](https://img.shields.io/badge/version-2.0.0-blue)]()
[![Tests](https://img.shields.io/badge/tests-124%20passing-green)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)]()
[![Runtime](https://img.shields.io/badge/runtime-Bun-black)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

**31 tools | 15 skills | 6 providers | 124 tests | 11K+ lines TypeScript/Bun**

Open-source (MIT), CI/CD-ready, npm publish-ready. Built as a Claude Code alternative that runs on xAI Grok ($0.001/request average) when Claude usage is exhausted.

---

## Quick Start

```bash
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install
bun link                    # makes 'ac' and 'ashlrcode' available globally

export XAI_API_KEY="your-key-here"

ac                          # interactive REPL
ac "do something"           # single-shot mode
ac --continue               # resume last session in this directory
ac --resume <id>            # resume specific session
ac --fork-session <id>      # copy session history into new session
```

---

## What's New in v2.0.0

- **Ink UI** — full React-based terminal rendering (replaces readline), input box with speech bubbles
- **Buddy system** — ASCII companion beside input with mood-based poses and satirical quips
- **Autopilot** — autonomous scan, queue, approve, auto mode (scan → fix → test → PR → merge)
- **Image support** — drag-and-drop image input with smart paste collapse
- **PowerShell tool** — Windows-native shell execution
- **Context collapse** — 3-tier context compression with `contextCollapse`
- **Slash command autocomplete** — Tab completion for skills and commands
- **Mode switching** — Shift+Tab to switch modes inline
- **Open-source release** — MIT license, CI/CD pipeline, npm publish ready

---

## 31 Built-in Tools

| Category | Tools |
|----------|-------|
| **File Operations** | Read, Write, Edit, NotebookEdit, LS |
| **Search** | Glob, Grep, ToolSearch, WebSearch |
| **Execution** | Bash (live streaming), PowerShell (Windows) |
| **Research** | WebFetch, WebSearch, Diff |
| **Interaction** | AskUser (structured options with labels) |
| **Agents** | Agent (parallel sub-agents), SendMessage |
| **Tasks** | TaskCreate, TaskUpdate, TaskList, TodoWrite |
| **Planning** | EnterPlan, PlanWrite, ExitPlan |
| **Memory** | MemorySave, MemoryList, MemoryDelete |
| **Config** | Config (view/modify settings) |
| **Git** | EnterWorktree, ExitWorktree |
| **Utility** | Sleep (polling/backoff) |

---

## 15 Built-in Skills (Slash Commands)

| Skill | Description |
|-------|-------------|
| `/commit` | Git commit with proper protocol |
| `/review` | Code review for bugs and security |
| `/simplify` | Refine code for clarity |
| `/pr` | Create a pull request |
| `/plan-task` | Enter plan mode for complex tasks |
| `/test` | Run tests and fix failures |
| `/debug` | Systematic root-cause debugging |
| `/explore` | Deep codebase architecture analysis |
| `/refactor` | Behavior-preserving improvements |
| `/init` | Generate ASHLR.md for new projects |
| `/deep-work` | Strategic session kickoff with parallel exploration |
| `/polish` | Autonomous lint, review, security, fix loop |
| `/daily-review` | Morning status check across projects |
| `/weekly-plan` | Weekly progress review and planning |
| `/resume-branch` | Switch branches with context restoration |

Custom skills: add `.md` files to `~/.ashlrcode/skills/`

---

## Autopilot

Autonomous codebase scanner and work queue:

```bash
ac /autopilot              # scan codebase, build work queue
ac /autopilot approve      # review and approve queued items
ac /autopilot auto         # fully autonomous: scan → fix → test → PR → merge
```

Autopilot scans your codebase for issues (lint, type errors, security, TODOs), queues fixes, and can execute them autonomously with test verification.

---

## Image Support

Drag-and-drop images directly into the terminal. AshlrCode processes images inline with smart paste collapse — large base64 payloads are automatically compressed in the context window.

---

## Smart Paste

Large clipboard pastes are automatically collapsed to preserve context. The full content is available to the agent but displayed compactly in the conversation history.

---

## MCP Server Support

Connect external tools via Model Context Protocol:

```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase", "--access-token", "..."],
    }
  }
}
```

MCP tools appear as `mcp__<server>__<tool>` and work like any built-in tool.

---

## Hook System

Pre/post tool execution hooks for automation and safety:

```json
{
  "hooks": {
    "preToolUse": [
      { "toolName": "Bash", "inputPattern": "rm -rf", "action": "deny", "message": "Blocked" },
      { "toolName": "Bash", "inputPattern": "git push", "action": "ask" }
    ],
    "postToolUse": [
      { "toolName": "Edit", "command": "bun run lint --fix $TOOL_INPUT" }
    ]
  }
}
```

---

## Key Features

### Ink-Based Terminal UI
Full React-based terminal rendering via Ink. Input box with borders, context bar, ASCII buddy companion with mood-based poses and speech bubbles. Slash command autocomplete with Tab, mode switching with Shift+Tab.

### Parallel Tool Execution
Concurrency-safe tools (Read, Glob, Grep, WebFetch, Agent, LS) run in parallel via `Promise.all()`. Unsafe tools (Bash, Write, Edit) run sequentially.

### Context Management
3-tier compression keeps conversations efficient:
1. **autoCompact** — summarize older messages when approaching limits
2. **snipCompact** — truncate verbose tool results
3. **contextCollapse** — collapse large pastes, images, and repetitive content
4. **Provider-aware limits** — xAI 2M tokens, Anthropic 200K

### Provider Retry
Automatic exponential backoff:
- Rate limits (429): 3 retries, 1s→2s→4s
- Network errors: 2 retries, 2s base
- Auth errors: immediate fail with clear message

### Session Persistence
- Conversations saved as JSONL at `~/.ashlrcode/sessions/`
- `ac --continue` resumes last session in current directory
- `ac --resume <id>` resumes specific session
- `ac --fork-session <id>` copies history into new session

### Permission System
- Read-only tools auto-allowed (no prompts)
- `[y]es / [a]lways / [n]o / [d]eny-always` for write tools
- Persisted across sessions in `~/.ashlrcode/permissions.json`

### File Undo
Every Write/Edit snapshots the file first. `/restore <path>` reverts.

### Plan Mode
Enter plan mode for complex tasks: explore codebase read-only, ask strategic questions, write a detailed plan, get approval, then execute.

### Memory System
Save persistent per-project context that carries across sessions. The model loads memories automatically in future conversations.

### Buddy System
ASCII companion beside the input box with mood-based poses, speech bubbles, and satirical quips. Reacts to agent state and conversation context.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `/plan` | Plan mode status |
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
| `/autopilot` | Autonomous scanner + work queue |
| `/help` | All commands |
| `/quit` | Exit |

Multi-line input: end a line with `\` to continue.

---

## Providers

| Provider | Model | Cost/M tokens | Context |
|----------|-------|---------------|---------|
| **xAI** (primary) | grok-4-1-fast-reasoning | $0.20 in / $0.50 out | 2M |
| **Anthropic** (fallback) | claude-sonnet-4-6 | $3 in / $15 out | 200K |
| **OpenAI** | gpt-4o | $2.50 in / $10 out | 128K |
| **Ollama** (local) | any local model | Free | Model limit |
| **Groq** | llama-3.3-70b | $0.59 in / $0.79 out | 128K |
| **DeepSeek** | deepseek-chat | $0.14 in / $0.28 out | 128K |

Auto-failover on rate limits. Model aliases: `grok-fast`, `grok-4`, `grok-3`, `sonnet`, `opus`, `haiku`.

---

## Bifrost: Use Claude Code with Grok

Route Claude Code itself through xAI Grok when your Max plan runs out:

```bash
./scripts/bifrost-setup.sh                                        # Terminal 1
ANTHROPIC_BASE_URL=http://localhost:8080/anthropic claude          # Terminal 2
```

---

## Configuration

| Path | Purpose |
|------|---------|
| `~/.ashlrcode/settings.json` | Providers, hooks, MCP servers |
| `~/.ashlrcode/permissions.json` | Tool permission rules |
| `~/.ashlrcode/sessions/` | Saved sessions (JSONL) |
| `~/.ashlrcode/plans/` | Plan files |
| `~/.ashlrcode/memory/` | Per-project persistent memory |
| `~/.ashlrcode/tasks/` | Persisted task boards |
| `~/.ashlrcode/skills/` | Custom skill definitions |
| `./ASHLR.md` or `./CLAUDE.md` | Project-level instructions |

---

## Architecture

```
src/
├── cli.ts                  # Entry point, Ink UI, REPL, 15+ commands
├── agent/
│   ├── loop.ts             # Core agent loop (AsyncGenerator streaming)
│   ├── context.ts          # 3-tier compression, provider-aware limits
│   ├── sub-agent.ts        # Sub-agent spawning
│   ├── tool-executor.ts    # Parallel tool execution
│   └── error-handler.ts    # Error categorization + retry
├── providers/
│   ├── types.ts            # Unified provider interface
│   ├── xai.ts              # xAI Grok (OpenAI SDK) + retry
│   ├── anthropic.ts        # Claude (Anthropic SDK) + retry
│   └── router.ts           # Selection, failover, cost tracking
├── tools/                  # 31 tools (incl. PowerShell)
├── mcp/                    # MCP client + manager
├── skills/                 # Skill loader + registry
├── planning/               # Plan mode + tools
├── persistence/            # Sessions + memory
├── config/                 # Settings, hooks, permissions, git
├── state/                  # File history (undo)
├── ui/                     # Ink components, buddy, speech bubbles
└── __tests__/              # 10+ test files, 124 tests
```

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, setup, first use, common workflows |
| [Tool Reference](docs/tools.md) | All 31 tools with parameters, examples, and notes |
| [Skills Guide](docs/skills.md) | All 15 skills + how to create custom ones |
| [CLI Reference](docs/cli-reference.md) | Every flag, command, and environment variable |
| [Configuration](docs/configuration.md) | Settings, hooks, MCP servers, permissions |
| [Examples](docs/examples.md) | 20 real-world usage patterns |
| [Architecture](docs/architecture.md) | How AshlrCode works internally |
| [Migration from Claude Code](docs/migration-from-claude-code.md) | Side-by-side feature comparison |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |

---

## Testing

```bash
bun test                    # 124 tests, 200+ assertions, ~8s
```

## Development

```bash
bun run start               # Run CLI
bun run dev                 # Watch mode
bunx tsc --noEmit           # Type check
```

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up your dev environment, run tests, add tools/skills, and submit PRs.

## License

MIT License
