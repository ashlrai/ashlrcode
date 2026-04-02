---
name: init
description: Initialize AshlrCode for a new project (create ASHLR.md)
trigger: /init
---

Initialize AshlrCode for this project by creating an ASHLR.md file with project-specific instructions.

Steps:
1. Use Glob and LS to understand the project structure
2. Read package.json, Cargo.toml, requirements.txt, or equivalent for project type
3. Read README.md if it exists
4. Identify: framework, language, test commands, build commands, conventions
5. Create ASHLR.md with:

```markdown
# Project Name

Brief description of what this project is.

## Architecture
- Framework and key libraries
- Directory structure overview
- Key entry points

## Commands
- How to build: `command`
- How to test: `command`
- How to run: `command`

## Conventions
- Coding style notes
- Naming conventions
- File organization patterns
```

Keep it concise — only include what would help an AI assistant work effectively on this project.

{{args}}
