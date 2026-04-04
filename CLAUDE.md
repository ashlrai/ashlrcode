# AshlrCode v2.1

Multi-provider AI coding agent CLI. Open-source (MIT), npm publish-ready.
45+ tools, 18 skills, 39 built-in commands, 6 providers, 452 tests. Ink-based terminal UI with buddy system.

## v2.0 Additions
- **Verification Agent** (`src/agent/verification.ts`): Auto-validates multi-file changes via read-only sub-agent. Manual `/verify` command. Auto-suggest after 2+ file edits.
- **Coordinator Mode** (`src/agent/coordinator.ts`): Multi-agent orchestration — plans subtasks, dispatches to team members in parallel waves, auto-verifies. `/coordinate` command.
- **LLM Dream Consolidation** (`src/agent/dream.ts`): Dreams are now LLM-summarized (not raw excerpts). Overlapping dreams auto-merged. Uses router on exit.
- **KAIROS Push Notifications** (`src/agent/kairos.ts`): macOS notifications when autonomous work completes or errors while user is away.
- **Provider-Aware Prompt Budget**: System prompt assembly uses 5% of provider context limit (not static 8000). xAI gets ~100K, Ollama gets ~1.6K.
- **Cost Budgeting** (`src/providers/cost-tracker.ts`): Budget warnings at 75%/90%/100%. Set via `--max-cost`.
- **Tool Execution Metrics** (`src/agent/tool-executor.ts`): Cumulative timing, success rates, avg duration per tool. `/stats` command.
- **Speculation Stats**: Cache hit rate shown in turn separator (`⚡XX% cache`).
- **12 Model Patches**: Expanded from 7 to 12 — specific patches for Llama3, CodeLlama, Mistral, DeepSeek Coder, Qwen, small models.
- **Ollama Context Limits**: Provider-aware (32K default) + 12 free pricing entries for common local models.

## Architecture

- **Runtime**: Bun (TypeScript, no build step, strict mode)
- **Entry point**: `src/cli.ts` — Ink-based REPL, commands, state management, global error handlers (uncaughtException, unhandledRejection, SIGINT)
- **UI**: `src/ui/` — Ink components (React terminal rendering), `BuddyPanel.tsx` with animation hooks, `SlashInput.tsx` for colored slash command input, `message-renderer.ts` for bordered tool result formatting, `PermissionPrompt.tsx`
- **Agent loop**: `src/agent/loop.ts` — AsyncGenerator streaming, tool dispatch
- **Providers**: `src/providers/` — 6 providers (xAI, Anthropic, OpenAI, Ollama, Groq, DeepSeek), auto-failover with retry
- **Tools**: `src/tools/` — 42 tools including PowerShell for Windows, with registry pattern (validate -> permissions -> hooks -> execute)
- **MCP**: `src/mcp/` — stdio + SSE transport client (chrome extension support), auto-discovery of MCP server tools
- **Skills**: `src/skills/` — slash command loader + registry, templates in `prompts/skills/`
- **Planning**: `src/planning/` — plan mode (read-only enforcement), plan file management
- **Persistence**: `src/persistence/` — JSONL sessions, per-project memory
- **Config**: `src/config/` — settings, hooks, permissions, git context
- **State**: `src/state/` — file snapshot/undo history
- **Voice**: `src/voice/` — voice mode input

## Key Features

- **Ink UI**: Full React-based terminal rendering (replaces readline). Input box with borders, slash command autocomplete (Tab), mode switching (Shift+Tab)
- **Buddy system**: ASCII companion beside input with mood-based poses, speech bubbles, satirical quips. `BuddyPanel` React component with animation hooks
- **Colored output formatting**: Bordered blocks for tool results, syntax-highlighted diffs, colored slash command input via `SlashInput`
- **MCP SSE transport**: Chrome extension integration via SSE alongside stdio transport for local MCP servers
- **Autopilot**: `/autopilot` scans codebase, builds work queue. `/autopilot auto` runs fully autonomous scan -> fix -> test -> PR -> merge
- **Data loss prevention**: Ctrl+C saves full conversation history before exit; global error handlers keep REPL alive on unhandled rejections
- **Image support**: Drag-and-drop image input with smart paste collapse
- **PowerShell**: Windows-native shell execution tool
- **3-tier context compression**: autoCompact (summarize old messages), snipCompact (truncate tool results), contextCollapse (collapse large pastes/images/repetitive content). Provider-aware limits: xAI 2M, Anthropic 200K

## Commands

```bash
bun run start           # Run CLI
bun run dev             # Watch mode
bun test                # Run 452 tests
bunx tsc --noEmit       # Type check
```

## Environment Variables

- `XAI_API_KEY` — xAI API key (primary provider, required)
- `ANTHROPIC_API_KEY` — Anthropic Claude API key (fallback, optional)
- `AC_MODEL` — Override model (default: grok-4-1-fast-reasoning)

## Key Directories

```
src/
├── cli.ts                 # Entry point, Ink UI, REPL, 25+ commands, global error handlers
├── repl.tsx               # Ink REPL component, input handling
├── agent/                 # Loop, context, sub-agents, verification, coordinator, KAIROS, dreams, speculation
├── providers/             # 6 providers with retry logic, cost budgeting
├── tools/                 # 43 tools (file ops, search, exec, PowerShell, planning, memory, git, teams, workflows, verify)
├── mcp/                   # MCP client + manager (stdio + SSE transport)
├── skills/                # Skill loader + registry (18 slash commands)
├── planning/              # Plan mode + tools
├── persistence/           # Sessions (JSONL) + memory (markdown)
├── config/                # Settings, hooks, permissions, git context
├── state/                 # File history (snapshot/undo)
├── ui/                    # Ink components: BuddyPanel, SlashInput, PermissionPrompt, message-renderer, theme
├── voice/                 # Voice mode input
└── __tests__/             # 35 test files, 452 tests
```

## Tool Interface

Every tool in `src/tools/` implements:
```typescript
interface Tool {
  name: string;
  prompt(): string;           // LLM-facing description
  inputSchema(): object;      // JSON Schema for parameters
  isReadOnly(): boolean;      // Safe in plan mode?
  isDestructive(): boolean;   // Needs user permission?
  isConcurrencySafe(): boolean; // Can run in parallel?
  validateInput(input): string | null;
  call(input, context): Promise<string>;
}
```

Register in `src/cli.ts` with `registry.register(yourTool)`.

## Adding a New Tool

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface
2. Import and register in `src/cli.ts`: `registry.register(myTool)`
3. Add to system prompt in `prompts/system.md` if the model needs guidance

## Adding a New Skill

Create `prompts/skills/my-skill.md`:
```markdown
---
name: my-skill
description: What this skill does
trigger: /my-skill
---

The full prompt template. Use {{args}} for user-provided arguments.
```

Skills are auto-loaded from `prompts/skills/`, `~/.ashlrcode/skills/`, and `.ashlrcode/skills/`.

## Provider Behavior

- **Primary**: xAI Grok 4.1 Fast ($0.20/$0.50 per M tokens, 2M context)
- **Fallback**: Anthropic Claude Sonnet ($3/$15 per M tokens, 200K context)
- 4 additional providers: OpenAI, Ollama (local), Groq, DeepSeek
- Auto-failover on rate limits with exponential backoff (3 retries)
- Network errors: 2 retries with 2s base delay
- Auth errors: immediate fail with clear message
- Cost tracking includes reasoning tokens

## Context Management

- **autoCompact**: summarize older messages when approaching token limit
- **snipCompact**: truncate tool results > 2000 chars
- **contextCollapse**: collapse large pastes, images, and repetitive content
- Provider-aware limits: xAI 2M, Anthropic 200K
- Automatic compaction triggered before each turn

## Persistence

- **Sessions**: `~/.ashlrcode/sessions/<id>.jsonl` (append-only)
- **Tasks**: `~/.ashlrcode/tasks/<session-id>.json`
- **Memory**: `~/.ashlrcode/memory/<project-hash>/*.md`
- **Permissions**: `~/.ashlrcode/permissions.json`
- **Plans**: `~/.ashlrcode/plans/<name>.md`
- **Settings**: `~/.ashlrcode/settings.json`

## Testing

```bash
bun test              # All 452 tests
bun test --watch      # Watch mode
```

Tests cover: tool registry, context compression, tool executor, sessions, skill registry, hooks, permissions, router costs, file history, error handler, keybindings, project config, workflows, telemetry, speculation, model patches, branded types, cron, undercover, retry, tasks, dreams, features, ring buffer, mailbox, coordinator, MCP client.
