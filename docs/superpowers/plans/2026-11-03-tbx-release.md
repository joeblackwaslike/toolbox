# tbx release pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-tool versioned releases of tbx and its tools, built, signed, published and installable from GitHub Releases with one `curl | sh` line.

**Architecture:** One `release.yml` workflow runs `stamp` then `release-please`, builds per-tool tarballs and the four `tbx` binaries, signs and notarizes the macOS ones, uploads assets, commits the release index to a `release-index` branch, and publishes npm, PyPI, Homebrew, `.deb` and `.rpm`. `tbx` gains remote install, `update` and `stamp`.

**Tech Stack:** TypeScript on Bun (`tbx/`), vitest, bats-core and shellcheck for shell, GitHub Actions, release-please (manifest mode), nfpm, `codesign` and `notarytool`.

**Spec:** [docs/superpowers/specs/2026-11-02-tbx-release-design.md](../specs/2026-11-02-tbx-release-design.md)

## Global Constraints

- Tags are `<component>-v<version>`; `tbx-cli` is the component for `tbx/`, its version is in `tbx/version.txt`; tools keep their version in `tools/<name>/tool.toml` (`version = "0.1.0"`).
- Third-party actions are pinned by SHA with a version comment, as in `.github/workflows/ci.yml`. Bun version comes from `.bun-version`; Node from `.nvmrc`.
- Permissions are set per job, never workflow-wide (spec "Tokens and permissions").
- Released assets are never overwritten; reruns reuse existing assets and fail on a mismatch.
- `checksums.txt` is uploaded last and marks a `tbx-cli` release complete.
- Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, glibc only. Musl exits with a clear message.
- JS/TS uses pnpm and Bun, never npm/npx/yarn/tsx (the launcher package's published code may use plain Node APIs).
- No secrets in the repo. Workflow secrets: `NPM_TOKEN`, `HOMEBREW_TAP_TOKEN`, `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `NOTARY_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID`.
- Conventional Commits. Spec, plan and code land on `feat/release-pipeline` in one PR.

## Review Focus

- Two tool releases land in the same minute: the index branch push is rejected once and must retry from a fresh fetch (Task 5).
- A tarball upload succeeds but the index commit fails: rerun must add the entry without re-uploading (Task 5, Task 10).
- A `tbx-cli` release with no `checksums.txt` exists: `install.sh` skips it for the previous release (Task 7).
- `tbx install` with a remote index whose tarball checksum is wrong: nothing is extracted or linked (Task 1).
- Shared change that touches only files a tool does not bundle: that tool is not re-stamped (Task 3).

---

### Task 1: Remote index and artifact fetching in `tbx install`

**Files:**
- Create: `tbx/src/remote.ts`, `tests/unit/remote.test.ts`
- Modify: `tbx/src/commands/install.ts` (`artifactPath`, `findEntry`, `defaultIndex`), `tbx/src/commands/build.ts` (`IndexEntry` doc)
- Test: `tests/unit/remote.test.ts`, `tests/e2e/install-remote.test.ts`

**Interfaces:**
- Produces: `fetchIndex(source: string): Promise<IndexEntry[]>` and `fetchArtifact(entry: IndexEntry, indexSource: string): Promise<Buffer>` in `tbx/src/remote.ts`. `source` is a local path, a `file:` URL or an `https:` URL; `entry.artifact` may be relative (local) or an absolute `https:` URL. `fetchArtifact` throws `ToolError` with `ExitCode.config` when the SHA-256 of the bytes differs from `entry.sha256`.
- Consumes: `readIndex`, `IndexEntry` from `build.ts`; `sha256` from `archive.ts`; `ToolError`, `ExitCode` as used in `install.ts`.

- [ ] **Step 1: Write failing tests** in `tests/unit/remote.test.ts`, using `node:http` on port 0: `fetchIndex` returns entries from an http URL and from a local path; `fetchArtifact` returns bytes for an absolute URL entry; a wrong `sha256` rejects with `ExitCode.config` and the message names the tool; a non-2xx status rejects; `http:` (not `https:`) is rejected unless the host is `127.0.0.1`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/remote.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `tbx/src/remote.ts`** with the global `fetch`; reuse the zod `indexSchema` by exporting it from `build.ts`. Local paths keep today's "artifact must stay inside the index directory" rule; absolute `https:` artifact URLs are allowed only when the index itself is remote.
- [ ] **Step 4: Wire `installTool`** to call `fetchIndex`/`fetchArtifact` and stage the bytes exactly as it stages local tarballs today; `defaultIndex` returns `https://raw.githubusercontent.com/joeblackwaslike/toolbox/release-index/index.json`, overridable with `--index` and `TBX_INDEX`.
- [ ] **Step 5: Write `tests/e2e/install-remote.test.ts`:** build `transcribe` with `buildTool`, serve `index.json` and the tarball from a local server, run `tbx install transcribe --index http://127.0.0.1:<port>/index.json` with an isolated HOME, assert the tool is linked and `installed.json` records the version; then corrupt the served tarball and assert install fails with nothing linked.
- [ ] **Step 6: Run** `pnpm vitest run tests/unit/remote.test.ts tests/e2e/install-remote.test.ts && pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(tbx): install tools from a remote release index`.

### Task 2: `tbx update`

**Files:**
- Create: `tbx/src/commands/update.ts`, `tests/unit/update.test.ts`
- Modify: `tbx/src/index.ts` (register `update [name]`)

**Interfaces:**
- Produces: `update(ctx: TbxContext, options: { name?: string; index?: string }): Promise<UpdateResult[]>` where `UpdateResult = { name: string; from: string; to: string | null }` (`to` is null when already current). Uses semver comparison.
- Consumes: `readState`, `tbxPaths` from `state.ts`; `fetchIndex` (Task 1); `installTool` from `install.ts`.

- [ ] **Step 1: Write failing tests:** with state recording `transcribe@0.1.0` and an index offering `0.2.0`, `update` installs `0.2.0` and returns `{from:'0.1.0', to:'0.2.0'}`; index offering `0.1.0` returns `to: null` and installs nothing; index offering `0.0.9` (older) installs nothing; `update unknown` exits with `ExitCode.config`; with no name, every installed tool is considered.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/update.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `update`** and register the command with `--json` output like `list`.
- [ ] **Step 4: Run** the new tests plus `pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tbx): add update command`.

### Task 3: Shared stamp

**Files:**
- Create: `tbx/src/commands/stamp.ts`, `tests/unit/stamp.test.ts`, `tools/*/.shared-stamp`, `tbx/.shared-stamp`
- Modify: `tbx/src/index.ts` (register `stamp`)

**Interfaces:**
- Produces: `computeStamp(root: string, component: string): Promise<string>`: SHA-256 over the sorted relative paths and contents of exactly the `shared/` files bundled into that component plus the generator version string. `stampAll(root: string, write: boolean): Promise<{ component: string; changed: boolean }[]>`. CLI: `tbx stamp --write` rewrites changed stamps and prints changed component names one per line; `tbx stamp --check` exits non-zero if any would change.
- Consumes: the existing bundling logic in `build.ts` that decides which shared files a tool pulls in (reuse it; do not recompute dependencies a second way).

- [ ] **Step 1: Write failing tests** on a temp fixture repo: stamp is stable across runs; editing a shared file bundled by tool A changes A's stamp and not B's; editing a shared file only B bundles does not touch A; changing the generator version string changes every stamp; `--check` exits non-zero on a stale stamp and zero when current.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/stamp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `computeStamp`/`stampAll` and the CLI flags; generate the initial `.shared-stamp` files.
- [ ] **Step 4: Run** tests, typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tbx): add shared stamp command`.

### Task 4: release-please configuration and `tbx` version source

**Files:**
- Create: `release-please-config.json`, `.release-please-manifest.json`, `tbx/version.txt`, `tests/unit/release-config.test.ts`
- Modify: `tbx/src/index.ts` (`--version` reads the embedded version)

**Interfaces:**
- Produces: config with `separate-pull-requests: true`, `bootstrap-sha` set to the commit `git rev-parse origin/main` at the time of the PR, packages `tbx` (component `tbx-cli`, `release-type: simple`, `version.txt`) and `tools/<name>` for every directory under `tools/` (component = name, `extra-files: [{ type: "toml", path: "tool.toml", jsonpath: "$.version" }]`), manifest versions `tbx: 0.1.0` and each tool's current `tool.toml` version. `tbx --version` prints the contents of `version.txt` (embedded at compile time, read from disk under `bun run`).

- [ ] **Step 1: Write failing tests:** every `tools/*/tool.toml` has a config package and a manifest entry whose version equals its `tool.toml` version; `tbx` entry exists; component names are unique; `separate-pull-requests` is true; `tbx --version` equals `version.txt`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/release-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Create the config, manifest and `version.txt` (`0.1.0`), and the `--version` option.**
- [ ] **Step 4: Verify the toml updater** against the real release-please library: run `bunx release-please@<pinned> release-pr --dry-run --repo-url=joeblackwaslike/toolbox --token=$(gh auth token)` from the worktree and confirm it proposes a `tool.toml` version edit for a tool with a `feat` commit. Record the pinned version in the config test as a comment-free constant.
- [ ] **Step 5: Run** tests, typecheck and lint. Expected: PASS.
- [ ] **Step 6: Commit** `feat: configure release-please per tool`.

### Task 5: Index branch publisher and release workflow skeleton

**Files:**
- Create: `scripts/publish-index.sh`, `tests/shell/publish-index.bats`, `.github/workflows/release.yml`

**Interfaces:**
- Produces: `scripts/publish-index.sh <name> <version> <artifact-url> <sha256>` merges one entry into `index.json` on the `release-index` branch (created as an orphan if missing), commits, pushes, and on a non-fast-forward rejection fetches and retries up to 5 times. Idempotent: an entry already present with the same sha256 is a no-op; a different sha256 for the same name and version fails. `TBX_INDEX_REMOTE` overrides the git remote for tests.
- Workflow jobs so far: `resolve` (dispatch `tags` input or release-please outputs → release matrix with tag and SHA), `stamp`, `release-please`, `tool-release`, `index`. Concurrency group `release`, `cancel-in-progress: false`. Per-job permissions per the spec.

- [ ] **Step 1: Write failing bats tests** against a local bare git remote: first publish creates the branch and file; second entry appends; same entry twice is a no-op; same name and version with a different sha256 fails; a simulated concurrent push (second clone pushes between fetch and push) is retried and both entries end up present.
- [ ] **Step 2: Run** `bats tests/shell/publish-index.bats`. Expected: FAIL.
- [ ] **Step 3: Implement `publish-index.sh`** with `jq` for JSON; entries sorted by name then version; lint with shellcheck/shfmt.
- [ ] **Step 4: Write `release.yml`** with the jobs above. `tool-release` builds with `tbx build` at the tag SHA, uploads tarball and checksum with `gh release upload` (no `--clobber`; on "already exists" it downloads the asset and compares sha256, failing on mismatch), then `index` runs `publish-index.sh`. Every job checks out the matrix SHA.
- [ ] **Step 5: Verify** with `actionlint .github/workflows/release.yml` (install via `brew install actionlint` if missing). Expected: no findings.
- [ ] **Step 6: Commit** `feat(ci): add release workflow with per-tool releases and index branch`.

### Task 6: Compile the `tbx` binaries

**Files:**
- Create: `scripts/compile-tbx.sh`, `tests/shell/compile-tbx.bats`
- Modify: `justfile` (`compile` recipe)

**Interfaces:**
- Produces: `scripts/compile-tbx.sh <outdir>` writes `tbx-darwin-arm64`, `tbx-darwin-x64`, `tbx-linux-arm64`, `tbx-linux-x64` using `bun build --compile --target=bun-<os>-<arch>` and the pinned Bun. Each binary prints `tbx --version` equal to `tbx/version.txt` when it matches the host target.

- [ ] **Step 1: Verify the spec's open question first:** on this macOS arm64 machine, cross-compile all four targets and run the host-matching one. If any target fails to compile, stop and report which; the plan then needs a runner matrix instead of one Linux runner.
- [ ] **Step 2: Write a failing bats test:** run the script into a temp dir, assert four files exist, the host binary runs `--version` and `list` with exit 0.
- [ ] **Step 3: Implement the script; add the justfile recipe.**
- [ ] **Step 4: Run** `bats tests/shell/compile-tbx.bats`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: compile tbx to four single-file binaries`.

### Task 7: Installer

**Files:**
- Create: `install.sh`, `tests/shell/install-sh.bats`, `tests/fixtures/releases/`

**Interfaces:**
- Produces: `install.sh [tool...]`. Env overrides for tests: `TBX_RELEASES_API` (default `https://api.github.com/repos/joeblackwaslike/toolbox/releases?per_page=100`), `TBX_INSTALL_DIR` (default `~/.local/share/tbx/bin`), `TBX_UNAME_S`, `TBX_UNAME_M`, `TBX_LIBC` (`glibc` or `musl`). Picks the newest release whose tag starts with `tbx-cli-v` and that has a `checksums.txt` asset; downloads the matching binary, verifies it, installs it executable, updates PATH in the shell profile once, then runs `tbx install <tool...>` if tools were named. Exits non-zero with a clear message on musl, an unsupported OS/arch, a checksum mismatch, or no complete release.

- [ ] **Step 1: Write failing bats tests** with a local `python3 -m http.server`-free static fixture (use `nc`-less approach: `file://` URLs in the fixture releases JSON): picks the newest complete release and skips a newer one without `checksums.txt`; checksum mismatch aborts and leaves no binary; `TBX_LIBC=musl` exits with the musl message; unsupported arch exits; running twice does not duplicate the PATH line.
- [ ] **Step 2: Run** `bats tests/shell/install-sh.bats`. Expected: FAIL.
- [ ] **Step 3: Implement `install.sh`** in POSIX sh; requires only `curl`, `sh`, `uname`, `shasum` or `sha256sum`; parse the releases JSON without `jq` (sed/awk), since `jq` is not guaranteed on a fresh machine.
- [ ] **Step 4: Run** bats, shellcheck, shfmt. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add curl installer`.

### Task 8: Launcher packages, Homebrew template, nfpm

**Files:**
- Create: `packaging/npm/` (launcher `package.json` template, `bin/tbx.js`), `packaging/pypi/` (`pyproject.toml` template, `src/tbx_cli/__main__.py`), `packaging/homebrew/tbx-cli.rb.tmpl`, `packaging/nfpm.yaml.tmpl`, `scripts/render-packaging.sh`, `tests/shell/render-packaging.bats`, `tests/unit/launcher.test.ts`
- Delete in Task 11, not here: `packaging/npm-placeholder/`, `packaging/pypi-placeholder/`, `.github/workflows/publish.yml`

**Interfaces:**
- Produces: `scripts/render-packaging.sh <version> <checksums.txt> <outdir>` renders `outdir/npm/package.json` with the version and an embedded checksum table, `outdir/pypi/pyproject.toml` plus the same table, `outdir/homebrew/tbx-cli.rb` with the four release URLs and checksums, and `outdir/nfpm-<arch>.yaml`. The launchers download `tbx-<os>-<arch>` from `https://github.com/joeblackwaslike/toolbox/releases/download/tbx-cli-v<version>/`, verify against the embedded table, cache under the XDG cache dir, and exec it with the original arguments (override base URL with `TBX_DOWNLOAD_BASE` for tests).

- [ ] **Step 1: Write failing tests:** bats checks that rendered output contains the version, all four checksums, and no unreplaced `{{` markers; vitest runs the npm launcher against a local server: first run downloads and execs, a tampered binary is rejected without being executed, a second run uses the cache.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement the templates, the render script and both launchers.**
- [ ] **Step 4: Validate outputs:** `npm pack --dry-run` on the rendered npm dir; `uv build` on the rendered pypi dir with `hatchling==1.27.0` pinned (metadata version 2.4); `brew audit --strict --formula` on the rendered formula if `brew` is available; `nfpm package` for both arches.
- [ ] **Step 5: Run** all tests, shellcheck, shfmt. Expected: PASS.
- [ ] **Step 6: Commit** `feat: add launcher packages, Homebrew template and nfpm config`.

### Task 9: macOS signing and notarization

**Files:**
- Create: `scripts/sign-macos.sh`, `.github/workflows/sign-spike.yml` (deleted in Task 11)

**Interfaces:**
- Produces: `scripts/sign-macos.sh <binary>...` creates a temporary keychain from `MACOS_CERT_P12`/`MACOS_CERT_PASSWORD`, signs with the Developer ID Application identity, hardened runtime and an entitlements plist (`allow-jit`, `allow-unsigned-executable-memory`), zips the signed binaries, runs `xcrun notarytool submit --wait` with the three `NOTARY_*` secrets, requires `Accepted`, and deletes the keychain (also on failure, via `trap`).

- [ ] **Step 1: Run the spike:** commit the script and a `workflow_dispatch` spike workflow that compiles one darwin binary on `macos-15`, signs and notarizes it, then runs it. Dispatch with `gh workflow run sign-spike.yml --ref feat/release-pipeline` and read the logs with `gh run view --log`.
- [ ] **Step 2: If notarization rejects or the signed binary fails to start,** adjust the entitlements list from the notary log (`xcrun notarytool log`), and repeat. Record the final entitlements in the script.
- [ ] **Step 3: Verify** the spike run ends with the signed binary printing `--version` and `codesign --verify --strict --verbose=2` plus `spctl --assess --type execute` passing.
- [ ] **Step 4: Commit** `feat: sign and notarize macOS binaries`.

### Task 10: Complete the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7, 8, 9. Adds jobs `cli-release` (compile on Linux), `sign-macos` (macOS runner, uses `sign-macos.sh`), `smoke` (matrix `macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`), `upload` (binaries, `.deb`/`.rpm` via nfpm, then `checksums.txt` last), `publish-npm` (`NPM_TOKEN`, `--provenance`), `publish-pypi` (trusted publishing, `environment: pypi`), `publish-brew` (clones `joeblackwaslike/homebrew-tap` with `HOMEBREW_TAP_TOKEN`, skips when the formula already names the version). Also `stamp` runs `tbx stamp --write` and pushes one `fix(<component>): bundle updated shared` commit per changed component, before `release-please`.

- [ ] **Step 1: Add the jobs** with per-job permissions from the spec; each job checks out the matrix SHA; upload and publish steps skip existing work.
- [ ] **Step 2: Run** `actionlint .github/workflows/release.yml`. Expected: no findings.
- [ ] **Step 3: Repository setup** (no code): `gh api -X PUT repos/joeblackwaslike/toolbox/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`; `gh repo create joeblackwaslike/homebrew-tap --public --add-readme`, then push an empty `Formula/` directory.
- [ ] **Step 4: Commit** `feat(ci): complete release workflow`.

### Task 11: Clean up placeholders, docs, and first release

**Files:**
- Delete: `packaging/npm-placeholder/`, `packaging/pypi-placeholder/`, `.github/workflows/publish.yml`, `.github/workflows/sign-spike.yml`
- Modify: `README.md` install section is plan 2b; here only `docs/contributing.md` (release process, stamp, recovery dispatch) and `AGENTS.md` (publishing section: releases run from `release.yml`)

- [ ] **Step 1: Delete the placeholders and spike; update the two docs.**
- [ ] **Step 2: Run** `pnpm test && pnpm lint && pnpm typecheck && bats tests/shell` and `gates/verify.sh` if present. Expected: all pass.
- [ ] **Step 3: Run** `/no-mistakes` for the whole branch (push, PR, CI), then merge.
- [ ] **Step 4: Verify the first release end to end:** after merge, confirm release-please opens release PRs for `tbx-cli` and each tool with the `bootstrap-sha` limiting history; merge the `tbx-cli` PR; watch `gh run watch` on `release.yml`; then confirm on a clean shell that `curl -fsSL https://raw.githubusercontent.com/joeblackwaslike/toolbox/main/install.sh | sh -s -- transcribe` installs `tbx` and `transcribe`, `npm view tbx-cli version` and PyPI show the release, and `brew install joeblackwaslike/tap/tbx-cli` works. Missing `HOMEBREW_TAP_TOKEN` is the only expected human blocker; report it by name.
