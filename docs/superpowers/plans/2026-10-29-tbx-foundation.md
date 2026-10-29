# tbx foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the repo scaffold, `shared/`, manifest-driven generator, the `tbx` CLI core and the `tbx verify` done gate, proven end to end by migrating `transcribe`.

**Architecture:** `tool.toml` is parsed into one typed manifest. `shared/` turns it into a CLI parser for each language (TypeScript, Python, shell), plus README, completions and unit files. `tbx` builds each tool into a self-contained artifact and installs it from a local release-index fixture. `tbx verify` gates a tool on lint, unit tests, drift, contract tests and an isolated e2e run.

**Tech Stack:** TypeScript (pnpm workspace, Commander, Zod, smol-toml, esbuild, Vitest, Biome, ESLint strict), Python (uv, Typer, Click, Rich, Tenacity, pytest, ruff, mypy), shell (bats-core, shellcheck, shfmt), Bun for compiling `tbx`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-29-tbx-design.md`

**Plan series:** this is plan 1 of 3. Plan 2 covers agent plugins and the three workflow skills (including `/tbx:shared-new`), the curl installer and remote releases, release-please, and the Homebrew, npm and PyPI packaging. Plan 3 covers `op-sync-api-credentials`, `cpu`, `colorize`, the new TypeScript tool and `tbx doctor`.

## Global Constraints

- Umbrella command `tbx`; package `tbx-cli` on npm and PyPI; each tool is its own standalone binary and `tbx <tool> ...` runs the same binary.
- Tool languages are `ts`, `py` and `sh`; existing tools keep their language.
- Every tool: `-y` or `--no-input` disables all prompts; `--json` prints machine-readable output to stdout and diagnostics to stderr; exit codes are stable and documented per tool.
- Config and state use XDG directories (`~/.config`, `~/.local/share`, `~/.local/state`). Secrets come from the environment or 1Password, never from files in the repo.
- `shared/` is bundled into each tool at build time; no tool depends at runtime on `tbx` or on a shared package.
- State layout: `~/.local/share/tbx/tools/<name>/<version>/`, links in `~/.local/share/tbx/bin`, record at `~/.local/state/tbx/installed.json`. A lock file serializes `install`, `update` and `uninstall`; link and state writes are atomic; the previous version stays until the new one is active.
- Tests live in `tools/<name>/tests/unit/`, `tools/<name>/tests/e2e/`, `tests/unit/`, `tests/e2e/` and `tests/fixtures/`. Verify never installs a published release; it builds the candidate from the checkout.
- Supported `tbx` targets: macOS arm64 and x64, Linux glibc arm64 and x64. Linux musl is unsupported and the installer says so.
- Reuse first: anything common to these programs lives in `shared/`, never copied into a tool. Every public symbol under `shared/` has a doc comment, and generated pages under `docs/shared/` must not drift.
- Repo rules: no ASCII banner comments, no inline comments unless unavoidable, docstrings on public APIs, tests written first and watched failing, conventional commits.

## Review Focus

- A tool name or alias that collides with another tool or an existing PATH binary. Expected: `tbx gen` and `tbx new` refuse it. Pinned in Task 2.
- `-y` with a required argument missing. Expected: exit 2 with a usage message, never a hang on a prompt. Pinned in Task 4.
- `--json` on a non-TTY stdin. Expected: stdout is valid JSON only, no prompt text. Pinned in Task 4.
- A HOME path with spaces or non-ASCII characters. Expected: rendered unit files and links still resolve. Pinned in Task 6.
- An interrupted `install` during an update. Expected: the previous version still runs. Pinned in Task 8.

## File structure

```text
tbx/                    umbrella CLI: src/commands/{list,new,gen,build,install,verify,shared}.ts
shared/ts/src/         manifest.ts errors.ts output.ts cli.ts gen/{readme,completions,unit,contract}.ts
shared/py/tbx_shared/  errors.py output.py cli.py
shared/sh/             lib.sh gen-parser.ts (emits the parser prelude)
tools/transcribe/      tool.toml src/transcribe tests/unit tests/e2e units/
tests/{unit,e2e,fixtures}/
docs/shared/          generated pages for everything under shared/
justfile  biome.json  eslint.config.mjs  pnpm-workspace.yaml  .github/workflows/ci.yml
```

---

### Task 1: Scaffold the workspace

**Files:** Create the root workspace files listed above, `shared/py/pyproject.toml`, `tests/` skeleton, `justfile`.

**Interfaces:**

- Produces: `just lint`, `just test` and `just verify-all` recipes that run biome, tsc, eslint, vitest, ruff, mypy, pytest, shellcheck, shfmt and bats. Later tasks add their suites to these.

- [ ] **Step 1: Repair `spinup-ts`.** The global install fails with `ERR_MODULE_NOT_FOUND` for `@clack/prompts`. In `~/github/joeblackwaslike/spinup-ts` run `pnpm install && pnpm build && npm link`, then confirm `spinup-ts --help` prints usage.
- [ ] **Step 2: Scaffold the TypeScript root** with `spinup-ts` non-interactively into this worktree (pnpm, Biome, ESLint strict, Vitest, Husky, justfile). Inspect `spinup-ts --help` for the non-interactive flags first. Remove any Docusaurus, Docker and devcontainer output the spec does not use.
- [ ] **Step 3: Scaffold `shared/py`** with `spinup-py -y` as a uv project named `tbx-shared`, then wire a uv workspace at the repo root.
- [ ] **Step 4: Add bats-core, shellcheck and shfmt** as dev prerequisites (document `brew install bats-core shellcheck shfmt` in `docs/contributing.md`) and add `just test-sh`.
- [ ] **Step 5: Verify.** Run `just lint && just test`. Expected: all suites pass with zero tests collected, exit 0.
- [ ] **Step 6: Commit** `chore: scaffold ts, py and sh workspace`.

### Task 2: Manifest schema and loader

**Files:** Create `shared/ts/src/manifest.ts`; Test `tests/unit/manifest.test.ts`.

**Interfaces:**

- Produces: `ToolManifest` (Zod-inferred type) with `name: string` (`/^[a-z][a-z0-9-]{0,15}$/`), `alias?: string`, `summary: string` (max 80), `language: 'ts'|'py'|'sh'`, `version: string` (semver), `platforms: ('macos'|'linux')[]` (at least one), `args: ArgSpec[]`, `options: OptSpec[]`, `unit?: UnitSpec`. `ArgSpec = {name, summary, required: boolean}`. `OptSpec = {long, short?, summary, type: 'bool'|'string'|'int', default?}`. `UnitSpec = {kind: 'schedule'|'daemon', calendar?: {hour:number, minute:number}, interval?: number, runAtLoad: boolean}`.
- Produces: `parseManifest(toml: string): ToolManifest` and `loadManifest(path: string): Promise<ToolManifest>`, both throwing `ManifestError` with the failing field path. `assertNoCollisions(manifests: ToolManifest[], pathBinaries: string[]): void` throws `ManifestError` naming both owners.

- [ ] **Step 1: Write failing tests** `parses a valid manifest`, `rejects a name over 16 characters`, `rejects an unknown language`, `rejects a schedule unit without calendar or interval`, `assertNoCollisions throws when an alias equals another tool's name`, `assertNoCollisions throws when a name equals a binary already on PATH`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/manifest.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the schema with Zod and `smol-toml`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): manifest schema and collision check`.

### Task 3: Errors, exit codes and output

**Files:** Create `shared/ts/src/errors.ts`, `shared/ts/src/output.ts`, `shared/py/tbx_shared/errors.py`, `shared/py/tbx_shared/output.py`, `shared/py/tbx_shared/retry.py`, `shared/sh/lib.sh`; Tests in `tests/unit/` for each language.

**Interfaces:**

- Produces (ts): `ExitCode = {ok: 0, failure: 1, usage: 2, unavailable: 69, config: 78}`; `class ToolError extends Error { constructor(message: string, readonly code: number = ExitCode.failure) }`; `createOutput(opts: {json: boolean}): Output` with `Output.result(data: unknown): void` (stdout; JSON when `json`), `Output.info(msg: string): void` and `Output.error(msg: string): void` (both stderr).
- Produces (py): `ExitCode`, `ToolError(message, code=1)`, `Output(json: bool)` with the same three methods. Human-mode output renders through a Rich `Console` (stdout for `result`, `Console(stderr=True)` for `info` and `error`); with `json` true, `result` prints plain JSON and no Rich markup reaches either stream.
- Produces (py): `retry_policy(attempts: int = 3, base: float = 0.5, max_wait: float = 10.0, retry_on: tuple[type[BaseException], ...] = (OSError,)) -> tenacity.Retrying` (stop after `attempts`, exponential wait capped at `max_wait`, `reraise=True`) and `with_retry(fn: Callable[P, R], policy: Retrying | None = None) -> Callable[P, R]`. Tools use these instead of hand-rolled loops.
- Produces (sh): `tbx_die <code> <message>` (message to stderr, exit with code), `tbx_result <text|json>`, with `TBX_JSON=1` switching to JSON.

- [ ] **Step 1: Write failing tests** in each language: `result writes only JSON to stdout when json is true`, `info and error never write to stdout`, `ToolError defaults to exit code 1`, `retry_policy retries a failing call then succeeds`, `retry_policy reraises the last error after the attempt limit`, `retry_policy does not retry an exception outside retry_on`, and for sh `tbx_die exits with the given code and writes to stderr` (bats).
- [ ] **Step 2: Run** `just test`. Expected: FAIL in the three new suites.
- [ ] **Step 3: Implement** the three modules to match the signatures.
- [ ] **Step 4: Run** `just test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): errors, exit codes and output helpers`.

### Task 4: Generated CLI parsers and contract tests

**Files:** Create `shared/ts/src/cli.ts`, `shared/py/tbx_shared/cli.py`, `shared/sh/gen-parser.ts`, `shared/ts/src/gen/contract.ts`; Tests `tests/unit/cli.test.ts`, `shared/py/tests/test_cli.py`, `tests/unit/parser.bats`.

**Interfaces:**

- Consumes: `ToolManifest`, `ToolError`, `ExitCode`, `createOutput`.
- Produces (ts): `defineTool(m: ToolManifest, run: (ctx: ToolContext) => Promise<void>): Promise<never>` where `ToolContext = {args: Record<string,string>, opts: Record<string, string|number|boolean>, json: boolean, interactive: boolean, out: Output}`. It adds `-y`/`--no-input`, `--json` and `--help --json` (prints the manifest-derived usage as JSON), maps `ToolError` to its exit code, and sets `interactive` only when stdin is a TTY and neither `-y` nor `--json` was given.
- Produces (py): `define_tool(manifest: dict, run: Callable[[ToolContext], None]) -> NoReturn`, same behavior. It builds Click commands from the manifest and exposes them as a Typer app, so a tool with nested subcommands writes those in Typer and mounts them through `typer.main.get_command`. Rich handles help rendering and errors in human mode.
- Produces (sh): `generateShellParser(m: ToolManifest): string` returning a bash prelude that parses the manifest's flags into `TBX_ARG_*` and `TBX_OPT_*` variables, handles `-y`, `--json`, `--help`, `--help --json`, and exits 2 on bad input.
- Produces: `generateContractTests(m: ToolManifest): ContractCase[]` with `ContractCase = {name: string, argv: string[], expectExit: number, expectStdout?: 'json'}` covering every option and alias, each missing required argument, an unknown flag, and `-y` and `--json` behavior.

- [ ] **Step 1: Write failing tests** per language: `exits 2 when a required argument is missing and -y is set` (must not prompt), `--json on a non-tty stdin prints valid JSON only to stdout`, `--help --json output deep-equals the manifest-derived usage`, `unknown flag exits 2`, and for `generateContractTests`: `emits one case per documented option`.
- [ ] **Step 2: Run** `just test`. Expected: FAIL.
- [ ] **Step 3: Implement** the three parsers and the contract generator against the signatures. Use Commander for ts and Click wrapped by Typer for py; the sh prelude is plain bash with `set -euo pipefail`.
- [ ] **Step 4: Run** `just test`. Expected: PASS, and shellcheck clean on the generated prelude.
- [ ] **Step 5: Commit** `feat(shared): manifest-driven parsers and contract cases`.

### Task 5: Doc generator and drift check

**Files:** Create `shared/ts/src/gen/readme.ts`, `shared/ts/src/gen/completions.ts`, `shared/ts/src/gen/index.ts`; Test `tests/unit/gen.test.ts`; Fixture `tests/fixtures/tools/demo/tool.toml`.

**Interfaces:**

- Consumes: `ToolManifest`, `loadManifest`.
- Produces: `GeneratedFile = {path: string, content: string}`; `renderToolReadme(m): string`; `renderCatalog(ms: ToolManifest[]): string`; `renderCompletions(m, shell: 'zsh'|'bash'|'fish'): string`; `generateAll(root: string): Promise<GeneratedFile[]>`; `checkDrift(root: string): Promise<string[]>` returning the paths whose on-disk content differs from `generateAll`.
- Produces: `extractSharedDocs(root: string): Promise<SharedModuleDoc[]>` with `SharedModuleDoc = {lang: 'ts'|'py'|'sh', module: string, symbols: {name: string, signature: string, doc: string}[]}`, reading TSDoc, Python docstrings and shdoc headers; `renderSharedDocs(mods: SharedModuleDoc[]): GeneratedFile[]` producing `docs/shared/index.md` and `docs/shared/<lang>/<module>.md`; `missingSharedDocs(mods): string[]` listing public symbols with an empty doc. `generateAll` includes the shared pages, and `checkDrift` fails on a missing doc.

- [ ] **Step 1: Write failing tests** against the `demo` fixture: `readme lists every option with its short form`, `catalog has one row per tool`, `zsh completion contains each long flag`, `checkDrift returns [] after generateAll is written`, `checkDrift names a file edited by hand`, `extractSharedDocs reads a TSDoc comment, a docstring and a shdoc header`, `missingSharedDocs names an undocumented public function`, `shared index lists every module once`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/gen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the renderers as pure functions; `generateAll` writes under `tools/<name>/README.md`, `tools/<name>/completions/`, `docs/catalog.md` and `docs/llms.txt`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): doc and completion generator with drift check`.

### Task 6: Unit templates and validation

**Files:** Create `shared/ts/src/gen/unit.ts`; Test `tests/unit/unit.test.ts`.

**Interfaces:**

- Consumes: `ToolManifest` (`unit`, `platforms`).
- Produces: `renderUnit(m: ToolManifest, kind: 'launchd'|'systemd', ctx: {binPath: string, home: string, label: string}): string`; `unitLabel(m): string` returning `dev.tbx.<name>`; `validateUnit(kind, content: string): Promise<{ok: boolean, skipped: boolean, message: string}>` that runs `plutil -lint` plus a key and type check on macOS and `systemd-analyze verify` on Linux, returning `skipped: true` when the validator is absent.

- [ ] **Step 1: Write failing tests** `launchd plist contains StartCalendarInterval for a schedule unit`, `systemd unit uses the absolute binPath`, `renders correctly when home contains spaces and non-ASCII characters`, `validateUnit reports skipped when the validator is missing`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/unit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** templates with XML escaping for plists and quoted `ExecStart` for systemd.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): launchd and systemd unit rendering`.

### Task 7: `tbx` CLI skeleton

**Files:** Create `tbx/src/index.ts`, `tbx/src/commands/{list,new,gen,help}.ts`, `tbx/templates/{ts,py,sh}/`; Test `tests/unit/tbx-commands.test.ts`.

**Interfaces:**

- Consumes: `loadManifest`, `assertNoCollisions`, `generateAll`, `checkDrift`.
- Produces: commands `tbx list [--json]`, `tbx help <tool> --json`, `tbx gen [--check]`, `tbx new <name> --lang ts|py|sh -y`, `tbx shared search <term> [--json]` and `tbx shared new <name> --lang ts|py|sh -y`. `tbx new` writes `tools/<name>/` from the language template (manifest, a failing example test, `src/`), refusing a name that collides. `tbx shared search` greps exported symbols and doc comments under `shared/`. `tbx shared new` writes `shared/<lang>/<module>` with a failing test and a doc-comment stub, refusing a module that already exists. `runTbx(argv: string[], env: {root: string}): Promise<{code: number, stdout: string}>` is exported for tests. The `tbx` CLI itself is built with `defineTool`.

- [ ] **Step 1: Write failing tests** `list --json returns every tool manifest name`, `gen --check exits 1 and names drifted files`, `new refuses a colliding name`, `new --lang sh creates a manifest and a failing bats test`, `shared search finds a helper by a word in its doc comment`, `shared new --lang py creates a module, a failing test and a doc stub`, `shared new refuses an existing module`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/tbx-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the commands using the `shared` modules.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tbx): list, help, gen and new commands`.

### Task 8: Build and install from a local index

**Files:** Create `tbx/src/commands/{build,install}.ts`, `tbx/src/state.ts`; Tests `tests/unit/install.test.ts`, `tests/e2e/install-interrupt.test.ts`.

**Interfaces:**

- Produces: `buildTool(root: string, name: string, outDir: string): Promise<{artifact: string, sha256: string, version: string}>` (ts bundled with esbuild, py as a zipapp with `shared/py` vendored, sh as one concatenated file with the generated parser prepended); `writeIndex(outDir, entries): Promise<string>` producing `index.json`; `installTool(opts: {name: string, index: string, home: string}): Promise<void>`; `uninstallTool(opts: {name: string, home: string}): Promise<void>`. State record shape: `{tools: Record<string, {version: string, installedAt: string}>}`.
- Install order: verify checksum, extract to a staging directory, move into `tools/<name>/<version>/`, swap the link atomically, write state atomically, all under a lock file.

- [ ] **Step 1: Write failing tests** `install rejects a tampered artifact (checksum mismatch)`, `install keeps the previous version linked when extraction fails`, `a second concurrent install waits for the lock`, `state file is never partially written (kill between steps)`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/install.test.ts tests/e2e/install-interrupt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** build, index, install and uninstall per the order above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tbx): build and install from a local release index`.

### Task 9: `tbx verify` done gate

**Files:** Create `tbx/src/commands/verify.ts`, `tbx/src/isolated-env.ts`; Test `tests/e2e/verify-demo.test.ts`.

**Interfaces:**

- Produces: `verifyTool(root: string, name: string): Promise<VerifyReport>` with `VerifyReport = {steps: {name: 'lint'|'unit'|'drift'|'contract'|'e2e'|'units', status: 'pass'|'fail'|'skipped', detail?: string}[], ok: boolean}`; `createIsolatedEnv(): Promise<{home: string, env: NodeJS.ProcessEnv, cleanup(): Promise<void>}>` setting HOME, `XDG_*` and a PATH of only stub directories. The e2e step builds the candidate, installs it through a fixture index, runs the `ContractCase` list, and runs interactive mode in a pty with a hard deadline of 30 seconds. `tbx verify --all` verifies every tool; a skipped unit validator is a warning locally and a failure when `CI=1`.

- [ ] **Step 1: Write failing tests** against the `demo` fixture tool: `verify passes for a correct tool`, `verify fails the drift step after a hand edit to README.md`, `verify fails the contract step when the parser rejects a documented flag`, `isolated env never exposes the real HOME`.
- [ ] **Step 2: Run** `pnpm vitest run tests/e2e/verify-demo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the step runner and the isolated environment.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tbx): verify gate`.

### Task 10: Migrate `transcribe` (shell)

**Files:** Create `tools/transcribe/{tool.toml,src/transcribe,tests/unit/transcribe.bats,tests/e2e/transcribe.e2e.bats}`; read `~/bin/transcribe` and `~/bin/tests/transcribe_test.sh` as the source of behavior.

**Interfaces:**

- Consumes: the generated shell parser, `tbx_die`, `tbx_result`.
- Produces: an installable `transcribe` binary with the same behavior as the current script, `-y` and `--json` support, and a `tool.toml` that passes `tbx verify transcribe`.

- [ ] **Step 1: Port the existing test** (`transcribe_test.sh`) into bats `transcribe.bats`, then add `--json prints one object with the transcript path` and `missing input file exits 2`. Stub the external transcription command on PATH.
- [ ] **Step 2: Run** `just test-sh`. Expected: FAIL (tool absent).
- [ ] **Step 3: Write `tool.toml` and `src/transcribe`.** Keep the current behavior; replace hand-rolled flag parsing with the generated prelude.
- [ ] **Step 4: Run** `tbx gen && tbx verify transcribe`. Expected: every step `pass`, `units` `skipped` (no unit).
- [ ] **Step 5: Commit** `feat(transcribe): migrate to tbx`. Leave the original `~/bin/transcribe` in place until Joe switches to the installed binary.

### Task 11: Cross-tool e2e and CI

**Files:** Create `tests/e2e/install-all.test.ts`, `tests/e2e/list-and-help.test.ts`, `.github/workflows/ci.yml`.

**Interfaces:**

- Consumes: `tbx build`, `tbx install`, `tbx list`, `tbx help`, `verifyTool`.

- [ ] **Step 1: Write failing tests** `install all then tbx list shows every tool at its built version` and `tbx help <tool> --json matches that tool's tool.toml for every tool`.
- [ ] **Step 2: Run** `pnpm vitest run tests/e2e`. Expected: FAIL.
- [ ] **Step 3: Add the CI workflow.** Matrix: `macos-latest` and `ubuntu-latest`; steps: install prerequisites, `just lint`, `just test`, `tbx verify --all` with `CI=1`.
- [ ] **Step 4: Run** `just verify-all`. Expected: PASS locally; open the CI run and confirm both matrix legs are green.
- [ ] **Step 5: Commit** `test: cross-tool e2e and CI matrix`.
