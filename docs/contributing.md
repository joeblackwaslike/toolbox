# Contributing

## Prerequisites

Node 22 and pnpm (dependencies and workspaces), Bun (runs TypeScript), uv (Python), just. Versions are pinned in `.nvmrc`, `.bun-version`, `.python-version` and `packageManager` in `package.json`.

The shell checks also need bats, shellcheck, shfmt and jq.

- macOS: `brew install bats-core shellcheck shfmt jq just uv bun`
- Ubuntu: `sudo apt-get install bats shellcheck jq`, plus shfmt, just, uv and Bun from their own installers

CI uses shfmt v3.14.1 from the [mvdan/sh releases](https://github.com/mvdan/sh/releases) on both OSes. Other shfmt releases format some lines differently, so `just lint` can fail with an older one; Ubuntu 24.04's apt package is 3.8.0.

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
| `just gen-check` | fails if generated files differ from what `tbx gen` would write |
| `just verify-tool <name>` | the done gate for one tool |
| `just verify-all` | lint, test, gen-check, then the done gate for every tool |
| `just test-sh` | bats suites only |

Suites with no tests exit 0.

## How `tbx verify` works

`tbx verify <tool>` runs lint, the tool's unit tests, the drift and contract checks, then builds the tool from your checkout, installs it into a throwaway HOME through a local release index, and runs the tool's `tests/e2e/` suite against that installed binary. Tools that declare a unit file also get it validated for the current OS. A tool whose `platforms` list leaves out the current OS is skipped and reported as skipped, so `tbx verify --all` passes on both macOS and Linux. With `CI=1` a missing unit validator fails instead of being skipped.

## Cross-tool e2e

`tests/e2e/cross-tool.test.ts` builds every real tool plus scaffolded ts, py and sh tools, installs them all from a local index into a temp HOME, and checks `tbx list`, `tbx help <tool> --json` and `tbx <tool>` dispatch. It runs as part of `just test`; to run it alone:

```sh
pnpm test tests/e2e/cross-tool.test.ts
```

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to main, on macOS and Ubuntu: `just lint`, `just test`, `pnpm tbx verify --all`, `just gen-check`, with `CI=1`.

## Git hooks

Husky sets `core.hooksPath=.husky/_` in the shared `.git/config`. In a fresh worktree, run `pnpm install` before committing, or the pre-commit hook fails. Checkouts without `.husky/_` bypass the hooks.

## Commits

Conventional Commits, enforced by commitlint through Husky.

The Python test recipe passes `-p no:faulthandler --no-header` because a bare run can hang in non-interactive shells (TTY detection).
