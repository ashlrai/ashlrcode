# AshlrCode Tool Reference

Complete reference for all 30 built-in tools. Each tool implements the `Tool` interface defined in `src/tools/types.ts`.

**Flags key:**
- **Read-only**: Safe to use in plan mode; does not modify the filesystem.
- **Parallel-safe**: Multiple instances can run concurrently (e.g., in sub-agents).

---

## File Operations

### Read

| | |
|---|---|
| **Category** | File Operations |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Read a file from the filesystem. Returns contents with line numbers (`cat -n` format). Supports offset and limit for reading specific portions of large files.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file to read |
| `offset` | number | No | Line number to start reading from (0-based) |
| `limit` | number | No | Maximum number of lines to read (default: 2000) |

#### Example

```json
{
  "file_path": "/home/user/project/src/index.ts",
  "offset": 50,
  "limit": 100
}
```

#### Notes
- Returns a "file not found" message if the path does not exist.
- Output is formatted with line numbers (1-indexed) followed by a tab and the line content.
- A header is prepended when only a subset of lines is shown.

---

### Write

| | |
|---|---|
| **Category** | File Operations |
| **Read-only** | No |
| **Parallel-safe** | No |

Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates parent directories as needed. Snapshots the existing file to the file history before overwriting.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file to write |
| `content` | string | Yes | The content to write to the file |

#### Example

```json
{
  "file_path": "/home/user/project/src/new-file.ts",
  "content": "export const hello = 'world';\n"
}
```

#### Notes
- Marked as destructive. Requires user permission unless bypass mode is enabled.
- Previous file contents are saved to the file history, enabling `/restore`.

---

### Edit

| | |
|---|---|
| **Category** | File Operations |
| **Read-only** | No |
| **Parallel-safe** | No |

Perform exact string replacement in a file. The `old_string` must be unique in the file unless `replace_all` is set to true.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file to edit |
| `old_string` | string | Yes | The exact text to find and replace |
| `new_string` | string | Yes | The replacement text |
| `replace_all` | boolean | No | Replace all occurrences (default: false) |

#### Example

```json
{
  "file_path": "/home/user/project/src/index.ts",
  "old_string": "const x = 1;",
  "new_string": "const x = 42;"
}
```

#### Notes
- Returns an error if `old_string` is not found or is not unique (when `replace_all` is false).
- Not marked as destructive (reversible via edit), but still requires permission.
- Shows a mini diff in the result output.
- Snapshots the file before editing for `/restore` support.

---

### NotebookEdit

| | |
|---|---|
| **Category** | File Operations |
| **Read-only** | No |
| **Parallel-safe** | No |

Edit Jupyter notebook (.ipynb) cells. Supports replacing, inserting, and deleting cells.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Path to the .ipynb file |
| `operation` | string | Yes | `"replace"`, `"insert"`, or `"delete"` |
| `cell_index` | number | Yes | Cell index (0-based) |
| `cell_type` | string | No | `"code"` or `"markdown"` (for insert/replace) |
| `content` | string | Conditional | New cell content (required for insert/replace) |

#### Example

```json
{
  "file_path": "/home/user/notebooks/analysis.ipynb",
  "operation": "insert",
  "cell_index": 3,
  "cell_type": "code",
  "content": "import pandas as pd\ndf = pd.read_csv('data.csv')"
}
```

#### Notes
- Snapshots the notebook file before editing.
- Cell source is split into lines with trailing newlines, matching Jupyter format.
- Code cells get empty `outputs` and `null` `execution_count` on create/replace.

---

### LS

| | |
|---|---|
| **Category** | File Operations |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

List files and directories in a given path. Returns names with type indicators (`/` for directories) and file sizes. Lighter weight than running `ls` via Bash.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | No | Directory path to list (defaults to cwd) |

#### Example

```json
{
  "path": "/home/user/project/src"
}
```

#### Notes
- Hidden files (starting with `.`) are skipped.
- File sizes are shown in human-readable format (B, KB, MB).

---

## Search

### Glob

| | |
|---|---|
| **Category** | Search |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Find files matching a glob pattern. Returns matching file paths sorted by modification time (most recent first).

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern to match files against |
| `path` | string | No | Directory to search in (defaults to cwd) |

#### Example

```json
{
  "pattern": "**/*.ts",
  "path": "/home/user/project/src"
}
```

#### Notes
- Uses `fast-glob` under the hood.
- Ignores `node_modules` and `.git` directories by default.
- Does not match dotfiles by default.

---

### Grep

| | |
|---|---|
| **Category** | Search |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Search file contents using regex patterns. Returns matching lines with file paths and line numbers. Tries ripgrep (`rg`) first, falls back to system `grep`.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search for |
| `path` | string | No | File or directory to search in (defaults to cwd) |
| `glob` | string | No | Glob pattern to filter files (e.g., `"*.ts"`) |
| `output_mode` | string | No | `"content"`, `"files_with_matches"` (default), or `"count"` |

#### Example

```json
{
  "pattern": "async function\\s+\\w+",
  "path": "/home/user/project/src",
  "glob": "*.ts",
  "output_mode": "content"
}
```

#### Notes
- Maximum 250 matches returned.
- When ripgrep is not available, falls back to system grep with a default set of file extensions.

---

### ToolSearch

| | |
|---|---|
| **Category** | Search |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Search for available tools by keyword. Returns matching tool names and descriptions. Useful when many tools are registered (including MCP tools).

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Keyword to search for in tool names and descriptions |
| `maxResults` | number | No | Maximum results to return (default: 10) |

#### Example

```json
{
  "query": "file",
  "maxResults": 5
}
```

#### Notes
- Searches both tool names and tool descriptions (case-insensitive).
- Shows the `[read-only]` flag on matching tools.

---

### WebSearch

| | |
|---|---|
| **Category** | Search |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Search the web and return top results with titles, URLs, and snippets. Uses DuckDuckGo HTML API (no API key required).

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `maxResults` | number | No | Maximum number of results (default: 5) |

#### Example

```json
{
  "query": "bun runtime documentation",
  "maxResults": 3
}
```

#### Notes
- 15-second timeout on the HTTP request.
- Results are parsed from DuckDuckGo HTML and include title, URL, and snippet.

---

## Execution

### Bash

| | |
|---|---|
| **Category** | Execution |
| **Read-only** | No |
| **Parallel-safe** | No |

Execute a bash command and return its output. Commands run in the project's working directory. Supports live output streaming for long-running commands.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | string | Yes | The bash command to execute |
| `timeout` | number | No | Timeout in milliseconds (default: 120000, i.e., 2 minutes) |

#### Example

```json
{
  "command": "npm test -- --coverage",
  "timeout": 300000
}
```

#### Notes
- Marked as destructive. Always requires permission unless bypass mode is active.
- Live output streaming activates after 5 seconds for long-running commands.
- Output is truncated to 50,000 characters (keeping first and last 20,000) for the model.
- Returns "(no output)" if the command produces no stdout/stderr.
- Returns exit code when non-zero.

---

## Research

### WebFetch

| | |
|---|---|
| **Category** | Research |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Fetch a URL and return its content. Useful for reading documentation, APIs, or web pages. Supports all HTTP methods.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | Yes | The URL to fetch |
| `method` | string | No | HTTP method: `"GET"` (default), `"POST"`, `"PUT"`, `"DELETE"` |
| `headers` | object | No | Additional HTTP headers |
| `body` | string | No | Request body (for POST/PUT) |

#### Example

```json
{
  "url": "https://api.example.com/docs",
  "method": "GET"
}
```

#### Notes
- 30-second timeout.
- Response is truncated at 50,000 characters.
- HTML content is automatically stripped of tags, scripts, and styles for readability.
- User-Agent is set to `AshlrCode/0.1.0`.

---

### Diff

| | |
|---|---|
| **Category** | Research |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Show differences between file versions or git changes. Supports three modes.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mode` | string | No | `"git"` (default), `"files"`, or `"string"` |
| `file_path` | string | No | File path for git diff, or first file for files mode |
| `file_path_2` | string | No | Second file path (for files mode) |
| `old_string` | string | No | Old string (for string mode) |
| `new_string` | string | No | New string (for string mode) |
| `staged` | boolean | No | Show staged changes (git mode, default: false) |

#### Example

```json
{
  "mode": "git",
  "file_path": "src/index.ts",
  "staged": true
}
```

#### Notes
- `git` mode runs `git diff` (optionally `--staged`).
- `files` mode runs `diff -u` between two files.
- `string` mode performs a simple line-by-line comparison with `+`/`-` markers.

---

## Interaction

### AskUser

| | |
|---|---|
| **Category** | Interaction |
| **Read-only** | Yes |
| **Parallel-safe** | No |

Ask the user a question with structured options. The user can pick a numbered option or type a custom answer.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `question` | string | Yes | The question to ask. Should be clear and specific. |
| `options` | array | Yes | 2-4 options, each with `label` (string) and `description` (string) |

#### Example

```json
{
  "question": "How should we handle authentication?",
  "options": [
    { "label": "JWT tokens", "description": "Stateless, good for APIs" },
    { "label": "Session cookies", "description": "Simpler, server-side state" }
  ]
}
```

#### Notes
- Not parallel-safe because only one interactive prompt can be active at a time.
- An additional "Other" option is always appended, allowing a free-form custom answer.
- Core UX component of plan mode for gathering requirements.

---

## Agents

### Agent

| | |
|---|---|
| **Category** | Agents |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Launch a sub-agent to handle a task autonomously. The sub-agent gets its own fresh conversation context and access to read-only tools by default.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `description` | string | Yes | Short description of what the agent will do (3-5 words) |
| `prompt` | string | Yes | Detailed task description. Include file paths, search terms, and specific questions. |
| `readOnly` | boolean | No | Only allow read-only tools (default: true) |

#### Example

```json
{
  "description": "Explore auth module",
  "prompt": "Read all files in src/auth/ and describe the authentication flow, including which middleware is used and how tokens are validated."
}
```

#### Notes
- Sub-agents have a maximum of 15 iterations.
- When `readOnly` is true (the default), sub-agents can only use Read, Glob, Grep, and WebFetch.
- Tool usage is logged to the console with indented markers.
- The Agent tool itself is always auto-approved (no permission prompt).

---

### SendMessage

| | |
|---|---|
| **Category** | Agents |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Send a message to another agent. Used for agent-to-agent communication when coordinating work across sub-agents.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `to` | string | Yes | Name or ID of the recipient agent |
| `content` | string | Yes | Message content |

#### Example

```json
{
  "to": "auth-agent",
  "content": "Found 3 middleware files that need updating. See src/middleware/auth.ts."
}
```

#### Notes
- Uses an in-memory inbox; messages do not persist across sessions.
- The `from` field is automatically set to `"main"`.

---

## Tasks

### TaskCreate

| | |
|---|---|
| **Category** | Tasks |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Create a task to track work. Tasks have a subject, description, and status. Persisted to `~/.ashlrcode/tasks/<session-id>.json`.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `subject` | string | Yes | Brief title for the task |
| `description` | string | No | What needs to be done |

#### Example

```json
{
  "subject": "Add input validation",
  "description": "Validate all user inputs in the registration form before submission"
}
```

#### Notes
- Tasks start with `"pending"` status.
- Auto-incrementing integer IDs starting at 1.

---

### TaskUpdate

| | |
|---|---|
| **Category** | Tasks |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Update a task's status.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taskId` | number | Yes | ID of the task to update |
| `status` | string | Yes | `"pending"`, `"in_progress"`, or `"completed"` |

#### Example

```json
{
  "taskId": 1,
  "status": "completed"
}
```

---

### TaskList

| | |
|---|---|
| **Category** | Tasks |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

List all tasks and their current status. Shows a summary of pending, in-progress, and completed counts.

#### Parameters

None.

#### Example

```json
{}
```

#### Notes
- Tasks are shown with status icons: `○` pending, `●` in progress, `✓` completed.

---

### TodoWrite

| | |
|---|---|
| **Category** | Tasks |
| **Read-only** | No |
| **Parallel-safe** | No |

Write a structured todo list or plan to a file in markdown format with checkboxes.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Path to write the todo file (e.g., `PLAN.md`, `TODO.md`) |
| `todos` | array | Yes | List of todo items, each with `task` (string), optional `completed` (boolean), optional `subtasks` (array of `{task, completed}`) |

#### Example

```json
{
  "file_path": "PLAN.md",
  "todos": [
    {
      "task": "Set up database schema",
      "completed": true,
      "subtasks": [
        { "task": "Create users table", "completed": true },
        { "task": "Create posts table", "completed": false }
      ]
    },
    { "task": "Implement API routes", "completed": false }
  ]
}
```

#### Notes
- Creates parent directories if they do not exist.
- Output format uses markdown checkboxes: `- [x]` for completed, `- [ ]` for pending.
- The file starts with a `# Plan` heading.

---

## Planning

### EnterPlan

| | |
|---|---|
| **Category** | Planning |
| **Read-only** | Yes |
| **Parallel-safe** | No |

Enter plan mode. In plan mode, only read-only tools are available. Use this when you need to explore a codebase and design an approach before making changes.

#### Parameters

None.

#### Example

```json
{}
```

#### Notes
- Fails if already in plan mode.
- Creates a plan file for writing via PlanWrite.
- Available tools in plan mode: Read, Glob, Grep, WebFetch, AskUser, PlanWrite, ExitPlan.
- Blocked tools: Write, Edit, Bash, and anything that modifies files.

---

### PlanWrite

| | |
|---|---|
| **Category** | Planning |
| **Read-only** | Yes |
| **Parallel-safe** | No |

Write content to the plan file. Can be called multiple times to build the plan incrementally.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | Yes | The plan content (markdown format) |

#### Example

```json
{
  "content": "## Phase 1: Database Setup\n\n1. Create migration files\n2. Define schema\n3. Seed test data"
}
```

#### Notes
- Only available in plan mode. Returns an error if called outside plan mode.
- Each call overwrites the plan file content (not append).

---

### ExitPlan

| | |
|---|---|
| **Category** | Planning |
| **Read-only** | Yes |
| **Parallel-safe** | No |

Exit plan mode. The plan file is presented to the user for review. A preview of the first 2000 characters is shown.

#### Parameters

None.

#### Example

```json
{}
```

#### Notes
- Fails if not in plan mode.
- Warns if no plan was written to the plan file.
- The plan file path is included in the output.

---

## Memory

### MemorySave

| | |
|---|---|
| **Category** | Memory |
| **Read-only** | No |
| **Parallel-safe** | No |

Save a memory for this project. Memories persist across sessions in `~/.ashlrcode/memory/<project-hash>/` and are loaded into context automatically.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Short name for the memory |
| `description` | string | No | One-line description (used to decide relevance in future) |
| `type` | string | Yes | `"user"`, `"feedback"`, `"project"`, or `"reference"` |
| `content` | string | Yes | The memory content (markdown) |

#### Example

```json
{
  "name": "preferred-test-framework",
  "type": "feedback",
  "description": "User prefers Vitest over Jest",
  "content": "When writing tests, always use Vitest. The project has vitest.config.ts in the root."
}
```

#### Notes
- Memory types: `user` (about the user), `feedback` (how to work), `project` (ongoing context), `reference` (external resources).
- Triggered when the user says "remember this" or when important context is learned.

---

### MemoryList

| | |
|---|---|
| **Category** | Memory |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

List all memories saved for this project. Shows name, type, and description.

#### Parameters

None.

#### Example

```json
{}
```

---

### MemoryDelete

| | |
|---|---|
| **Category** | Memory |
| **Read-only** | No |
| **Parallel-safe** | No |

Delete a memory by name.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Name of the memory to delete |

#### Example

```json
{
  "name": "preferred-test-framework"
}
```

#### Notes
- Marked as destructive.
- Returns a "not found" message if the memory does not exist.

---

## Configuration

### Config

| | |
|---|---|
| **Category** | Configuration |
| **Read-only** | No |
| **Parallel-safe** | No |

View or modify AshlrCode settings at runtime. Reads/writes `~/.ashlrcode/settings.json`.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `operation` | string | Yes | `"get"`, `"set"`, or `"list"` |
| `key` | string | Conditional | Setting key in dot-notation (required for `get`/`set`) |
| `value` | string | Conditional | Value to set (required for `set`) |

#### Example

```json
{
  "operation": "set",
  "key": "providers.primary.model",
  "value": "grok-4-0314"
}
```

#### Notes
- Supports dot-notation for nested keys (e.g., `providers.primary.model`).
- Values are parsed as JSON if possible, otherwise stored as strings.
- `list` returns the full settings object as formatted JSON.

---

## Git

### EnterWorktree

| | |
|---|---|
| **Category** | Git |
| **Read-only** | No |
| **Parallel-safe** | No |

Create an isolated git worktree for safe parallel editing. Returns the worktree path. Use with the Agent tool for isolated sub-agent work.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | No | Name for the worktree branch (auto-generated if omitted) |

#### Example

```json
{
  "name": "feature-auth-refactor"
}
```

#### Notes
- Worktrees are created under `<cwd>/.ashlrcode-worktrees/<name>`.
- A new git branch with the given name is created.
- Auto-generated names use the pattern `ac-worktree-<8-char-uuid>`.

---

### ExitWorktree

| | |
|---|---|
| **Category** | Git |
| **Read-only** | No |
| **Parallel-safe** | No |

Remove a git worktree. Optionally merge changes back to the original branch before removal.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Path to the worktree to remove |
| `merge` | boolean | No | Merge the worktree branch back before removing (default: false) |

#### Example

```json
{
  "path": "/home/user/project/.ashlrcode-worktrees/feature-auth-refactor",
  "merge": true
}
```

#### Notes
- Marked as destructive.
- If merge fails (e.g., conflicts), the worktree is NOT removed. The user must resolve conflicts manually.
- Uses `git worktree remove --force`.

---

## Utility

### Sleep

| | |
|---|---|
| **Category** | Utility |
| **Read-only** | Yes |
| **Parallel-safe** | Yes |

Pause execution for a specified number of seconds. Useful for polling, rate limit backoff, or waiting for external processes.

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `seconds` | number | Yes | Number of seconds to sleep (1-60) |
| `reason` | string | No | Why the agent is sleeping (displayed to user) |

#### Example

```json
{
  "seconds": 5,
  "reason": "Waiting for CI pipeline to start"
}
```

#### Notes
- Maximum sleep duration is 60 seconds.
- The reason is included in the result message for transparency.

---

## Quick Reference Table

| Tool | Category | Read-only | Parallel-safe | Destructive |
|------|----------|-----------|---------------|-------------|
| Read | File Operations | Yes | Yes | No |
| Write | File Operations | No | No | Yes |
| Edit | File Operations | No | No | No |
| NotebookEdit | File Operations | No | No | No |
| LS | File Operations | Yes | Yes | No |
| Glob | Search | Yes | Yes | No |
| Grep | Search | Yes | Yes | No |
| ToolSearch | Search | Yes | Yes | No |
| WebSearch | Search | Yes | Yes | No |
| Bash | Execution | No | No | Yes |
| WebFetch | Research | Yes | Yes | No |
| Diff | Research | Yes | Yes | No |
| AskUser | Interaction | Yes | No | No |
| Agent | Agents | Yes | Yes | No |
| SendMessage | Agents | Yes | Yes | No |
| TaskCreate | Tasks | Yes | Yes | No |
| TaskUpdate | Tasks | Yes | Yes | No |
| TaskList | Tasks | Yes | Yes | No |
| TodoWrite | Tasks | No | No | No |
| EnterPlan | Planning | Yes | No | No |
| PlanWrite | Planning | Yes | No | No |
| ExitPlan | Planning | Yes | No | No |
| MemorySave | Memory | No | No | No |
| MemoryList | Memory | Yes | Yes | No |
| MemoryDelete | Memory | No | No | Yes |
| Config | Configuration | No | No | No |
| EnterWorktree | Git | No | No | No |
| ExitWorktree | Git | No | No | Yes |
| Sleep | Utility | Yes | Yes | No |

**Total: 29 built-in tools** + MCP tools dynamically registered from configured MCP servers.

---

## Auto-Approved Tools (No Permission Prompt)

The following tools are auto-approved and never prompt for permission:

- Read, Glob, Grep, AskUser, WebFetch
- EnterPlan, ExitPlan, PlanWrite
- TaskCreate, TaskUpdate, TaskList
- Agent

All other tools require user approval unless bypass mode (`--yolo`) or auto-accept edits (`--auto-accept-edits`) is enabled.
