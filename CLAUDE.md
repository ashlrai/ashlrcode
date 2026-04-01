# AshlrCode

Multi-provider AI coding agent CLI. Internal tooling for AshlrAI.

## Architecture

- **Runtime**: Bun (TypeScript, no build step)
- **Primary provider**: xAI Grok 4.1 Fast (via OpenAI SDK)
- **Fallback provider**: Anthropic Claude (via Anthropic SDK)
- **Entry point**: `src/cli.ts`
- **Agent loop**: `src/agent/loop.ts` — AsyncGenerator streaming pattern
- **Providers**: `src/providers/` — unified interface, router with failover
- **Tools**: `src/tools/` — registry pattern with validate → permissions → execute

## Commands

```bash
bun run start              # Run CLI
bun run dev                # Run with watch mode
bun run src/cli.ts --help  # Show help
```

## Conventions

- Use Bun instead of Node.js for everything
- `bun test` for tests, `bun run` for scripts
- Bun auto-loads .env files

## Environment Variables

- `XAI_API_KEY` — xAI API key (required)
- `ANTHROPIC_API_KEY` — Claude API key (optional fallback)
- `AC_MODEL` — Override model (default: grok-4-1-fast-reasoning)

## Adding Tools

1. Create a new file in `src/tools/` implementing the `Tool` interface from `src/tools/types.ts`
2. Register it in `src/cli.ts` with `registry.register(yourTool)`
3. Tools need: `name`, `prompt()`, `inputSchema()`, `validateInput()`, `call()`
