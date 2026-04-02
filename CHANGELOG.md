# Changelog

All notable changes to AshlrCode are documented here.

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
