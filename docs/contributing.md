# Contributing

## Prerequisites

Node 22 and pnpm (dependencies and workspaces), Bun (runs TypeScript), uv (Python), just. Versions are pinned in `.nvmrc`, `.bun-version`, `.python-version` and `packageManager` in `package.json`.

The shell checks also need bats, shellcheck, shfmt and jq. `tbx verify` also needs `python3` on PATH, because its interactive check runs the tool in a pseudo-terminal through Python's `pty` module.

- macOS: `brew install bats-core shellcheck shfmt jq just uv bun`
- Ubuntu: `sudo apt-get install bats shellcheck jq`, plus shfmt, just, uv and Bun from their own installers

CI uses shfmt v3.14.1 from the [mvdan/sh releases](https://github.com/mvdan/sh/releases) on both OSes. Other shfmt releases format some lines differently, so `just lint` can fail with an older one; Ubuntu 24.04's apt package is 3.8.0.

Run everything from the repo root.

## Setup

```sh
just install
```

## Running tbx

tbx is not installed globally. Run it through the `tbx` script in `package.json`, from the repo root:

```sh
pnpm tbx list
pnpm tbx help transcribe
```

It exits 0 on success, 1 when a command fails, 2 for a usage error, 69 when something it needs is missing (a command, a held install lock, a platform the tool does not support) and 78 for a configuration error such as an invalid `tool.toml`.

## Adding a tool

1. Search for a helper you can reuse: `pnpm tbx shared search <word>`.
2. Scaffold the tool: `pnpm tbx new <name> --lang ts|py|sh`. This writes `tools/<name>/` with `tool.toml`, a `src/` entry, one failing unit test and an empty `tests/e2e/`, then runs `tbx gen`.
3. If the tool needs a helper that does not exist yet and another tool could use it, scaffold it in `shared/`: `pnpm tbx shared new <name> --lang ts|py|sh`.
4. Edit `tool.toml`, then run `just gen` to regenerate the README, completions and docs. [conventions.md](conventions.md) lists the manifest rules.
5. Make the failing test pass, then run `just verify-tool <name>`.

Installed tools need a runtime on the machine that runs them: Bun for TypeScript tools (the bundle starts with `#!/usr/bin/env bun`), Python 3.12 or newer for Python tools (a zipapp started with `#!/usr/bin/env python3`), and bash for shell tools.

## Building and installing locally

```sh
pnpm tbx build <name>      # or: pnpm tbx build all
pnpm tbx install <name>    # or: pnpm tbx install all
```

`build` writes the artifacts and `dist/release/index.json`. `tbx install` and `tbx update` default to the remote index on the `release-index` branch (`https://raw.githubusercontent.com/joeblackwaslike/toolbox/release-index/index.json`), which `--index` or `TBX_INDEX` overrides. For a local build, pass `--index dist/release/index.json`. `install` puts the tool under `~/.local/share/tbx/tools/<name>/<version>/` and links `~/.local/share/tbx/bin/<name>` (and its alias) to it. `$XDG_DATA_HOME` moves both directories, and `$TBX_BIN_DIR` moves the links. Add the bin directory to PATH once, for example in `~/.zshrc`:

```sh
export PATH="$HOME/.local/share/tbx/bin:$PATH"
```

Without it, `pnpm tbx <name>` still runs an installed tool. `pnpm tbx list` shows the installed version next to the checkout version, and `pnpm tbx uninstall <name>` removes a tool and its links.

## Checks

| Recipe | What it runs |
|---|---|
| `just lint` | tsc, Biome, ESLint, ruff, mypy, shellcheck, shfmt |
| `just test` | Vitest, pytest, bats |
| `just gen-check` | fails if generated files differ from what `tbx gen` would write |
| `just verify-tool <name>` | the done gate for one tool |
| `just verify-all` | lint, test, gen-check, then the done gate for every tool |
| `just test-sh` | bats suites only |
| `just gen` | regenerates READMEs, completions and docs |

Suites with no tests exit 0. The Python test recipe passes `-p no:faulthandler --no-header` because a bare run can hang in non-interactive shells (TTY detection).

## How `tbx verify` works

`tbx verify <tool>` runs lint, the tool's unit tests, the drift and contract checks, then builds the tool from your checkout, installs it into a throwaway HOME through a local release index, and runs the tool's `tests/e2e/` suite against that installed binary. Tools that declare a unit file also get it validated for the current OS. A tool whose `platforms` list leaves out the current OS is skipped and reported as skipped, so `tbx verify --all` passes on both macOS and Linux. With `CI=1` a missing unit validator fails instead of being skipped.

## Cross-tool e2e

`tests/e2e/cross-tool.test.ts` builds every real tool plus scaffolded ts, py and sh tools, installs them all from a local index into a temp HOME, and checks `tbx list`, `tbx help <tool> --json` and `tbx <tool>` dispatch. It runs as part of `just test`; to run it alone:

```sh
pnpm test tests/e2e/cross-tool.test.ts
```

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to main, on two arm64 runners, `macos-15` and `ubuntu-24.04-arm`: `just gen-check`, `just lint`, `just test`, then `pnpm tbx verify --all`, with `CI=1`.

## Releasing

Conventional Commits drive each tool's version through release-please. It opens one release PR per changed tool and, when that PR merges, tags the release `<component>-v<version>`. The `tbx/` directory releases as `tbx-cli`. A `Release-As:` footer in a commit overrides the computed bump. A new package starts at `0.0.0` in `.release-please-manifest.json`, and its `initial-version` in `release-please-config.json` sets its first version. Any other manifest version counts as already released, so release-please would bump the first release past it.

Tools bundle the shared code, so on each push to main the stamp job runs `tbx stamp --write` and commits the result as `fix(<component>): bundle updated shared`. Run `pnpm tbx stamp --check` locally to see whether a stamp is stale.

`release.yml` is the only publishing path. It builds and signs the binaries, creates the GitHub releases, publishes to npm, PyPI and the Homebrew tap, and updates the `release-index` branch. To recover a failed release, dispatch `release.yml` with the `tags` input set to the tag. A rerun reuses a complete release and replaces the partial assets of an incomplete one.

The workflow needs these repository secrets: `NPM_TOKEN`, `HOMEBREW_TAP_TOKEN`, and the five macOS signing secrets. PyPI uses a trusted publisher bound to workflow `release.yml` and environment `pypi`, so it needs no token. The `sign-check.yml` workflow is a manual check of macOS signing and notarization; dispatch it after changing the signing steps.

Users install a tool with:

```sh
curl -fsSL https://raw.githubusercontent.com/joeblackwaslike/toolbox/main/install.sh | sh -s -- <tool>
```

## Git hooks

Husky sets `core.hooksPath=.husky/_` in the shared `.git/config`. In a fresh worktree, run `pnpm install` before committing, or the pre-commit hook fails. Checkouts without `.husky/_` bypass the hooks.

## Commits

Conventional Commits, enforced by commitlint through Husky.
