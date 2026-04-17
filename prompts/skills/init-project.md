---
name: init-project
description: Detect project stack and generate a CLAUDE.md with conventions, commands, and architecture
trigger: /init-project
---

Scan the current project and generate a comprehensive CLAUDE.md (or AGENTS.md) that helps AI assistants work effectively in this codebase.

## Step 1: Detect the project stack

Scan for project manifests and configuration files:

| File | Detects |
|------|---------|
| `package.json` | Node.js — check for framework (Next.js, React, Express, Fastify, Nest, etc.) |
| `tsconfig.json` | TypeScript — check strict mode, paths, target |
| `pyproject.toml` / `setup.py` / `requirements.txt` | Python — check for Django, FastAPI, Flask, etc. |
| `Cargo.toml` | Rust |
| `go.mod` | Go |
| `Gemfile` | Ruby — check for Rails |
| `pom.xml` / `build.gradle` | Java/Kotlin |
| `.swift-version` / `Package.swift` | Swift |

Detect tooling:
- **Package manager**: npm, yarn, pnpm, bun, pip, cargo, go
- **Test runner**: jest, vitest, bun test, pytest, cargo test, go test
- **Linter**: eslint, biome, ruff, clippy, golangci-lint
- **Formatter**: prettier, biome, black, rustfmt, gofmt
- **CI**: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`
- **Monorepo**: `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`

## Step 2: Analyze the architecture

1. Use Glob to map the directory structure (top 2 levels)
2. Read the entry point(s) to understand the app structure
3. Identify key patterns: MVC, layered, modular, monorepo
4. Note any existing CLAUDE.md, AGENTS.md, ASHLR.md, or .cursorrules — read them for context
5. Check README.md for project description and setup instructions
6. Check for `.env.example` to document required environment variables

## Step 3: Generate CLAUDE.md

Create the file with this structure:

```markdown
# Project Name

One-line description of what this project does.

## Architecture

- **Runtime**: Language version and runtime
- **Framework**: Primary framework and key libraries
- **Database**: If applicable
- **Key directories**:
  - `src/` — description
  - `tests/` — description
  - etc.

## Commands

```bash
# Install dependencies
<detected command>

# Run development server
<detected command>

# Run tests
<detected command>

# Run single test file
<detected command> path/to/test

# Lint
<detected command>

# Type check
<detected command>

# Build
<detected command>
```

## Conventions

- Coding style notes (from eslint/prettier config)
- File naming patterns observed
- Import style (named vs default, path aliases)
- Error handling patterns
- Test file location and naming convention

## Environment Variables

- `VAR_NAME` — description (from .env.example)
```

## Step 4: Finishing touches

1. If an existing CLAUDE.md / AGENTS.md / ASHLR.md exists, ask before overwriting — offer to merge
2. If `ashlr-genome-init` is available (check for ashlr plugin), mention the user can also run `/ashlr:ashlr-genome-init` for deeper project indexing
3. Output a summary of what was detected and what was created

Keep the file concise and actionable. Only include information that would genuinely help an AI assistant navigate and contribute to this project. Do not pad with generic advice.

{{args}}
