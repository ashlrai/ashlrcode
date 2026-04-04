# Changelog

All notable changes to AshlrCode are documented here.

## [2.1.0] - 2026-04-04

### Added
- `ac --migrate` command — one-command migration from Claude Code (copies MCP servers, permissions, custom commands)
- WebSocket MCP transport (ws:// and wss:// alongside existing stdio and SSE)
- MCP auto-reconnect with OAuth token refresh on connection failure
- macOS Keychain credential storage (API keys never stored in plaintext)
- Extended thinking display for Anthropic (dim italic with thought bubble prefix, multi-turn signatures)
- `--print` flag for single-shot non-interactive output (supports stdin piping)
- `--no-mcp` flag to skip MCP server connections
- `/effort fast|normal|high` wired to model temperature and token budget
- `/import-session <path>` to import Claude Code session files
- `/sessions prune [days]` command + auto-prune on startup (max 100 sessions)
- Agent mailbox system with request-response messaging (SendMessage + CheckMessages tools)
- TodoWriteTool, TaskBoard, team management tools
- Full markdown renderer (blockquotes, emphasis, links, tables, strikethrough, horizontal rules)
- Biome linter/formatter configuration
- 181 new tests (367 → 548 total across 40 files)
- E2E smoke test (CLI flags, tool registry, settings, session lifecycle)

### Fixed
- Coordinator: structured JSON extraction (replaces brittle regex), deadlock detection via topological sort, dependency-aware wave execution, per-wave progress counts
- Grep tool: direct spawn instead of `bash -c` (eliminates command injection), `--include` as separate args
- Tool registry: execution timeouts (120s default), permission mutex prevents parallel double-prompting
- Verification agent: clear modified files per session
- Session persistence: fire-and-forget writes for assistant messages (non-blocking), blocking writes for user messages (crash recovery)
- Anthropic thinking blocks preserved in message history with signatures (fixes multi-turn extended thinking)
- MCP errors no longer silently swallowed
- Voice mode: checks for sox before spawning (clear install instructions)
- Web browser: actionable Puppeteer install instructions + WebFetch fallback tip
- Empty API keys from env vars treated as unset
- Keychain overlay skips unknown providers (prevents wrong key injection)
- WebSocket disconnect/onclose race condition resolved
- Compact session guard against non-existent sessions
- Quip index starts at 0 (prevents entry skipping in small arrays)

### Improved
- Ring buffer logger for bounded error tracking (1000 entries max, prevents memory leak)
- Speculation cache LRU eviction (200 entry max)
- LSP graceful degradation with per-language install instructions
- Permission prompt color-coded with inline descriptions
- Buddy quips externalized to JSON (customizable via ~/.ashlrcode/quips.json)
- BuddyPanel responsive terminal height
- System prompt updated with all 45+ tools documented
- Configurable limits via settings.json: maxIterations, streamTimeoutMs, toolTimeoutMs, systemPromptBudget
- CI build verification before npm publish
- Migration docs updated with `ac --migrate` instructions

## [1.0.1] - 2026-04-03

### Fixed
- Excluded test files from npm tarball (133 → 107 files)
- Added `bun install -g` instructions to README
- Created v1.0.0 git tag and GitHub Release

## [2.0.0] - 2026-04-01

### Added
- **Ink UI**: Full React-based terminal rendering via Ink (replaces readline). Input box with borders, context bar, visual status
- **Buddy system**: ASCII companion beside input with mood-based poses, speech bubbles, and satirical quips
- **Autopilot**: `/autopilot` scans codebase and builds work queue; `/autopilot approve` for review; `/autopilot auto` for fully autonomous scan → fix → test → PR → merge
- **Image support**: Drag-and-drop image input directly into the terminal
- **Smart paste**: Large clipboard pastes automatically collapsed to preserve context
- **PowerShell tool**: Windows-native shell execution alongside Bash
- **contextCollapse**: Third tier of context compression — collapses large pastes, images, and repetitive content
- **Slash command autocomplete**: Tab completion for skills and CLI commands
- **Mode switching**: Shift+Tab to switch modes inline
- **Open-source release**: MIT license, CI/CD pipeline, npm publish configuration, CONTRIBUTING.md

### Fixed
- 7 autopilot security and reliability issues (push safety, bypass warning, SIGINT guard)
- Tab race condition, stale callback, grep shell injection
- Speech bubble math, key typing, spread overflow
- Radically simplified layout — no more width bugs
- Cursor positioning: status above, line, prompt at bottom
- Context alternation and default provider fixes

## [1.5.0] - 2026-04-01

### Added
- **6 providers**: xAI, Anthropic, OpenAI, Ollama (local), Groq, DeepSeek
- **3-tier context compression**: autoCompact + snipCompact + contextCollapse
- Prompt above status line using ANSI cursor save/restore
- Input box with lines above and below prompt

## [1.3.0] - 2026-04-01

### Added
- **Diff tool**: git diff, file comparison, and string diff modes
- **Provider retry logic**: exponential backoff for rate limits (3 retries), network errors (2 retries), immediate fail for auth
- **Provider-aware context limits**: xAI 2M tokens, Anthropic 200K, auto-detected

### Fixed
- Settings merge: partial settings.json no longer crashes (merges with defaults)
- 8 code review findings: ReDoS protection, stderr deadlock prevention, MCP cleanup, hook ordering, max-iteration fallback
- Session listing now reads latest metadata (titles and counts stay current)

## [1.2.0] - 2026-04-01

### Added
- **Sleep tool**: pause execution for polling/backoff (1-60 seconds)
- **TodoWrite tool**: structured todo/plan lists with checkboxes
- System prompt expanded to 299 lines with comprehensive tool reference

## [1.1.0] - 2026-04-01

### Added
- **Memory tools**: MemorySave, MemoryList, MemoryDelete for persistent per-project context
- **NotebookEdit tool**: Jupyter notebook cell editing (replace/insert/delete)
- **SendMessage tool**: agent-to-agent messaging
- 5 new skills: /deep-work, /polish, /daily-review, /weekly-plan, /resume-branch
- 121 tests across 10 test files (198 assertions)

## [1.0.0] - 2026-04-01

### Added
- **Config tool**: view/modify settings from within the agent
- **EnterWorktree/ExitWorktree**: git worktree isolation for parallel edits
- **WebSearch tool**: DuckDuckGo search (no API key needed)
- **ToolSearch tool**: find tools by keyword

## [0.9.0] - 2026-04-01

### Added
- **Skills system**: 10 built-in slash commands (/commit, /review, /simplify, /pr, /test, /debug, /explore, /refactor, /init, /plan-task)
- **Error categorization**: rate_limit, network, auth, validation with retry logic
- Skill loader from built-in, user, and project directories

## [0.8.0] - 2026-04-01

### Added
- **MCP Server Support**: stdio transport, auto-discovery, mcp__server__tool naming
- **Hook system**: pre/post tool execution hooks from settings.json
- **Parallel tool execution**: concurrency-safe tools run via Promise.all()
- **Task persistence**: tasks saved to disk (survive process restart)

## [0.7.0] - 2026-04-01

### Added
- System prompt expanded from 46 to 170+ lines
- **File snapshot/undo**: /restore command to revert edits
- **Session resume**: --continue, --fork-session flags
- Fixed setTitle() bug (title now persisted to JSONL)

## [0.6.0] - 2026-04-01

### Added
- **LS tool**: directory listing without Bash
- **Git-aware system prompt**: auto-detects repo context
- **Edit diffs**: mini diff shown after edits
- Multi-line input (backslash continuation)
- /diff and /git commands

## [0.5.0] - 2026-04-01

### Added
- **Spinner**: animated thinking indicator with elapsed time
- **Markdown rendering**: bold, code, headers, lists formatted in terminal
- **Streaming Bash**: live output for long-running commands
- /history and /undo commands
- Auto-title sessions from first message

## [0.4.0] - 2026-04-01

### Added
- **/model command**: switch providers mid-session with aliases
- **Permission persistence**: always-allow/deny saved to disk
- Improved permission prompt: [y]es / [a]lways / [n]o / [d]eny

## [0.3.0] - 2026-04-01

### Added
- Sub-agent spawning with isolated context (AgentTool)
- Task tracking (TaskCreate/Update/List)
- Global CLI install via bun link (`ac` and `ashlrcode`)

### Fixed
- Cost tracking: stream_options for usage, reasoning token display
- Grep fallback: use bash -c for ripgrep shell functions
- Multi-tool-result messages: expand to separate role:"tool" messages

## [0.1.0] - 2026-04-01

### Added
- Initial scaffold: TypeScript + Bun CLI
- Provider abstraction: xAI Grok (OpenAI SDK) + Anthropic Claude
- Streaming agent loop (AsyncGenerator pattern)
- 6 core tools: Bash, Read, Write, Edit, Glob, Grep
- Context compression (3-tier: autoCompact, snipCompact, estimation)
- Session persistence (JSONL append-only)
- Plan mode with read-only enforcement
- Permission system
- Bifrost proxy scripts for Claude Code + Grok
