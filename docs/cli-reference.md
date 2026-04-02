# AshlrCode CLI Reference

AshlrCode (`ac`) is a multi-provider AI coding agent CLI. Version: 1.5.0.

---

## Usage

```
ac [message]              Run with a single message (non-interactive)
ac                        Start interactive REPL
ac --resume <id>          Resume a previous session
```

When a message is provided as a positional argument, AshlrCode runs a single turn and exits. Without a message, it starts the interactive REPL.

---

## CLI Flags

### `--help`, `-h`

Show help text with usage, options, and REPL commands, then exit.

### `--version`, `-v`

Print the version string (`AshlrCode v1.5.0`) and exit.

### `--continue`, `-c`

Resume the most recent session for the current working directory. If no previous session exists, a new session is created.

```bash
ac -c
```

### `--resume <id>`

Resume a specific session by its ID. The session's full message history is restored.

```bash
ac --resume abc123
```

If the session ID is not found, AshlrCode exits with an error.

### `--fork-session <id>`

Copy an existing session into a new session. The original session is preserved. The forked session gets a new ID but inherits the full message history.

```bash
ac --fork-session abc123
```

### `--dangerously-skip-permissions`, `--yolo`

Auto-approve ALL tool calls. No permission prompts will appear. Use with caution -- this allows the model to execute arbitrary shell commands, write any file, and make destructive changes without confirmation.

```bash
ac --yolo
```

The REPL header displays a red `YOLO` indicator when this mode is active.

### `--auto-accept-edits`

Auto-approve Write and Edit tool calls. Bash commands still require permission. This is a middle ground between full manual approval and `--yolo`.

```bash
ac --auto-accept-edits
```

The REPL header displays a yellow `auto-edits` indicator when this mode is active.

### `--print`

Output only the model's text response (no spinners, no tool call indicators, no cost summary). Designed for piping output to other commands or scripts.

```bash
ac --print "Explain this error" 2>/dev/null | pbcopy
```

### `--max-cost <dollars>`

Set a cost budget in USD. AshlrCode stops accepting new turns once cumulative cost reaches or exceeds this limit.

```bash
ac --max-cost 0.50
```

The REPL header shows the max cost when set. When the limit is reached, the user sees a yellow warning and the turn is skipped.

---

## REPL Commands

All REPL commands start with `/`. Commands are case-sensitive.

### `/plan`

Show plan mode status. If plan mode is active, displays the plan file path and when it was started. If inactive, provides a tip on how to activate it (ask the model to "plan first").

### `/cost`

Show token usage, API costs, and context statistics. Displays:
- Provider cost summary (from the router)
- Estimated context size in tokens
- Number of messages in the conversation

### `/history`

Show conversation history with numbered turns. User messages are shown with a turn number; assistant responses are shown indented. Messages longer than 80 characters are truncated with `...`.

### `/undo`

Remove the last user message and all messages after it (including the assistant's response). Effectively rewinds the conversation by one turn. Reports how many messages were removed.

### `/restore [file-path]`

Restore a file to its previous state from the file history (snapshots taken before Write/Edit operations).

- Without arguments: lists all files that have snapshots available, with counts.
- With a file path: restores the file to its last snapshot.

```
/restore src/index.ts
```

### `/tools`

List all registered tools with their flags. Each tool shows:
- Name (bold)
- `read-only` (green) or `write` (yellow)
- `parallel` or `serial`

Includes both built-in tools and any MCP tools from connected servers.

### `/skills`

List all loaded skills. Skills are slash commands backed by `.md` files in `~/.ashlrcode/skills/` or project-level skill directories. Each skill shows its trigger command and description.

### `/memory`

List all memories saved for the current project. Shows name, type, and description/preview of each memory. If no memories exist, provides guidance on how the model can save them.

### `/sessions`

List all saved sessions. Each entry shows:
- Session ID (bold, with `(current)` marker)
- Title (derived from first message or directory name)
- Message count
- Time since last update

Also shows the resume command: `ac --resume <id>`.

### `/model [name]`

Without arguments, shows the current provider and model, plus available aliases.

With an argument, switches to the specified model. Accepts either a model alias or a full model ID.

**Model aliases:**

| Alias | Resolves to |
|-------|-------------|
| `grok-fast` | `grok-4-1-fast-reasoning` |
| `grok-4` | `grok-4-0314` |
| `grok-3` | `grok-3-fast` |
| `sonnet` | `claude-sonnet-4-6-20250514` |
| `opus` | `claude-opus-4-6-20250514` |
| `haiku` | `claude-haiku-4-5-20251001` |

```
/model sonnet
/model grok-4-1-fast-reasoning
```

### `/compact`

Compress the conversation context. Runs two-stage compaction:
1. **Snip compact**: Removes redundant or low-value messages.
2. **Auto compact**: Uses the model to summarize older context.

Reports the before/after token counts.

### `/diff`

Show `git diff --stat` for the current repository. Displays changed files with insertion/deletion counts. Shows "No uncommitted changes." if the working tree is clean.

### `/git`

Show git repository information:
- Current branch
- Remote URL (or "none")
- Number of uncommitted changes (or "clean")

Shows "Not a git repository." if the cwd is not inside a git repo.

### `/clear`

Clear the entire conversation history. If plan mode is active, it is also exited. The model starts fresh with no context from prior turns.

### `/help`

Show the list of available REPL commands with brief descriptions.

### `/quit`, `/exit`, `/q`

Exit AshlrCode. Displays the cost summary before exiting. Also triggered by Ctrl+C (which additionally saves in-flight conversation history) or closing stdin.

---

## Environment Variables

### `XAI_API_KEY`

API key for the xAI (Grok) provider. This is the primary/default provider.

### `ANTHROPIC_API_KEY`

API key for the Anthropic (Claude) provider. When set, Anthropic is configured as a fallback provider.

### `AC_MODEL`

Override the default model. If set, this value is used instead of the default `grok-4-1-fast-reasoning`.

```bash
export AC_MODEL=grok-4-0314
ac "Hello"
```

---

## Multi-Line Input

End a line with `\` (backslash) to continue input on the next line. The prompt changes to `...` while buffering. The full input is submitted when a line without a trailing backslash is entered.

```
> Write a function that \
... takes a list of numbers \
... and returns the sum
```

---

## Permission Prompts

When a non-read-only tool is invoked (and not auto-approved), the user is prompted:

```
Allow Bash? $ npm install
[y]es / [a]lways / [n]o / [d]eny always:
```

| Choice | Effect |
|--------|--------|
| `y` / `yes` | Allow this one invocation |
| `a` / `always` | Allow this tool for all future sessions (persisted to `~/.ashlrcode/permissions.json`) |
| `n` / `no` (or any other input) | Deny this one invocation |
| `d` / `deny` | Deny this tool for all future sessions (persisted) |

---

## Context Management

AshlrCode monitors context window usage and provides warnings:
- At **50%** of the provider's context limit: a dim status message is shown.
- At **75%**: a yellow warning is shown.
- When the context exceeds the limit: automatic compaction is triggered before the next turn.

Use `/compact` to manually trigger compaction at any time.

---

## Skills (Slash Commands)

Skills are custom slash commands defined as `.md` files. When a REPL input starts with `/` and matches a registered skill trigger, the skill's prompt template is expanded and sent to the model as a regular turn.

Skills are loaded from:
- `~/.ashlrcode/skills/`
- Project-level skill directories

Use `/skills` to see all loaded skills.
