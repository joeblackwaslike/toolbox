# tbx design

Date: 2026-10-29
Status: builder check done, awaiting Joe review

## Why

Joe has about 40 small CLI scripts spread across `~/bin`, `~/.local/bin`, `helpers/projects/` and the agent-marketplace nursery. Most are hand-rolled shell with no tests, no shared conventions and inconsistent launchd names. One holds a live API token in plaintext. None of them can be shared as they are.

tbx is one repo where adding a tool or changing one is the fast path. Each tool is a small, tested, documented CLI that installs on macOS and Linux, runs by hand or from a script, and works from coding agents. The README, install path and docs are built for sharing from the first commit.

## Goals

- Saying "let's create a new tool" or "let's edit a tool" in Claude Code, Codex CLI, Gemini CLI or OpenClaw starts the matching workflow.
- A tool counts as done only after one command (`tbx verify <tool>`) passes lint, unit tests, a docs drift check and an end-to-end run.
- Human docs and agent docs come from one source and cannot disagree.
- Every tool works interactively on a TTY and fully non-interactively (flags only, `--json` output, stable exit codes).
- Install works for one tool or all of them, on macOS and Linux.
- The first batch of migrated tools proves the shell, Python and TypeScript paths.

## Non-goals

- Native apt or dnf repositories. `.deb` and `.rpm` files on GitHub Releases are enough.
- Windows support.
- A plugin API for third-party tools. Every tool lives in this repo.
- Migrating full applications, third-party installers, or large binaries from `~/bin`.

## Anti-goals

- Tools coupled so tightly to the `tbx` dispatcher that a broken dispatcher breaks them. Each tool must run on its own.
- Docs written by hand in two places.
- Secrets in files or source. A migrated tool that reads a token from a script body is a failure.

## Decisions Joe made

1. The umbrella command is `tbx`. The package is `tbx-cli` on both npm and PyPI, and the installed command is still `tbx`. Both package names were free on 2026-10-29. The bare name `tbx` is taken on PyPI (abandoned library, last release 2019) and `tbx-tools` is taken on npm.
2. Layout is hybrid. Each tool is its own standalone binary with a short name. `tbx` installs, updates, lists, checks and scaffolds tools, and also dispatches: `tbx <tool> ...` runs the same binary as `<tool> ...`.
3. Tools can be written in TypeScript, Python or shell. Existing tools keep their language.
4. Agent slash commands are `/tbx:<tool>`.
5. Agent targets on day one are Claude Code, Codex CLI, Gemini CLI and OpenClaw, with others added through the same generator.
6. Development uses Joe's stack and preferences, TDD throughout, and Superpowers end to end. At least two cross-tool end-to-end tests run before anything is considered done.
7. Some tools carry a launchd unit and a systemd unit.
8. Batch 1 to migrate: `transcribe` (shell), `op-sync-api-credentials` (shell, launchd), `cpu` (Python), `colorize` (Python), plus one new small TypeScript tool. Dropped: `orb-autostop` (to be archived), `luxafor` (stays in its own repo), the `clother` family (third-party installer).

9. A top-level `shared/` folder holds everything used by more than one tool: error handling, CLI generation, doc generation and other common conventions. Nothing common gets duplicated per tool.
10. Tests are organized into subfolders by kind, such as `unit/` and `e2e/`.

## Claude's calls (not agreed with Joe, check these)

- Folder layout (below).
- `tool.toml` as the single source of truth, with every other doc generated from it and checked for drift in CI.
- bats-core for shell tests, vitest for TypeScript, pytest for Python.
- Linters: biome and tsc for TypeScript, ruff and mypy for Python, shellcheck and shfmt for shell.
- A curl installer as the headline install, with Homebrew tap, `npx tbx-cli`, `pnpm dlx` and `uvx --from tbx-cli tbx` as alternates.
- The batch 1 TypeScript tool is chosen during implementation.
- Packaging: `shared/` is bundled into each tool at build time (esbuild for TypeScript, a single-file copy for shell, a vendored copy for Python), so every tool is a self-contained artifact with no runtime dependency on `tbx` or on a shared package.
- `tbx` itself is written in TypeScript and compiled with a pinned Bun to single-file binaries. Supported targets are macOS arm64 and x64 and Linux glibc arm64 and x64. Linux musl is not supported in v1, and the installer says so and exits. Asset names encode OS, architecture and libc, and CI smoke-tests every promised target on a runner of that target. Tools come from `tbx install`, which fetches per-tool tarballs from GitHub Releases.
- The curl installer downloads the matching binary and needs no Node or Python. `npx tbx-cli` and `uvx --from tbx-cli tbx` run `tbx` once from a cache. They do not put `tbx` on PATH, so the docs show `npx tbx-cli install` and `uvx --from tbx-cli tbx install` as the persistent bootstrap. The PyPI `tbx-cli` is a thin shim pinned to the exact release binary of the same version, verified by checksum.
- State: `tbx install` writes each tool into an immutable version directory under `~/.local/share/tbx/tools/<name>/<version>/` and links it into `~/.local/share/tbx/bin` (put on PATH by the installer). `~/.local/state/tbx/installed.json` records name and version. `tbx <tool>` resolves through that directory. `update` and `list` compare installed versions with the release index.
- Install safety: downloads are checksum-verified and extracted to a staging directory. A lock file serializes `install`, `update` and `uninstall`. Link replacement and state writes are atomic, and the previous version stays until the new one is active. An interrupted run is recovered by `tbx doctor`.
- Interface contract: `tool.toml` describes the interface for docs and completions. `tbx verify` runs `<tool> --help --json` and fails when the output differs from the manifest. It also runs generated behavioral contract tests for every documented flag and alias, required arguments, invalid input, exit codes and non-interactive behavior, so a parser cannot match the metadata while rejecting a documented flag.
- Units: launchd user agents on macOS and `systemctl --user` units on Linux. `platforms` in `tool.toml` gates install and verify, so a macOS-only tool is skipped on Linux. Checked-in unit files are portable templates. Install renders absolute executable paths into them (launchd does not inherit a shell PATH). Overrides are validated `tool.toml` input, never hand edits to generated files. Install unloads an old label before it loads the new one. Validation runs per OS: `plutil -lint` plus a key and type check on macOS, `systemd-analyze verify` on Linux, with validator versions pinned. A missing validator warns locally and fails in CI.
- Agent command names: Claude Code `/tbx:<tool>`. Gemini TOML commands under `commands/tbx/<tool>.toml`, which surface as `/tbx:<tool>` (directory-to-colon mapping confirmed in the Gemini docs). Codex: skills first; legacy custom prompts, if generated, are invoked as `/prompts:tbx-<tool>`. OpenClaw: names sanitized to letters, digits and underscores, 32 characters at most (`tbx_<tool>`), with a collision rule that truncates and appends a short hash, plus a generic skill invocation as fallback. A command loads the tool's generated reference and runs the tool with the user's arguments.
- Agent trigger acceptance: automated checks cover plugin manifest validation and the trigger phrases in each skill description. Runs against real agent CLIs are a manual smoke test before a release and stay out of CI.
- Releases: release-please in manifest mode, one tag per tool (`<tool>-v1.2.3`), with `tbx-cli` versioned on its own. A change under `shared/` computes the affected tools and forces a version bump and release for each, since their bundled copy changed. A generator change that alters shipped output does the same. Released versions are never rebuilt. Homebrew formula and npm/PyPI publishing run from the `tbx-cli` release.
- Gemini reads `GEMINI.md` by default, so the repo ships a `GEMINI.md` that imports `AGENTS.md`. Codex reads `AGENTS.md` directly.

## Layout

```text
tools/<name>/
  tool.toml        name, alias, summary, args, platforms, units
  src/             language specific
  tests/unit/      the tool's unit tests
  tests/e2e/       the tool's end-to-end tests
  units/           optional launchd and systemd unit templates
  docs/guide.md    optional long-form guide
shared/            everything used by more than one tool, per language:
                   error handling, CLI and argument generation, output and
                   path helpers, and the doc generator
plugin/            generated agent plugins plus the two workflow skills
tests/
  unit/            tests for shared/ and the tbx CLI
  e2e/             cross-tool end-to-end tests
  fixtures/        local release index and stubs for external services
install.sh         curl installer
docs/              catalog, conventions, contributing, llms.txt
```

## tool.toml

One file per tool, written by hand. It holds the tool's name and short alias, one-line summary, language, supported platforms, arguments and options with their short forms, and any launchd or systemd unit settings. The generator reads it and produces:

- the tool's README section and the catalog page
- the slash command for each agent platform
- the per-tool reference loaded by the `tbx` skill, and `llms.txt`
- shell completions
- the launchd plist and systemd unit

`tbx help <tool> --json` prints the same data for machines. CI fails when generated files differ from what the generator would write.

## Conventions every tool follows

- Short names for commands, subcommands, options and arguments, so they type with one hand.
- On a TTY the tool may prompt. `-y` or `--no-input` disables every prompt. `--json` prints machine-readable output to stdout and diagnostics to stderr.
- Exit codes are stable and documented per tool.
- Config and state live under XDG directories (`~/.config`, `~/.local/share`, `~/.local/state`), with the standard macOS fallbacks.
- Secrets come from the environment or 1Password, never from files in the repo.
- `shared/` provides error handling, argument parsing, output and path helpers, so tools do not repeat boilerplate.

## The `tbx` command

`list`, `install <tool|all>`, `update`, `uninstall`, `doctor`, `new <name> --lang ts|py|sh`, `verify <tool|--all>`, `help <tool>`. Installing links tool binaries into one managed bin directory that goes on PATH. `doctor` reports PATH problems, missing dependencies, stale links and broken units.

## Done gate

`tbx verify <tool>` runs:

1. Lint for the tool's language.
2. The tool's unit tests (`tests/unit/`).
3. The generator drift check and the interface contract tests.
4. A build of the candidate artifact from the current checkout, installed through a local release-index fixture (`tests/fixtures/`), never a previously published release. The run isolates HOME, the XDG directories and PATH, stubs external services such as `op` and `osascript`, and puts a deadline on every pty session. It exercises interactive mode (in a pty) and non-interactive mode (`tests/e2e/`).
5. For tools with units, the per-OS unit validation described above.

CI runs the same on a macOS and Linux matrix. The repo-level `tests/e2e/` suite has at least two tests that cross tool boundaries, such as installing everything and running `tbx list` and `tbx doctor`. Any change under `shared/` or to `tbx` itself runs that suite, plus `verify` for every affected tool.

## Agent workflows

The plugin ships two skills. One triggers on "create a new tool" and runs brainstorming, then `tbx new`, then test-driven development, then `tbx verify`. The other triggers on "edit a tool" and runs a shorter loop with a failing test first. Both use Superpowers and Joe's stack preferences. The repo also carries an `AGENTS.md` for Codex, and a `GEMINI.md` that imports it for Gemini, so sessions in this repo follow the same rules.

## Distribution

The headline is `curl -fsSL <url> | sh`, which installs `tbx` and then any tools named. Alternates are a Homebrew tap, plus `npx tbx-cli install`, `pnpm dlx tbx-cli install` and `uvx --from tbx-cli tbx install` (the bare forms without `install` run `tbx` once and leave nothing on PATH). Releases attach `.deb` and `.rpm` files. Versions are per tool with semver, and releases are automated. The repo README opens with the install line, a short demo and the tool catalog.

## Migration notes

- The ~40 scripts found in the inventory are mostly shell with hand-rolled `case "${1:-}"` parsing and no tests. Write the test first for each migrated tool.
- `~/bin` has stale symlinks pointing at old nursery paths. Migration gives each tool one managed link.
- launchd labels across the existing units are inconsistent (`com.joeblack.*`, `com.joe.*`, `nyc.joeblack.*`, `ai.joeblackwaslike.*`). Generated units use one scheme.
- `op-sync-api-credentials` (source in `helpers/projects/op-credential-sync`) is a 73-line bash script. A daily 9 AM launchd job (`com.joeblack.op-sync-api-credentials`, `RunAtLoad` off, log at `~/Library/Logs/op-sync-api-credentials.log`) shows an `osascript` dialog, then copies new API credentials from the Personal vault to the Development vault in 1Password. It is macOS-only (`platforms = ["macos"]`) and its prompt is hard-wired, so the migration adds `-y` for non-interactive runs and a test that stubs `op` and `osascript`. Keep the behavior; the label moves to the generated scheme, which means reinstalling the unit.
- `~/bin/glm-claude` holds a plaintext API token. Do not copy it anywhere. The token needs rotating by Joe.

## Unverified

- Whether the npm org `tbx` is free. The first publish settles it.
- Whether `tbx` collides with a binary in apt or dnf. To be checked in a container.
- The current OpenClaw plugin format. Check its docs before building that adapter.

## Human-only steps

Publishing the `tbx-cli` 0.0.1 placeholders on npm and PyPI requires Joe's login. Rotating the exposed token requires the provider dashboard.

## Left to the builder

Exact manifest schema, generator internals, the choice of arg-parsing library per language (following Joe's stack preferences), the new TypeScript tool's purpose, CI details, and the installer's implementation.
