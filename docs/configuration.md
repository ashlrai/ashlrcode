# AshlrCode Configuration

AshlrCode is configured through a combination of `settings.json`, project-level markdown files, environment variables, and persisted permissions.

---

## Configuration Directory

All user-level configuration lives in `~/.ashlrcode/`:

```
~/.ashlrcode/
  settings.json          # Main settings file
  permissions.json       # Persisted permission decisions
  ASHLR.md               # Global project instructions
  memory/                # Project memories (per-project hash)
  tasks/                 # Task persistence (per-session)
  skills/                # Custom slash command skills
```

---

## settings.json Schema

Location: `~/.ashlrcode/settings.json`

The settings file is loaded at startup and merged with defaults. File settings override defaults, but providers fall back to environment variables if not specified in the file.

### Full Schema

```typescript
interface Settings {
  providers: {
    primary: {
      provider: string;       // Provider name (e.g., "xai", "anthropic")
      apiKey: string;         // API key
      model: string;          // Model ID
      baseURL?: string;       // API base URL (for custom endpoints)
    };
    fallbacks?: Array<{
      provider: string;
      apiKey: string;
      model: string;
      baseURL?: string;
    }>;
  };
  defaultModel?: string;      // Default model override
  maxTokens?: number;         // Max output tokens per response (default: 8192)
  hooks?: HooksConfig;        // Pre/post tool execution hooks
  mcpServers?: Record<string, MCPServerConfig>;  // MCP server connections
}
```

### Default Settings

When no `settings.json` exists, the following defaults apply:

```json
{
  "providers": {
    "primary": {
      "provider": "xai",
      "apiKey": "$XAI_API_KEY",
      "model": "grok-4-1-fast-reasoning",
      "baseURL": "https://api.x.ai/v1"
    },
    "fallbacks": [
      {
        "provider": "anthropic",
        "apiKey": "$ANTHROPIC_API_KEY",
        "model": "claude-sonnet-4-6-20250514"
      }
    ]
  },
  "maxTokens": 8192
}
```

The `$XAI_API_KEY` and `$ANTHROPIC_API_KEY` placeholders indicate that these values come from environment variables. The Anthropic fallback is only added if `ANTHROPIC_API_KEY` is set.

The `AC_MODEL` environment variable overrides the primary model if set.

### Example settings.json

```json
{
  "providers": {
    "primary": {
      "provider": "xai",
      "apiKey": "xai-...",
      "model": "grok-4-1-fast-reasoning",
      "baseURL": "https://api.x.ai/v1"
    },
    "fallbacks": [
      {
        "provider": "anthropic",
        "apiKey": "sk-ant-...",
        "model": "claude-sonnet-4-6-20250514"
      }
    ]
  },
  "maxTokens": 8192,
  "hooks": {
    "preToolUse": [],
    "postToolUse": []
  },
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

### Modifying Settings at Runtime

Use the `Config` tool or the `/model` REPL command to modify settings during a session. The `Config` tool supports dot-notation for nested keys:

```
Config set providers.primary.model grok-4-0314
Config get maxTokens
Config list
```

---

## Hooks System

Source: `src/config/hooks.ts`

Hooks allow you to run shell commands or apply direct actions before and after tool execution. They are defined in `settings.json` under the `hooks` key.

### Hook Types

| Hook | When it runs | Can block? |
|------|-------------|------------|
| `preToolUse` | Before a tool executes | Yes -- can deny the tool call |
| `postToolUse` | After a tool executes | No -- fire-and-forget |

### HookDefinition Schema

```typescript
interface HookDefinition {
  toolName?: string;      // Match by tool name (exact or glob pattern)
  inputPattern?: string;  // Match by input pattern (regex against JSON-serialized input)
  command?: string;       // Shell command to execute
  action?: "allow" | "deny";  // Direct action without running a command
  message?: string;       // Message to show when action is "deny"
}
```

### Matching Rules

1. **toolName**: Matches the tool name exactly, or uses glob patterns with `*`. For example, `"Memory*"` matches `MemorySave`, `MemoryList`, and `MemoryDelete`.

2. **inputPattern**: A regex pattern tested against the JSON-serialized tool input. For large inputs (>10,000 chars), falls back to simple `string.includes()` to avoid catastrophic backtracking.

3. Both `toolName` and `inputPattern` must match (if both are specified) for the hook to fire.

### Hook Execution

**Pre-tool hooks (`preToolUse`):**
- If `action` is `"deny"`: the tool call is blocked immediately with the optional `message`.
- If `action` is `"allow"`: the tool call is approved immediately.
- If `command` is specified: the shell command runs. If exit code is non-zero, the tool call is denied.
- Multiple pre-hooks are evaluated in order. The first deny stops evaluation.

**Post-tool hooks (`postToolUse`):**
- Fire-and-forget. Errors are silently ignored.
- The `command` receives the tool result in `TOOL_RESULT`.

### Environment Variables Available to Hook Commands

| Variable | Description |
|----------|-------------|
| `TOOL_NAME` | Name of the tool being invoked |
| `TOOL_INPUT` | JSON-serialized tool input |
| `TOOL_RESULT` | Tool result text (post-hooks only, truncated to 10,000 chars) |

Hook commands have a **15-second timeout**. Commands that exceed this are killed.

### Examples

#### Block all Bash commands containing `rm -rf`

```json
{
  "hooks": {
    "preToolUse": [
      {
        "toolName": "Bash",
        "inputPattern": "rm -rf",
        "action": "deny",
        "message": "rm -rf commands are not allowed"
      }
    ]
  }
}
```

#### Log all file writes to a file

```json
{
  "hooks": {
    "postToolUse": [
      {
        "toolName": "Write",
        "command": "echo \"$(date): Wrote file $TOOL_INPUT\" >> ~/.ashlrcode/write-log.txt"
      }
    ]
  }
}
```

#### Run a linter after every Edit

```json
{
  "hooks": {
    "postToolUse": [
      {
        "toolName": "Edit",
        "command": "cd $PWD && npx eslint --fix $(echo $TOOL_INPUT | jq -r .file_path)"
      }
    ]
  }
}
```

#### Block writes to production config files

```json
{
  "hooks": {
    "preToolUse": [
      {
        "toolName": "Write",
        "inputPattern": "production\\.config",
        "action": "deny",
        "message": "Cannot write to production config files"
      }
    ]
  }
}
```

#### Allow all read operations without any hook processing

```json
{
  "hooks": {
    "preToolUse": [
      {
        "toolName": "Read",
        "action": "allow"
      },
      {
        "toolName": "Glob",
        "action": "allow"
      }
    ]
  }
}
```

---

## Permissions System

Source: `src/config/permissions.ts`

The permission system controls which tools can execute without user confirmation. Permissions are layered, with higher-priority rules checked first.

### Permission Check Order

1. **Bypass mode** (`--yolo`): If active, all tools are auto-approved.
2. **Read-only auto-allow**: A hardcoded set of tools that never need permission:
   - `Read`, `Glob`, `Grep`, `AskUser`, `WebFetch`
   - `EnterPlan`, `ExitPlan`, `PlanWrite`
   - `TaskCreate`, `TaskUpdate`, `TaskList`
   - `Agent`
3. **Auto-accept edits** (`--auto-accept-edits`): If active, `Write` and `Edit` are auto-approved. `Bash` still requires permission.
4. **Always deny** (persisted): Tools the user has chosen to always deny.
5. **Always allow** (persisted): Tools the user has chosen to always allow.
6. **Session allow**: Tools allowed for this session only (not persisted across restarts).
7. **Ask**: If none of the above match, the user is prompted.

### Permission Prompt

When the user is prompted, they have four choices:

| Key | Action | Persisted? |
|-----|--------|-----------|
| `y` / `yes` | Allow this one invocation | No |
| `a` / `always` | Always allow this tool | Yes -- saved to `permissions.json` |
| `n` / `no` | Deny this one invocation | No |
| `d` / `deny` | Always deny this tool | Yes -- saved to `permissions.json` |

### Persistence

Persisted permissions are stored in `~/.ashlrcode/permissions.json`:

```json
{
  "alwaysAllow": ["Write", "Edit"],
  "alwaysDeny": ["WebFetch"]
}
```

Choosing "always allow" removes the tool from the deny list, and vice versa.

### Plan Mode

When plan mode is active, all non-read-only tools are silently blocked. The permission system is not consulted -- the block happens at a higher level.

---

## MCP Server Configuration

Source: `src/mcp/types.ts`

MCP (Model Context Protocol) servers extend AshlrCode with additional tools via JSON-RPC 2.0 over stdio.

### MCPServerConfig Schema

```typescript
interface MCPServerConfig {
  command: string;        // Executable to run (e.g., "node", "python")
  args?: string[];        // Command-line arguments
  env?: Record<string, string>;  // Environment variables for the subprocess
}
```

### Configuring MCP Servers

Add MCP servers to `settings.json` under the `mcpServers` key:

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["./tools/db-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://localhost:5432/mydb"
      }
    },
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic/claude-in-chrome"]
    }
  }
}
```

### How MCP Works

1. At startup, AshlrCode connects to all configured MCP servers via the `MCPManager`.
2. Each server is spawned as a subprocess with stdio pipes.
3. AshlrCode sends a JSON-RPC `initialize` request to discover the server's capabilities and tools.
4. Discovered tools are registered in the tool registry with names prefixed by the server name (e.g., `mcp__database__query`).
5. When the model calls an MCP tool, AshlrCode forwards the request to the appropriate server and returns the result.

### MCP Protocol Types

```typescript
// Server capabilities reported during initialization
interface MCPServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

// Tool information from the server
interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// Tool execution result
interface MCPToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
```

### Disconnection

MCP servers are disconnected gracefully on exit (Ctrl+C or `/quit`). The `MCPManager.disconnectAll()` method is called during shutdown.

---

## Project Configuration (ASHLR.md / CLAUDE.md)

Source: `src/config/project-config.ts`

Project-level instructions are loaded from markdown files and injected into the system prompt. This is how you customize AshlrCode's behavior for a specific project.

### Config File Names

AshlrCode looks for these files (in order):

1. `ASHLR.md` -- primary project config
2. `CLAUDE.md` -- supported for compatibility with Claude Code

Both files are loaded if present. They are not mutually exclusive.

### Loading Behavior

The loader walks **up the directory tree** from the current working directory, collecting configuration files found along the way. This is similar to how `.gitignore` works:

1. Start at `cwd`
2. Check for `ASHLR.md` and `CLAUDE.md`
3. Move to the parent directory
4. Repeat up to 10 levels or until the filesystem root

**Precedence**: Files closer to `cwd` appear first in the merged instructions.

### Global Config

A global configuration file is also supported at:

```
~/.ashlrcode/ASHLR.md
```

This is loaded last (lowest precedence) and applies to all projects.

### How Instructions Are Used

All discovered config files are concatenated with headers and separators:

```markdown
# ASHLR.md (/home/user/project)

<contents of /home/user/project/ASHLR.md>

---

# CLAUDE.md (/home/user/project)

<contents of /home/user/project/CLAUDE.md>

---

# Global ASHLR.md

<contents of ~/.ashlrcode/ASHLR.md>
```

This merged string is appended to the system prompt, giving the model project-specific context and instructions.

### Example ASHLR.md

```markdown
# Project: My App

## Tech Stack
- Runtime: Bun
- Framework: Hono
- Database: PostgreSQL with Drizzle ORM
- Testing: Vitest

## Conventions
- Use `snake_case` for database columns
- Use `camelCase` for TypeScript variables
- All API routes go in `src/routes/`
- Write tests for every new feature

## Important Context
- The auth system uses JWT tokens stored in httpOnly cookies
- Never modify files in `src/generated/` -- they are auto-generated from the schema
```

### Sources Tracking

The `ProjectConfig` type tracks where instructions came from:

```typescript
interface ProjectConfig {
  instructions: string;    // Merged instruction text
  sources: string[];       // File paths where instructions were found
}
```

This allows debugging which config files are active for the current directory.
