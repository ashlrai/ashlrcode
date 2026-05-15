# AshlrCode v2.1

Multi-provider AI coding agent CLI. Open-source (MIT), npm publish-ready.
45+ tools, 18 skills, 39 built-in commands, 6 providers, 689 tests. Ink-based terminal UI with buddy system.

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

## v2.1 Additions
- **cmux Integration** (`src/cmux/`): Socket client for cmux terminal app JSON-RPC API. 9 lifecycle hooks (session start/end, agent idle, needs input, tool start/end, prompt submit, notify, error). Split spawning dispatches sub-agents to visible cmux panes. Auto-detects via `$CMUX_SOCKET_PATH`, all hooks are no-ops outside cmux.
- **Command Registry** (`src/commands/`): Centralized command system replacing inline switch statement. 6 command files with `CommandContext` interface, auto-generated autocomplete, and category-based help grouping.
- **Checkpoint Workflows** (`src/agent/checkpoint.ts`): Coordinator can pause at checkpoint tasks. State serialized to `~/.ashlrcode/checkpoints/<id>.json`. Resume with `/coordinate resume <id>`, list with `/coordinate list`. Auto-cleanup after 7 days.
- **Skill Marketplace** (`src/skills/marketplace.ts`, `src/skills/validator.ts`): Install/update/remove skill packages from registry or URL. Git clone and tarball extraction. Skill validation (frontmatter schema, trigger conflicts, size limits). Commands: `/skills install`, `/skills search`, `/skills update`, `/skills remove`, `/skills info`.

## Genome System (Genetic AI Development Loop)

The genome is a self-evolving project specification that agents read via RAG and evolve via a scribe protocol. It replaces static CLAUDE.md-style instructions with a living, sectioned knowledge base.

### Directory Structure
```
.ashlrcode/genome/
├── manifest.json           # Section index, generation metadata, fitness history
├── vision/                 # North star, architecture, principles, anti-patterns
├── milestones/             # Current milestone, backlog, completed/
├── strategies/             # Active, graveyard, experiments (co-evolution)
├── knowledge/              # Decisions, discoveries, dependencies
└── evolution/              # Fitness scores, mutation log, lineage, pending proposals
```

### Commands
- `/genome init <vision>` — Initialize genome with vision statement
- `/genome init --from-claude-md` — Migrate from existing CLAUDE.md
- `/genome status` — Current generation, milestone, fitness scores
- `/genome sections` — List all sections with token counts
- `/genome read <section>` — Display a genome section
- `/genome evolve` — Evaluate generation fitness and evolve strategies
- `/genome propose <section> <text>` — Queue a genome update proposal
- `/genome history` — Generation fitness trends
- `/genome diff [gen]` — Show mutations for a generation
- `/genome strategies` — Strategy leaderboard (Darwinian selection)
- `/genome strategies agent <id>` — Agent strategy profile
- `/genome embeddings` — Update Ollama embeddings for semantic search
- `/genome embeddings status` — Show embedding cache status

### How It Works
1. Agents receive task-relevant genome sections via keyword RAG (priority 25 in system prompt, up to 30% of budget)
2. Agents propose updates to genome sections as they learn (fire-and-forget via scribe)
3. Scribe consolidates proposals with LLM-powered merging for conflicts
4. Fitness is measured: test pass rate, code quality, milestone progress, cost efficiency, strategy success
5. Strategies evolve: winning approaches promoted, failing approaches retired with post-mortems
6. Generation advances when milestone completes — genome snapshot archived

### Key Files
- `src/genome/manifest.ts` — Types, section CRUD, serialized write lock
- `src/genome/retriever.ts` — Keyword-based RAG for system prompt injection
- `src/genome/scribe.ts` — Agent proposals, LLM consolidation, mutation audit trail
- `src/genome/generations.ts` — Generation lifecycle with strategy evolution
- `src/genome/fitness.ts` — 5-metric fitness measurement
- `src/genome/init.ts` — Genome initialization (12 sections)
- `src/genome/commands.ts` — 8 `/genome` subcommands

## Architecture

- **Runtime**: Bun (TypeScript, no build step, strict mode)
- **Entry point**: `src/cli.ts` — Ink-based REPL, state management, global error handlers (uncaughtException, unhandledRejection, SIGINT)
- **Commands**: `src/commands/` — centralized command registry with category grouping, auto-generated autocomplete
- **cmux**: `src/cmux/` — socket client for cmux terminal app, lifecycle hooks, split spawning
- **UI**: `src/ui/` — Ink components (React terminal rendering), `BuddyPanel.tsx` with animation hooks, `SlashInput.tsx` for colored slash command input, `message-renderer.ts` for bordered tool result formatting, `PermissionPrompt.tsx`
- **Agent loop**: `src/agent/loop.ts` — AsyncGenerator streaming, tool dispatch, checkpoint support
- **Providers**: `src/providers/` — 6 providers (xAI, Anthropic, OpenAI, Ollama, Groq, DeepSeek), auto-failover with retry
- **Tools**: `src/tools/` — 42 tools including PowerShell for Windows, with registry pattern (validate -> permissions -> hooks -> execute)
- **MCP**: `src/mcp/` — stdio + SSE transport client (chrome extension support), auto-discovery of MCP server tools
- **Skills**: `src/skills/` — slash command loader + registry + marketplace, templates in `prompts/skills/`
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
bun test                # Run 689 tests
bunx tsc --noEmit       # Type check
```

## Environment Variables

- `XAI_API_KEY` — xAI API key (primary provider, required)
- `ANTHROPIC_API_KEY` — Anthropic Claude API key (fallback, optional)
- `AC_MODEL` — Override model (default: grok-4.3)
- `CMUX_SOCKET_PATH` — cmux terminal app socket path (auto-detected, enables lifecycle hooks)

## Key Directories

```
src/
├── cli.ts                 # Entry point, Ink UI, REPL, global error handlers
├── repl.tsx               # Ink REPL component, input handling, cmux status reporting
├── agent/                 # Loop, context, sub-agents, verification, coordinator, checkpoints, KAIROS, dreams, speculation
├── commands/              # Centralized command registry (core, agent, git, session, autopilot), auto-autocomplete
├── cmux/                  # cmux terminal app integration (socket client, lifecycle hooks, split spawning)
├── providers/             # 6 providers with retry logic, cost budgeting
├── tools/                 # 43 tools (file ops, search, exec, PowerShell, planning, memory, git, teams, workflows, verify)
├── mcp/                   # MCP client + manager (stdio + SSE transport)
├── skills/                # Skill loader + registry + marketplace + validator (18 slash commands)
├── planning/              # Plan mode + tools
├── persistence/           # Sessions (JSONL) + memory (markdown)
├── config/                # Settings, hooks, permissions, git context
├── state/                 # File history (snapshot/undo)
├── ui/                    # Ink components: BuddyPanel, SlashInput, PermissionPrompt, message-renderer, theme
├── genome/                # Genome system: manifest, retriever, scribe, generations, fitness, init, commands
├── voice/                 # Voice mode input
└── __tests__/             # 47 test files, 689 tests
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

Skills can also be installed from the marketplace: `/skills install <name>`, `/skills search <query>`, `/skills update`, `/skills remove <name>`, `/skills info <name>`.

## Provider Behavior

- **Primary**: xAI Grok 4.3 Fast ($0.20/$0.50 per M tokens, 2M context)
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
- **Checkpoints**: `~/.ashlrcode/checkpoints/<id>.json` (coordinator pause/resume state, auto-cleaned after 7 days)
- **Settings**: `~/.ashlrcode/settings.json`

## Testing

```bash
bun test              # All 689 tests
bun test --watch      # Watch mode
```

Tests cover: tool registry, context compression, tool executor, sessions, skill registry, hooks, permissions, router costs, file history, error handler, keybindings, project config, workflows, telemetry, speculation, model patches, branded types, cron, undercover, retry, tasks, dreams, features, ring buffer, mailbox, coordinator, MCP client, cmux, commands, checkpoints, marketplace, validator, genome manifest, genome retriever, genome scribe, genome generations, genome fitness, genome init, genome commands.
