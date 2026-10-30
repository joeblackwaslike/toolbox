# Contributing

## Prerequisites

- Node 22 and pnpm (dependencies and workspaces), Bun (runs TypeScript)
- uv (Python workspace)
- just
- Shell tooling: `brew install bats-core shellcheck shfmt`

Run everything from the repo root.

## Setup

```sh
just install
```

## Checks

| Recipe | What it runs |
|---|---|
| `just lint` | tsc, Biome, ESLint, ruff, mypy, shellcheck, shfmt |
| `just test` | Vitest, pytest, bats |
| `just verify-all` | lint, then test |
| `just test-sh` | bats suites only |

Suites with no tests exit 0.

## Git hooks

Husky sets `core.hooksPath=.husky/_` in the shared `.git/config`. In a fresh worktree, run `pnpm install` before committing, or the pre-commit hook fails. Checkouts without `.husky/_` bypass the hooks.

## Commits

Conventional Commits, enforced by commitlint through Husky.

The Python test recipe passes `-p no:faulthandler --no-header` because a bare run can hang in non-interactive shells (TTY detection).
