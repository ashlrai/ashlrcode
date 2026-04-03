# Contributing to AshlrCode

Thanks for your interest in contributing! Here's how to get started.

## Dev Environment Setup

```bash
git clone https://github.com/ashlrai/ashlrcode.git
cd ashlrcode
bun install
bun link    # makes 'ac' and 'ashlrcode' available globally
```

## Running Tests

```bash
bun test                # run all tests
bunx tsc --noEmit       # type check
```

All PRs must pass both commands.

## Adding a Tool

1. Create a new file in `src/tools/` implementing the `Tool` interface
2. Register the tool in `src/cli.ts`
3. Add tests in `src/__tests__/`

See existing tools for examples of the interface shape and patterns.

## Adding a Skill

1. Create a `.md` file in `prompts/skills/`
2. The filename becomes the slash command (e.g., `my-skill.md` -> `/my-skill`)
3. Follow the format of existing skill files for structure

## PR Process

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure `bun test` and `bunx tsc --noEmit` pass
4. Open a pull request against `main`
5. Describe what changed and why in the PR description

## Code Style

- TypeScript strict mode
- No `any` types unless truly necessary
- Handle errors explicitly -- no silent catches
- Keep functions small and focused
