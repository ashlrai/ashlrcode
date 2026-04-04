# AshlrCode (ac)

**Multi-provider AI coding agent for the terminal.**

[![Version](https://img.shields.io/badge/version-2.0.0-blue)]()
[![Tests](https://img.shields.io/badge/tests-335%20passing-green)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)]()
[![Runtime](https://img.shields.io/badge/runtime-Bun-black)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

**42+ tools | 42+ slash commands | 6 providers | 335 tests | 130 source files**

---

## What is AshlrCode?

AshlrCode is an open-source AI coding agent CLI built as an alternative to Claude Code. It runs multi-provider LLM conversations with tool use in your terminal — powered by xAI Grok by default, with failover to Anthropic, OpenAI, DeepSeek, Groq, and Ollama. It ships with 42+ built-in tools, an autonomous KAIROS mode, sub-agent orchestration, MCP server integration, and a persistent buddy companion.

---

## Install

```bash
bun install -g ashlrcode
```

> **Requires [Bun](https://bun.sh) runtime.** Install Bun with `curl -fsSL https://bun.sh/install | bash`.

```bash
export XAI_API_KEY="your-key"

ac                          # interactive REPL
ac "fix the login bug"      # single-shot mode
ac --continue               # resume last session
ac --resume <id>            # resume specific session
```

### From source

```bash
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install
bun link                    # makes 'ac' available globally
```

---

## Features

### Core

- **Agent loop** — AsyncGenerator-based streaming with parallel tool execution
- **Multi-provider failover** — automatic retry and provider switching on rate limits
- **3-tier context compression** — autoCompact, snipCompact, contextCollapse
- **Speculation** — speculative tool execution for faster responses
- **Model patches** — per-model prompt adjustments for optimal behavior
- **Global error handling** — uncaught exceptions caught with data loss prevention (session auto-save)
- **Autopilot mode** — fully autonomous scan → fix → test → PR → merge pipeline

### Tools (42+)

| Category | Tools | Description |
|----------|-------|-------------|
| **File I/O** | Read, Write, Edit, NotebookEdit, LS | Read, write, and edit files with undo snapshots |
| **Search** | Glob, Grep, ToolSearch | Pattern matching, regex search, tool discovery |
| **Execution** | Bash, PowerShell | Shell execution with live streaming and timeouts |
| **Web** | WebFetch, WebSearch, WebBrowser | HTTP requests, search engines, browser automation |
| **Interaction** | AskUser, SendMessage | Structured user prompts, inter-agent messaging |
| **Agents** | Agent, ListPeers | Parallel sub-agents, peer discovery |
| **Tasks** | TaskCreate, TaskUpdate, TaskList, TaskGet, TodoWrite | Task boards with dependencies and ownership |
| **Planning** | EnterPlan, PlanWrite, ExitPlan (via mode) | Read-only exploration then structured execution |
| **Memory** | MemorySave, MemoryList, MemoryDelete | Persistent per-project context across sessions |
| **Config** | Config | View and modify settings at runtime |
| **Git** | EnterWorktree, ExitWorktree, Diff | Isolated worktree branches, diff inspection |
| **Teams** | TeamCreate, TeamDelete, TeamList, TeamDispatch | Named teammate roles with task dispatch |
| **Infrastructure** | LSP, Workflow, Snip, Sleep | Language server, reusable workflows, context trimming, polling |
| **MCP** | ListMcpResources, mcp__*__* | External tool servers via Model Context Protocol |

### Commands (42+)

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/cost` | Token usage and cost breakdown |
| `/status` | Provider, context usage, session info |
| `/model [name]` | Show or switch model (aliases: `grok-fast`, `sonnet`, `opus`, `local`) |
| `/effort [level]` | Cycle or set effort level (low / normal / high) |
| `/compact` | Run all 3 context compression tiers |
| `/clear` | Clear conversation history |
| `/history` | File change history with timestamps |
| `/undo` | Revert last file change |
| `/restore` | Show available file snapshots |
| `/diff` | Git diff --stat |
| `/git` | Recent git log |
| `/plan` | Cycle mode (normal / plan / auto) |
| `/tools` | List all registered tools |
| `/skills` | List available slash-command skills |
| `/sessions` | List saved sessions |
| `/memory` | Show project memories |
| `/buddy` | Buddy stats, species, rarity, level |
| `/btw <question>` | Side question in sub-agent (no main context pollution) |
| `/autopilot` | Autonomous scan / queue / approve / run / auto |
| `/kairos <goal>` | Start KAIROS autonomous mode |
| `/trigger` | Scheduled triggers (add / list / toggle / delete) |
| `/voice` | Voice input via Whisper (record / transcribe) |
| `/sync` | Export / import settings across machines |
| `/bridge` | Bridge server status (HTTP API for external tools) |
| `/keybindings` | Show and customize keyboard shortcuts |
| `/features` | Feature flag status |
| `/patches` | Active model patches for current model |
| `/undercover` | Toggle undercover mode (stealth prompts) |
| `/remote` | Remote settings status |
| `/telemetry` | Recent telemetry events |
| `/quit` | Exit (also `/exit`, `/q`) |

Plus **custom skills** loaded from `~/.ashlrcode/skills/*.md` — invoked as `/skill-name`.

### Agent System

- **Sub-agents** — spawn parallel agents for research, exploration, and independent tasks
- **Worktree isolation** — agents work in git worktrees to avoid conflicts
- **KAIROS autonomous mode** — heartbeat-driven loop with focus-aware autonomy levels
- **Team dispatch** — named teammates with roles, dispatched to tasks
- **IPC** — inter-process communication between agent instances
- **Peer discovery** — agents find and message sibling instances

### UX

- **Ink-based UI** — React terminal rendering with bordered input box, context bar, and autocomplete
- **Bordered tool result blocks** — tool output framed with colored diff highlighting (green/red)
- **Slash command coloring** — commands highlighted in blue for quick visual scanning
- **Buddy system** — persistent ASCII pet with species, moods, animated poses, hats, rarity, and stats
- **Buddy animations** — mood-driven pose cycling with idle, thinking, celebrating, and confused states
- **Keybindings** — customizable shortcuts, chord bindings, Shift+Tab mode switching
- **Effort levels** — low / normal / high controls response depth
- **Smart paste** — large clipboard pastes auto-collapsed in context
- **Image support** — drag-and-drop images with base64 collapse
- **Voice mode** — record and transcribe via Whisper
- **Notifications** — system notifications on task completion

### Persistence

- **Sessions** — JSONL at `~/.ashlrcode/sessions/`, resume with `--continue` or `--resume`
- **Dreams** — background memory consolidation when idle, loaded on next session
- **File undo** — every Write/Edit snapshots the original, revert with `/undo`
- **Settings sync** — export/import settings across machines with `/sync`
- **Memory** — persistent per-project context loaded automatically

### Security

- **Permission system** — read-only tools auto-allowed; write tools prompt `[y]es / [a]lways / [n]o / [d]eny-always`
- **Permission rules** — regex-based allow/deny rules in settings
- **Hook system** — pre/post tool hooks can block, modify, or extend tool calls
- **Undercover mode** — stealth prompt adjustments
- **Input validation** — tool input schemas validated before execution
- **Global error handling** — uncaught exceptions and SIGTERM caught; sessions saved before exit to prevent data loss

### Infrastructure

- **Feature flags** — runtime toggles for experimental features
- **Telemetry** — event logging for debugging and analytics
- **Cost tracking** — per-provider token and cost accounting
- **Retry with backoff** — rate limits (3x, 1s base), network errors (2x, 2s base)
- **Speculation** — predictive tool execution
- **LSP integration** — Language Server Protocol for diagnostics and completions
- **MCP with SSE transport** — stdio and URL-based SSE connections to external tool servers
- **MCP OAuth** — OAuth flow for MCP server authentication
- **Cron triggers** — scheduled recurring agent tasks
- **IPC** — inter-process messaging between instances
- **Bridge server** — HTTP API for external tool integration
- **Remote settings** — fetch config overrides from a URL
- **Model patches** — per-model prompt tuning

---

## MCP (Model Context Protocol)

AshlrCode connects to external tool servers via MCP. Configure servers in `~/.ashlrcode/settings.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": { "API_KEY": "..." }
    },
    "remote-server": {
      "url": "http://localhost:3000"
    },
    "chrome-extension": {
      "url": "http://localhost:12007",
      "env": {}
    }
  }
}
```

**Stdio transport** — spawns a local process and communicates over stdin/stdout. Use `command` + `args`.

**SSE transport** — connects to a running HTTP server. Use `url`. Works with browser extensions like Claude-in-Chrome that expose an MCP endpoint.

**OAuth** — for authenticated MCP servers, add an `oauth` block with `authorizationUrl`, `tokenUrl`, `clientId`, and `scopes`.

MCP tools appear automatically as `mcp__<server>__<tool>` and are available to the agent alongside built-in tools.

---

## Configuration

| Path | Purpose |
|------|---------|
| `~/.ashlrcode/settings.json` | Providers, hooks, MCP servers, feature flags |
| `~/.ashlrcode/keybindings.json` | Custom keyboard shortcuts |
| `~/.ashlrcode/permissions.json` | Persisted tool permission rules |
| `~/.ashlrcode/sessions/` | Saved conversation sessions (JSONL) |
| `~/.ashlrcode/dreams/` | Background memory consolidation files |
| `~/.ashlrcode/memory/` | Per-project persistent memories |
| `~/.ashlrcode/tasks/` | Persisted task boards |
| `~/.ashlrcode/skills/` | Custom skill definitions (`.md` files) |
| `./ASHLR.md` or `./CLAUDE.md` | Project-level instructions |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `XAI_API_KEY` | xAI Grok API key (primary) |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `OPENAI_API_KEY` | OpenAI API key (also used for Whisper voice) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GROQ_API_KEY` | Groq API key |
| `AC_BRIDGE_PORT` | Enable bridge server on this port |
| `AC_REMOTE_SETTINGS_URL` | URL for remote settings fetch |
| `AC_FEATURE_VOICE_MODE` | Enable voice input (`true`) |

### Hook System

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

## Providers

| Provider | Model | Cost (in/out per 1M tokens) | Context |
|----------|-------|-----------------------------|---------|
| **xAI** (default) | grok-4-1-fast-reasoning | $0.20 / $0.50 | 2M |
| **Anthropic** | claude-sonnet-4-6 | $3.00 / $15.00 | 200K |
| **OpenAI** | gpt-4o | $2.50 / $10.00 | 128K |
| **DeepSeek** | deepseek-chat | $0.14 / $0.28 | 128K |
| **Groq** | llama-3.3-70b | $0.59 / $0.79 | 128K |
| **Ollama** (local) | any local model | Free | Model-dependent |

Auto-failover on rate limits. Model aliases: `grok-fast`, `grok-4`, `grok-3`, `sonnet`, `opus`, `llama`, `local`.

---

## KAIROS Mode

KAIROS is an autonomous agent mode with a heartbeat-driven loop. It detects terminal focus to adjust autonomy:

- **Focused** — collaborative: asks before significant changes
- **Unfocused** — full-auto: acts independently while you're away
- **Unknown** — balanced default

```bash
ac
> /kairos "refactor the auth module and add tests"
> /kairos stop
```

---

## Buddy System

Every user gets a deterministic ASCII pet companion based on a hash of their home directory. Eight species with rarity tiers, mood-based animations, equippable hats, and stats that grow with usage.

```
  ┌──────────────────────────────┐     c\  /c
  │ What if we tried a different │    ( .  . )
  │ approach to the auth flow?   │    ( _nn_ )
  └──────────────────────┐       │    (______)
                         └───────┘     ||  ||
```

Species: penguin, cat, ghost, owl, robot, dragon, axolotl (epic), capybara (legendary). Stats: debugging, patience, chaos, wisdom, snark.

---

## Development

```bash
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install

bun run dev                 # watch mode
bun run start               # run CLI
bun test                    # 335 tests, 666 assertions, ~10s
bunx tsc --noEmit           # type check
bun run build               # bundle to dist/
```

### Architecture

```
src/                        # 130 source files
├── cli.ts                  # Entry point + fallback REPL
├── repl.tsx                # Ink-based terminal UI
├── setup.ts                # Initialization and wiring
├── agent/                  # Core agent loop, sub-agents, KAIROS, teams, dreams, IPC
├── providers/              # xAI, Anthropic, router, retry, cost tracking
├── tools/                  # 42+ tools (32 files)
├── skills/                 # Skill loader + registry
├── mcp/                    # MCP client, manager, OAuth, SSE transport
├── planning/               # Plan mode + plan tools
├── persistence/            # Sessions + memory
├── config/                 # Settings, hooks, permissions, features, sync, undercover
├── state/                  # File history (undo)
├── ui/                     # Ink components, buddy, speech bubbles, theme, effort
├── autopilot/              # Scanner + work queue
├── bridge/                 # HTTP bridge server + client
├── telemetry/              # Event logging
└── voice/                  # Voice input via Whisper
```

---

## License

MIT
