# Troubleshooting

## Common Issues

### "No API key configured"

**Problem**: AshlrCode exits with "No API key configured" error.

**Solution**: Either set the environment variable or run the setup wizard:
```bash
# Option 1: Environment variable
export XAI_API_KEY="xai-your-key-here"

# Option 2: Run setup wizard
ac
# (wizard will prompt for key)

# Option 3: Edit settings directly
cat ~/.ashlrcode/settings.json
```

### Rate limit errors (429)

**Problem**: "Rate limited by provider" error.

**What happens**: AshlrCode automatically retries with exponential backoff (1s, 2s, 4s) up to 3 times. If all retries fail, it switches to the fallback provider if configured.

**Solutions**:
- Wait a few seconds and try again
- Configure a fallback provider in settings.json
- Use a different model: `/model grok-3` (cheaper, less likely to rate limit)

### "Auth error: check your API key"

**Problem**: 401/403 error from the provider.

**Solutions**:
- Verify your API key is correct: `echo $XAI_API_KEY`
- Check the key hasn't expired at [console.x.ai](https://console.x.ai/)
- Re-run setup: delete `~/.ashlrcode/settings.json` and run `ac`

### MCP servers failing at startup

**Problem**: "MCP: server failed" messages (these are now silent by default).

**Cause**: MCP servers in your settings.json aren't running or aren't installed.

**Solutions**:
- This is normal — MCP tools just won't be available
- Remove unused servers from `~/.ashlrcode/settings.json`
- Install the MCP server: `npx -y @supabase/mcp-server-supabase --help`

### Grep not finding results

**Problem**: Grep returns "No matches" when you know matches exist.

**Cause**: Ripgrep (`rg`) may not be in your PATH. AshlrCode falls back to system `grep` but it's slower and less featured.

**Solution**: Install ripgrep:
```bash
brew install ripgrep    # macOS
apt install ripgrep     # Ubuntu
```

### Permission prompts are annoying

**Problem**: Too many "Allow Bash?" prompts interrupting your workflow.

**Solutions**:
```bash
# Skip ALL permissions (trust the model completely)
ac --yolo

# Auto-approve file edits only (still ask for Bash)
ac --auto-accept-edits

# Permanently allow a tool (type 'a' when prompted)
Allow Bash? [y]es / [a]lways / [n]o / [d]eny always: a
# → Bash will be auto-allowed from now on

# Reset permissions
rm ~/.ashlrcode/permissions.json
```

### Context getting compacted / losing conversation

**Problem**: AshlrCode compacts your conversation and loses earlier context.

**Cause**: You've used more tokens than the provider's context window allows.

**Solutions**:
- Use xAI Grok (2M token context) instead of Claude (200K)
- Start a new session for unrelated tasks: `/clear`
- Watch for context warnings (shown at 50% and 75% of limit)
- Use `/compact` manually to control when compression happens

### Session resume not working

**Problem**: `ac --continue` doesn't find your previous session.

**Cause**: Sessions are keyed by working directory. If you `cd` to a different path, it won't find the session.

**Solutions**:
```bash
# Make sure you're in the same directory
cd ~/my-project
ac --continue

# Or use the session ID directly
ac --resume abc123

# List all sessions to find the right one
# (inside REPL)
/sessions
```

### Tool calls failing silently

**Problem**: The model calls a tool but the result seems wrong or empty.

**Solutions**:
- Check `/tools` to see all available tools
- Make sure you're not in plan mode (`/plan` to check) — plan mode blocks write tools
- Check hooks in settings.json — a hook may be denying the tool call
- Try `--yolo` to bypass all permission/hook restrictions

### Slow responses

**Problem**: AshlrCode takes a long time to respond.

**Causes & solutions**:
- **Model thinking**: Grok's reasoning tokens take time. This is normal (2-5 seconds typical).
- **Large context**: If you're 50+ turns into a conversation, context is large. Use `/compact` or `/clear`.
- **MCP timeout**: If MCP servers are configured but not running, they time out at startup (30s each).
- **Network**: Check your internet connection.

### File edit conflicts

**Problem**: Edit tool says "old_string not found" or "found N times".

**Cause**: The model is using stale information about the file content.

**Solutions**:
- The model should Read the file again before editing
- If the file changed externally (by you or another process), tell the model: "read the file again, it changed"
- Use `/restore <path>` to undo a bad edit

### Cost seems high

**Problem**: Requests cost more than expected.

**Explanation**: xAI Grok uses "reasoning tokens" that are separate from output tokens. These are billed at the output rate ($0.50/M). A simple request might use 200+ reasoning tokens internally.

**Solutions**:
- Check `/cost` for detailed breakdown (shows reasoning tokens separately)
- Use `--max-cost 1.00` to set a spending cap
- Use `grok-3-fast` for simpler tasks: `/model grok-3`
- Use `--print` for scripting (single request, no REPL overhead)

## Reset Everything

If something is really broken, you can reset AshlrCode to factory defaults:

```bash
# Remove all config and state
rm -rf ~/.ashlrcode

# Re-run setup
ac
```

This removes: settings, sessions, permissions, tasks, memory, and plans.

## Getting Help

- `/help` — list all REPL commands
- `/tools` — list all available tools
- `/skills` — list all available skills
- `ac --help` — CLI flags and usage
- [GitHub Issues](https://github.com/ashlrai/ashlrcode/issues)
