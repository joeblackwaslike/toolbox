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

## Commits

Conventional Commits, enforced by commitlint through Husky.
