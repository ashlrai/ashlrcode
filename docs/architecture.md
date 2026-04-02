# Architecture

AshlrCode is built as a layered system inspired by Claude Code's 12-layer harness architecture. Each layer adds capability on top of the previous one.

## Overview

```
User Input
    ↓
┌─────────────────────────────────────────────┐
│  CLI (src/cli.ts)                           │
│  - REPL, commands, session management       │
│  - Permission prompts, spinner, markdown    │
├─────────────────────────────────────────────┤
│  Agent Loop (src/agent/loop.ts)             │
│  - Streaming API calls                      │
│  - Tool dispatch + parallel execution       │
│  - Context compression                      │
├─────────────────────────────────────────────┤
│  Provider Router (src/providers/router.ts)  │
│  - xAI Grok / Anthropic Claude / OpenAI     │
│  - Auto-failover + retry + cost tracking    │
├─────────────────────────────────────────────┤
│  Tool Registry (src/tools/registry.ts)      │
│  - 30 built-in tools + MCP tools            │
│  - Hooks (pre/post) + permissions           │
├─────────────────────────────────────────────┤
│  Persistence Layer                          │
│  - Sessions (JSONL)                         │
│  - Memory (markdown)                        │
│  - Tasks (JSON)                             │
│  - Settings + Permissions (JSON)            │
└─────────────────────────────────────────────┘
```

## Core Loop

The agent loop (`src/agent/loop.ts`) implements the streaming tool-use pattern:

```
1. User message → append to messages[]
2. Send messages[] to provider API (streaming)
3. Receive response:
   - If text only → display to user, done
   - If tool_use → execute tools → append results → go to step 2
4. Repeat until max iterations (25) or end_turn
```

Key behaviors:
- **Streaming**: Text deltas are displayed immediately as they arrive
- **Parallel execution**: Concurrency-safe tools run via `Promise.all()`
- **Max iterations**: Safety limit of 25 tool-use rounds per turn
- **Fallback message**: If max iterations reached, shows notification instead of silent failure

## Provider Abstraction

All providers implement the same interface (`src/providers/types.ts`):

```typescript
interface Provider {
  name: string;
  config: ProviderConfig;
  stream(request: ProviderRequest): AsyncGenerator<StreamEvent>;
  pricing: [number, number]; // [input, output] per million tokens
}
```

The `ProviderRouter` handles:
- **Selection**: Uses primary provider, falls back on error
- **Retry**: Exponential backoff (3 retries for rate limits, 2 for network)
- **Failover**: Automatic switch to next provider on rate limit
- **Cost tracking**: Per-provider token accounting with reasoning token support

### Adding a new provider

1. Create `src/providers/my-provider.ts` implementing `Provider`
2. Add to the switch in `src/providers/router.ts` `createProvider()`
3. Add to settings schema in `src/config/settings.ts`

xAI and any OpenAI-compatible provider use the same code path (`src/providers/xai.ts`).

## Tool System

Every tool implements the `Tool` interface (`src/tools/types.ts`):

```typescript
interface Tool {
  name: string;
  prompt(): string;              // Description for the LLM
  inputSchema(): object;         // JSON Schema for parameters
  isReadOnly(): boolean;         // Safe in plan mode?
  isDestructive(): boolean;      // Needs extra confirmation?
  isConcurrencySafe(): boolean;  // Can run in parallel?
  validateInput(input): string | null;
  call(input, context): Promise<string>;
}
```

### Execution pipeline

```
Tool call received from model
    ↓
1. validateInput() — reject bad parameters
2. Permission check — ask user if non-read-only (or auto-approve in bypass mode)
3. Pre-tool hooks — run shell commands from settings.json
4. call() — execute the tool
5. Post-tool hooks — fire-and-forget shell commands
6. Return result to model
```

### Parallel execution

The `StreamingToolExecutor` (`src/agent/tool-executor.ts`) partitions tool calls:
- **Safe tools** (Read, Glob, Grep, WebFetch, Agent, LS, Tasks): run concurrently
- **Unsafe tools** (Bash, Write, Edit): run sequentially

When the model returns multiple tool calls in one response, safe tools execute in parallel for faster results.

## Context Management

Three-tier compression strategy (`src/agent/context.ts`):

1. **Token estimation**: `chars / 4` heuristic for message size
2. **snipCompact**: Truncate tool results > 2000 chars (keep first 800 + last 800)
3. **autoCompact**: When approaching token limit, summarize older messages via API call

Provider-aware limits:
- xAI Grok: 2,000,000 tokens
- Anthropic Claude: 200,000 tokens
- Default: 100,000 tokens

Warnings at 50% and 75% of limit before compaction triggers.

## Skill System

Skills (`src/skills/`) are slash commands that expand into full prompts:

```
User types: /commit
    ↓
1. SkillRegistry looks up trigger "/commit"
2. Loads prompts/skills/commit.md
3. Expands {{args}} template variables
4. Injects as user message to agent loop
```

Skills load from three locations (later overrides earlier):
1. `prompts/skills/` — built-in (shipped with AshlrCode)
2. `~/.ashlrcode/skills/` — user-level
3. `.ashlrcode/skills/` — project-level

## MCP Integration

MCP servers (`src/mcp/`) connect external tools via JSON-RPC over stdio:

```
AshlrCode ←→ MCPClient ←→ child process (MCP server)
                 ↕
            JSON-RPC 2.0
         (stdin/stdout)
```

Lifecycle: `connect → initialize → listTools → ready`

Discovered tools are wrapped as `mcp__<server>__<tool>` and registered in the tool registry like any built-in tool.

## Persistence

All state is file-based (no database):

| Data | Location | Format |
|------|----------|--------|
| Sessions | `~/.ashlrcode/sessions/<id>.jsonl` | Append-only JSONL |
| Settings | `~/.ashlrcode/settings.json` | JSON |
| Permissions | `~/.ashlrcode/permissions.json` | JSON |
| Tasks | `~/.ashlrcode/tasks/<session>.json` | JSON |
| Memory | `~/.ashlrcode/memory/<hash>/*.md` | Markdown with frontmatter |
| Plans | `~/.ashlrcode/plans/<name>.md` | Markdown |
| File snapshots | In-memory (session only) | — |

## Hook System

Hooks (`src/config/hooks.ts`) intercept tool calls:

- **preToolUse**: Runs before tool execution. Can `allow`, `deny`, or run a shell command.
- **postToolUse**: Runs after tool execution. Fire-and-forget shell commands.

Hooks run AFTER permission checks (so hook shell commands never execute for tools the user denied).

## File Structure

```
src/
├── cli.ts                    # Entry point: REPL, commands, flag parsing
├── setup.ts                  # First-run setup wizard
├── agent/
│   ├── loop.ts               # Core agent loop (AsyncGenerator streaming)
│   ├── context.ts            # Token estimation + compression
│   ├── sub-agent.ts          # Child agent spawning
│   ├── tool-executor.ts      # Parallel tool execution
│   └── error-handler.ts      # Error categorization + retry
├── providers/
│   ├── types.ts              # Provider interface + message types
│   ├── xai.ts                # xAI/OpenAI-compatible provider
│   ├── anthropic.ts          # Anthropic Claude provider
│   └── router.ts             # Provider selection + failover
├── tools/                    # 30 tool implementations
│   ├── types.ts              # Tool interface
│   ├── registry.ts           # Tool dispatch + hooks
│   ├── bash.ts, file-read.ts, file-edit.ts, ...
│   └── mcp-tool.ts           # MCP tool wrapper
├── mcp/
│   ├── types.ts              # MCP protocol types
│   ├── client.ts             # JSON-RPC stdio client
│   └── manager.ts            # Multi-server management
├── skills/
│   ├── types.ts              # Skill definition
│   ├── loader.ts             # Load from .md files
│   └── registry.ts           # Lookup + expansion
├── planning/
│   ├── plan-mode.ts          # Plan state + enforcement
│   └── plan-tools.ts         # EnterPlan, ExitPlan, PlanWrite
├── persistence/
│   ├── session.ts            # JSONL session management
│   └── memory.ts             # Per-project memory
├── config/
│   ├── settings.ts           # Settings loading + merging
│   ├── permissions.ts        # Permission system + bypass modes
│   ├── hooks.ts              # Pre/post tool hooks
│   ├── git.ts                # Git repo detection
│   └── project-config.ts     # ASHLR.md / CLAUDE.md loading
├── state/
│   └── file-history.ts       # File snapshot/undo
├── ui/
│   ├── spinner.ts            # Terminal spinner
│   └── markdown.ts           # Markdown-lite renderer
└── __tests__/                # 10 test files, 121 tests
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Bun | Fast startup, native TypeScript, same as Claude Code |
| Streaming | AsyncGenerator | Composable, full-chain streaming, backpressure support |
| Persistence | Files (JSONL/JSON/MD) | Simple, no database, human-readable, git-friendly |
| Provider abstraction | Interface + factory | Clean separation, easy to add providers |
| Tool registration | Registry pattern | Dynamic, supports MCP, plan-mode filtering |
| Permission model | Allow/deny with persistence | Balance automation with safety |
| Context compression | 3-tier (estimate/snip/summarize) | Progressive, provider-aware |
| Skill format | Markdown with frontmatter | Easy to author, version-controlled |
