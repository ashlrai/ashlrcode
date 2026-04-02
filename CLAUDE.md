# AshlrCode v1.5.0

Multi-provider AI coding agent CLI. Internal tooling for AshlrAI.
30 tools, 15 skills, MCP support, 121 tests.

## Architecture

- **Runtime**: Bun (TypeScript, no build step, strict mode)
- **Entry point**: `src/cli.ts` — REPL, commands, state management
- **Agent loop**: `src/agent/loop.ts` — AsyncGenerator streaming, tool dispatch
- **Providers**: `src/providers/` — xAI (OpenAI SDK) + Anthropic (native SDK), auto-failover with retry
- **Tools**: `src/tools/` — 30 tools with registry pattern (validate → permissions → hooks → execute)
- **MCP**: `src/mcp/` — stdio transport client, auto-discovery of MCP server tools
- **Skills**: `src/skills/` — slash command loader + registry, templates in `prompts/skills/`
- **Planning**: `src/planning/` — plan mode (read-only enforcement), plan file management
- **Persistence**: `src/persistence/` — JSONL sessions, per-project memory
- **Config**: `src/config/` — settings, hooks, permissions, git context
- **UI**: `src/ui/` — spinner, markdown renderer
- **State**: `src/state/` — file snapshot/undo history

## Commands

```bash
bun run start           # Run CLI
bun run dev             # Watch mode
bun test                # Run 121 tests
bunx tsc --noEmit       # Type check
```

## Environment Variables

- `XAI_API_KEY` — xAI API key (primary provider, required)
- `ANTHROPIC_API_KEY` — Anthropic Claude API key (fallback, optional)
- `AC_MODEL` — Override model (default: grok-4-1-fast-reasoning)

## Key Directories

```
src/
├── cli.ts                 # Entry point, REPL, 15 commands
├── agent/                 # Loop, context compression, parallel executor, sub-agents
├── providers/             # xAI + Anthropic with retry logic
├── tools/                 # 30 tools (file ops, search, exec, planning, memory, git)
├── mcp/                   # MCP client + manager (stdio transport)
├── skills/                # Skill loader + registry (15 slash commands)
├── planning/              # Plan mode + tools
├── persistence/           # Sessions (JSONL) + memory (markdown)
├── config/                # Settings, hooks, permissions, git context
├── state/                 # File history (snapshot/undo)
├── ui/                    # Spinner, markdown renderer
└── __tests__/             # 10 test files, 121 tests
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
- Auto-failover on rate limits with exponential backoff (3 retries)
- Network errors: 2 retries with 2s base delay
- Auth errors: immediate fail with clear message
- Cost tracking includes reasoning tokens

## Context Management

- **autoCompact**: summarize older messages when approaching token limit
- **snipCompact**: truncate tool results > 2000 chars
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
bun test              # All 121 tests
bun test --watch      # Watch mode
```

Tests cover: tool registry, context compression, tool executor, sessions, skill registry, hooks, permissions, router costs, file history, error handler.
