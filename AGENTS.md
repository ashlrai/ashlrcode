# AshlrCode agent instructions

Read [CLAUDE.md](CLAUDE.md) for the architecture and
[CONTRIBUTING.md](CONTRIBUTING.md) for the fork and pull request workflow.

## Fleet Constitution Article 1

Follow [Phantom's Article 1](https://github.com/ashlrai/phantom/blob/master/AGENTS.md#article-1-full-autonomy-always-forward)
within the effective signed repository scope. Follow the fleet hold list,
Security GATES v3, required checks, branch protection, and release approvals.
Use GitHub auto-merge when the repository and effective scope permit it.
Never bypass rulesets, force-push a default branch, expose credentials or
private material, or change billing.

## Verification and publication

Run `bun test` and `bun run typecheck` before opening a pull request
against `main`. The [npm publication workflow](.github/workflows/publish.yml)
publishes from a published GitHub release. Use that workflow with the
repository's authorized release process.
