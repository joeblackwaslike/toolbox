# tbx release pipeline

Plan 2a of the tbx series. It covers versioning, building, publishing and installing. The agent plugins, the workflow skills and the root README are plan 2b and are not in this document.

Parent spec: [2026-10-29-tbx-design.md](2026-10-29-tbx-design.md).

## Intent

A fresh macOS or Linux machine runs one `curl … | sh` line and gets `tbx` plus any named tools, taken from real GitHub Releases. Every tool has its own version, tag and changelog. `tbx-cli` is also published to npm, PyPI and a Homebrew tap, and ships `.deb` and `.rpm` files. Joe wants releases to be automatic once a pull request merges.

## Goals

- One version, one tag (`<tool>-vX.Y.Z`) and one `CHANGELOG.md` per tool, and the same for `tbx-cli`.
- Merging a release PR is the only manual step. Building, attaching assets and publishing follow from it.
- A change under `shared/` or to the generator's shipped output releases every affected tool as a patch bump, with a hand override.
- `tbx install` and `tbx update` read the release index from GitHub Releases, and still read a local index for tests.
- Released versions are never rebuilt or overwritten.

## Non-goals

- Linux musl, Windows, and signing or notarizing the macOS binaries.
- The agent plugins, workflow skills and README (plan 2b).
- Publishing to homebrew-core, apt or dnf repositories. The `.deb` and `.rpm` files are release assets only.
- Replacing release-please with a custom release script.

## Anti-goals

- A release that publishes some channels and silently skips others.
- A tool's version stored in two places that can disagree.
- Tokens in the repo, or a long-lived token with wider scope than it needs.

## Constraints

- GitHub Actions only. Third-party actions are pinned by SHA, as in `ci.yml`.
- Tags created with the default workflow token do not trigger other workflows, so everything after tagging runs in the same workflow.
- CI runs on arm64 runners only. The x64 binaries are smoke-tested in the release pipeline.
- Tool versions live in `tools/<name>/tool.toml` (`version = "0.1.0"`). Commits are Conventional Commits, enforced by commitlint.

## Approaches

1. **release-please decides, and the same workflow builds and publishes.** One workflow, jobs gated on release-please's per-component outputs. Chosen.
2. **release-please only tags, and a second workflow builds on tag push.** Cleaner files, but it needs a GitHub App or PAT so tags trigger the second workflow. Rejected.
3. **A custom release script.** The `shared/` rule would be native, but changelogs, release PRs and manifest handling would be reimplemented. Rejected.

## Decisions Joe made

1. Per-tool tags, versions and changelogs, from day one.
2. A change under `shared/` releases each affected tool automatically as a patch bump. Joe can override the bump by hand when merging.
3. The Homebrew tap is a general repo, `joeblackwaslike/homebrew-tap`, so the install command is `brew install joeblackwaslike/tap/tbx-cli`.
4. Approach 1 above.

## Design

### Versioning

`release-please-config.json` and `.release-please-manifest.json` at the repo root, manifest mode, `separate-pull-requests: true`. One package per entry: each `tools/<name>` and `tbx`. `release-type: simple`. Component names are the tool names, with `tbx-cli` for the `tbx/` package. Tags are `<component>-v<version>`.

The version is read from `tool.toml`. Each package lists `tool.toml` under `extra-files` with a `toml` updater so release-please writes the bump there. No second copy of the version exists.

### The shared stamp

Each tool directory holds a generated `.shared-stamp` file with a hash of the exact `shared/` files bundled into that tool and the generator version. A CI check regenerates stamps, and a `stamp` job on pushes to `main` commits any that changed as `fix(<tool>): bundle updated shared`. The commit touches the tool's folder, so release-please opens a patch release for it. The same job covers generator changes that alter shipped output. A reviewer overrides the bump by adding a `Release-As:` footer to the release PR, which release-please supports natively.

CI fails on a pull request when a stamp is out of date, so drift is caught before merge. The stamp job on `main` is a backstop for direct pushes.

### The release workflow

`.github/workflows/release.yml` runs on pushes to `main`.

1. `release-please` runs and exposes `releases_created` and per-path outputs.
2. For each created tool release, a `tool-release` job builds that tool's tarball with `tbx build`, uploads it and its checksum to the release, and regenerates the release index.
3. If `tbx-cli` was released, a `cli-release` job builds the four binaries with `bun build --compile --target …` from one Linux runner, using the Bun version in `.bun-version`. A matrix of `macos-15-intel` and `ubuntu-24.04` smoke-tests the x64 binaries (`tbx --version`, `tbx list`). The arm64 targets are smoke-tested on the arm64 runners. Only then does it upload the binaries, `checksums.txt`, and the `.deb` and `.rpm` files.
4. After a smoke pass, publish jobs run in order: npm, PyPI, then the Homebrew formula. Each publish is idempotent, so a rerun after a partial failure skips channels that already have the version.

Assets are uploaded with `--clobber` disabled, so an existing asset is never replaced.

### The release index

The index is a single `index.json` asset on a fixed `index` release, updated by each tool release (read, merge, write atomically, with a concurrency group so two jobs cannot interleave). It keeps the existing shape `{ "tools": [{ name, version, artifact, sha256 }] }`, with `artifact` becoming an absolute asset URL when published. `tbx install --index` still accepts a local path and file URLs for tests.

### `tbx install` and `update` from GitHub

The default index becomes the GitHub URL above. Downloads are checksum-verified, extracted to staging and swapped atomically, as the parent spec already requires. `tbx update` compares installed versions with the index. Nothing about the local-index code path changes.

### The installer

`install.sh` at the repo root, served from `raw.githubusercontent.com` at a release tag. It detects OS, architecture and libc, exits with a clear message on musl, downloads the matching `tbx` binary from the latest `tbx-cli` release, verifies it against `checksums.txt`, installs it to `~/.local/share/tbx/bin`, adds that to PATH for the user's shell, and runs `tbx install` for any tool names passed as arguments. It needs only `curl`, `sh`, `uname` and `shasum` or `sha256sum`.

### Packages

- **npm `tbx-cli`**: a small launcher. On first run it downloads the pinned binary for its own version, verifies it against a checksum table shipped in the package, caches it and runs it. `npx tbx-cli install` works.
- **PyPI `tbx-cli`**: the same idea, a thin shim pinned to the exact binary for its version, with the checksum table in the wheel. `uvx --from tbx-cli tbx install` works.
- **Homebrew**: `Formula/tbx-cli.rb` in `joeblackwaslike/homebrew-tap`, generated by the workflow with the four binary URLs and checksums, and pushed with a token limited to that repo.
- **`.deb` and `.rpm`**: built with `nfpm` from the Linux binaries and attached to the `tbx-cli` release.

### Tokens and permissions

- npm: Trusted Publisher once the first version exists; until then `NPM_TOKEN`.
- PyPI: Trusted Publisher, already set up.
- Homebrew tap: a fine-grained token with contents write on `homebrew-tap` only, stored as `HOMEBREW_TAP_TOKEN`.
- Everything else uses `GITHUB_TOKEN` with `contents: write` only in the jobs that upload assets.

### Failure handling

Release-please runs before anything is built, so a build failure leaves a tag with no assets. The workflow can be re-run from the Actions tab, and every upload and publish step skips work already done. A release is only complete when `index.json` lists it; `tbx install` never sees a half-published version.

## Calls I made (not agreed with Joe, check these)

- `release-type: simple` with `tool.toml` as the version source, over per-language release types.
- The stamp-file mechanism for the `shared/` rule.
- A single `index.json` on a fixed `index` release, instead of an index per tool release.
- `nfpm` for `.deb` and `.rpm`.
- Launcher-style npm and PyPI packages that download the binary on first run, instead of bundling all four binaries in the package.
- `macos-15-intel` for the x64 macOS smoke test.
- `bun build --compile` cross-compiling all four targets from one runner.

## Unverified

- That `macos-15-intel` runners are still available on GitHub-hosted plans.
- That `bun build --compile --target` produces working binaries for all four targets from a Linux runner. Check before building the workflow.
- That release-please's `toml` updater handles `tool.toml` as written, including the `[[args]]` tables.
- That a `Release-As:` footer on a squash-merge commit is honored for a component release PR.
- Whether the npm Trusted Publisher can be configured for a package whose first real version comes from the workflow.

## Human-only steps

- Creating the fine-grained `HOMEBREW_TAP_TOKEN` and adding it as a secret needs Joe's login. Claude creates the `joeblackwaslike/homebrew-tap` repo itself.
- Switching npm to a Trusted Publisher and deleting `NPM_TOKEN`.
- Rotating the token in `~/bin/glm-claude`.

## Left to the builder

Exact workflow job structure and caching, the stamp hash algorithm, the launcher packages' checksum-table format, the `nfpm` config, and the smoke-test commands.
