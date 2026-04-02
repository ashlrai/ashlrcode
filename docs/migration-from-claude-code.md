# Migrating from Claude Code

AshlrCode is designed as a drop-in replacement for Claude Code when your usage runs out. Here's how features map.

## Quick Comparison

| Feature | Claude Code | AshlrCode |
|---------|-------------|-----------|
| CLI command | `claude` | `ac` |
| Provider | Anthropic only | xAI Grok, Anthropic, any OpenAI-compatible |
| Cost | Max plan ($100-200/mo) | Pay-per-use (~$0.001/request on Grok) |
| Context window | 200K tokens | 2M tokens (Grok) |
| Tools | 40+ | 30 |
| Skills | 80+ (built-in) | 15 + custom |
| MCP support | Yes | Yes |
| Hooks | Yes | Yes |
| Plan mode | Yes | Yes |
| Sessions | Yes | Yes |
| Permission system | Yes | Yes |
| IDE extensions | VS Code, JetBrains | CLI only |
| Voice mode | Yes | No |
| Extended thinking | Yes | No (reasoning tokens are internal) |

## Command Mapping

| Claude Code | AshlrCode | Notes |
|-------------|-----------|-------|
| `claude` | `ac` | Interactive REPL |
| `claude "task"` | `ac "task"` | Single-shot |
| `claude --continue` | `ac --continue` or `ac -c` | Resume last session |
| `claude --resume` | `ac --resume <id>` | Resume specific session |
| `claude --dangerously-skip-permissions` | `ac --yolo` | Same behavior |
| `claude --print` | `ac --print` | Raw output for piping |
| `/compact` | `/compact` | Same |
| `/cost` | `/cost` | Same (shows reasoning tokens too) |
| `/clear` | `/clear` | Same |
| `/help` | `/help` | Same |
| `/model` | `/model` | Same, with aliases (grok-fast, sonnet, etc.) |

## Config Migration

### CLAUDE.md → ASHLR.md

AshlrCode reads both `CLAUDE.md` and `ASHLR.md` from your project directory. Your existing `CLAUDE.md` files work as-is — no changes needed.

### settings.json

Claude Code: `~/.claude/settings.json`
AshlrCode: `~/.ashlrcode/settings.json`

Key differences in format:
- Provider config uses `providers.primary` and `providers.fallbacks` structure
- Hooks use `hooks.preToolUse` and `hooks.postToolUse` arrays
- MCP servers use same format (`mcpServers` key)

### Permissions

Claude Code persists permissions in its own format.
AshlrCode uses `~/.ashlrcode/permissions.json` with `alwaysAllow` and `alwaysDeny` arrays.

### Skills

Claude Code skills: `~/.claude/commands/*.md`
AshlrCode skills: `~/.ashlrcode/skills/*.md`

The skill file format is similar (frontmatter + prompt). Your Claude Code skills can be copied with minor adjustments:
- Change `trigger:` if needed
- Replace `{{arguments}}` with `{{args}}`
- Remove Claude Code-specific tool references

## What's Different

### Better
- **Cost**: ~$0.001/request on Grok vs Claude Max plan pricing
- **Context window**: 2M tokens (Grok) vs 200K (Claude)
- **Provider flexibility**: Switch models anytime with `/model`
- **Transparency**: See exact cost per request with reasoning token breakdown

### Missing (compared to Claude Code)
- **IDE extensions**: No VS Code or JetBrains integration yet
- **Voice mode**: No voice input
- **Extended thinking display**: Grok reasons internally but doesn't show it
- **Web search (built-in)**: Claude Code has native web search; AshlrCode uses DuckDuckGo
- **Some tools**: Claude Code has ~40 tools; AshlrCode has 30
- **Some skills**: Claude Code ships 80+ skills; AshlrCode has 15 (but you can add custom ones)

### Same
- **Core workflow**: Read → Edit → Bash → commit
- **MCP support**: Same protocol, same servers
- **Plan mode**: Same concept (read-only exploration → plan → execute)
- **Session persistence**: Both use file-based JSONL
- **Permission system**: Both have allow/deny/ask with persistence

## Bifrost Alternative

Instead of using AshlrCode, you can route Claude Code itself through xAI Grok using Bifrost:

```bash
# Start Bifrost proxy
./scripts/bifrost-setup.sh

# Use Claude Code with Grok
ANTHROPIC_BASE_URL=http://localhost:8080/anthropic claude
```

This gives you Claude Code's full feature set but with Grok's pricing. The tradeoff is you need the Bifrost proxy running.
