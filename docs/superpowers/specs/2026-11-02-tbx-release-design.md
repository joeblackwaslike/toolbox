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
- The macOS binaries are signed with Joe's Developer ID certificate and notarized, so a binary downloaded from the Releases page in a browser runs without a Gatekeeper warning.

## Non-goals

- Linux musl and Windows.
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

`release-please-config.json` and `.release-please-manifest.json` at the repo root, manifest mode, `separate-pull-requests: true`. One package per entry: each `tools/<name>` and `tbx`. `release-type: simple`. Component names are the tool names, with `tbx-cli` for the `tbx/` package. Tags are `<component>-v<version>`. The manifest sets `bootstrap-sha` to the `main` commit at the time this lands, so the first release PRs contain only new commits and not the whole repo history.

For each tool, the version lives in `tools/<name>/tool.toml`, and release-please writes the bump there through an `extra-files` entry with a `toml` updater. For `tbx-cli`, the package path is `tbx/` and the version lives in a new `tbx/version.txt` (`release-type: simple` writes it natively). Commits that touch only `tbx/` release `tbx-cli`. The npm and PyPI manifests carry no version of their own: the workflow generates them from the released version at publish time, and the hardcoded 0.0.1 placeholders in `packaging/` are deleted along with `publish.yml` when the first real release lands. `tbx-cli` starts at `0.1.0` and each existing tool starts at its current `tool.toml` version. The manifest lists every package at `0.0.0`, and each package's `initial-version` in the config holds its starting version. Any other manifest version counts as already released, and release-please would bump past it to 0.1.1 or 0.2.0.

### The shared stamp

Each tool directory, and `tbx/`, holds a generated `.shared-stamp` file with a hash of the exact `shared/` files bundled into it and the generator version. The `stamp` job runs first in `release.yml` on every push to `main`. It regenerates the stamps and, if any changed, pushes one commit per affected tool as `fix(<tool>): bundle updated shared`. Each commit touches only that tool's `.shared-stamp`, so release-please attributes it to the tool and opens a patch release. The job changes nothing when the stamps are current, so its own push cannot loop. Generator changes that alter shipped output go through the same job. A person overrides the bump by adding a `Release-As:` footer to a commit, which release-please supports natively.

The `stamp` job pushes with `GITHUB_TOKEN`, which cannot trigger other workflows, so `release-please` runs in the same workflow with `needs: stamp` and reads the new commits from the API. `main` has no branch protection today, so a direct push works. If protection is added later, the job has to open a pull request instead, and the spec needs revisiting.

The post-merge `stamp` job is the only writer of stamps. Pull request CI does not check stamp freshness, because a shared-only pull request could never pass such a check and the stamp commit has to be a `fix` commit made after merge. Pull request CI instead prints which tools a change affects, as information only. Stamps exist only to trigger releases: tool tarballs are built from the checkout, so a stale stamp cannot ship wrong code.

### The release workflow

`.github/workflows/release.yml` runs on pushes to `main`.

1. `release-please` runs and exposes `releases_created` and per-path outputs. Every later job checks out the tag release-please created, not the branch head, so a push that lands mid-run cannot change what gets built.
2. For each created tool release, a `tool-release` job builds that tool's tarball with `tbx build`, uploads it and its checksum to the release, and then the `index` job adds its entry to the release index.
3. If `tbx-cli` was released, a `cli-build` job builds the four binaries (darwin-arm64, darwin-x64, linux-arm64, linux-x64, all glibc) with `bun build --compile --target …` from one Linux runner, using the Bun version in `.bun-version`.
4. A `sign-macos` job on a macOS runner signs both darwin binaries with the Developer ID Application certificate (hardened runtime, with the entitlements Bun's JIT needs), zips the signed binaries, submits the zip to Apple with `notarytool submit --wait`, and requires the status `Accepted`. Apple does not accept a bare Mach-O file as a submission, only a zip, pkg or dmg. The uploaded binaries are the signed files themselves, not extracted copies. A bare binary cannot be stapled, so Gatekeeper checks the notarization ticket online on first run. 
5. A `smoke` matrix runs the final bytes: `macos-15-intel` and `ubuntu-24.04` for x64, and the arm64 runners for arm64, each running `tbx --version` and `tbx list`. Only after every leg passes does the workflow upload the binaries and the `.deb` and `.rpm` files for both Linux architectures, and then, last, `checksums.txt`. `checksums.txt` is the completeness marker: a `tbx-cli` release without it is incomplete and nothing downstream may use it.
6. After the upload, npm and PyPI publish in parallel, since they are independent, and the Homebrew formula follows once both succeed. Each publish is idempotent, so a rerun after a partial failure skips channels that already have the version.

Assets are uploaded with `--clobber` disabled, so an existing asset is never replaced. A rerun after a partial failure downloads the assets already on the release and reuses them instead of rebuilding or re-signing, because a rebuilt binary has different bytes than the uploaded one. If a rebuilt asset differs from an existing one, the job fails and does not overwrite it. A single concurrency group, `release`, with `cancel-in-progress: false`, covers the whole workflow, so one run executes at a time. GitHub keeps only one pending run per group and replaces older pending runs with the newest. That is safe here: `release-please` and `stamp` always work from the latest `main` and find merged release PRs by their labels, so a dropped pending run loses nothing. Release-please creates non-draft releases, and `make_latest` is false for tool releases so they never take GitHub's repo-wide "latest" label.

### The release index

GitHub release assets cannot be replaced atomically, so the index does not live in a release. It is `index.json` on an orphan branch named `release-index`, created by the workflow the first time it is missing. An `index` job runs after the tool tarballs upload. It checks out that branch, merges in the new entries, commits, and pushes, retrying from a fresh fetch if the push is rejected as non-fast-forward. A git commit is atomic, so readers see either the old index or the new one. Clients read it from `raw.githubusercontent.com`, which can lag a push by a few minutes. The file keeps the existing shape `{ "tools": [{ name, version, artifact, sha256 }] }`, with `artifact` becoming an absolute release-asset URL when published, and an entry is added only after its tarball is uploaded. `tbx install --index` still accepts a local path and file URLs for tests.

### `tbx install` and `update` from GitHub

This is new code, not a change of default. Today `tbx install` only reads artifacts from a local directory and rejects any artifact outside the index directory. This work adds: fetching `index.json` and tool tarballs over HTTPS, checksum verification before extraction, and a new `tbx update` command that compares installed versions with the index and installs newer ones. The default index becomes the GitHub URL above. The local-index path stays, because the e2e tests and `tbx verify` use it. `tbx doctor` is not part of this work.

### The installer

`install.sh` at the repo root, served from `raw.githubusercontent.com` on `main`. It detects OS, architecture and libc, exits with a clear message on musl, downloads the matching `tbx` binary from the newest release whose tag starts with `tbx-cli-v` and that has a `checksums.txt` asset (found with the unauthenticated releases API, so an incomplete release is skipped in favor of the previous one), verifies it against `checksums.txt`, installs it to `~/.local/share/tbx/bin`, adds that to PATH for the user's shell, and runs `tbx install` for any tool names passed as arguments. It needs only `curl`, `sh`, `uname` and `shasum` or `sha256sum`.

### Packages

- **npm `tbx-cli`**: a small launcher. On first run it downloads the pinned binary for its own version, verifies it against a checksum table shipped in the package, caches it and runs it. `npx tbx-cli install` works.
- **PyPI `tbx-cli`**: the same idea, a thin shim pinned to the exact binary for its version, with the checksum table in the wheel. `uvx --from tbx-cli tbx install` works.
- **Homebrew**: `Formula/tbx-cli.rb` in `joeblackwaslike/homebrew-tap`, rendered by the workflow from a template in this repo (`packaging/homebrew/tbx-cli.rb.tmpl`) with the binary URLs and checksums, and pushed with a token limited to that repo. The step is skipped when the formula already names the released version.
- **`.deb` and `.rpm`**: built with `nfpm` from the Linux binaries and attached to the `tbx-cli` release.

### Tokens and permissions

- npm: `NPM_TOKEN` for the first real release. Joe switches to a Trusted Publisher after that release, since npm can only configure one for an existing package, and the workflow then drops the token.
- PyPI: Trusted Publisher bound to this repository, the workflow `release.yml` and the environment `pypi`. The publisher set up for the placeholders is bound to `publish.yml`, so Joe adds one for `release.yml` before the first release.
- Homebrew tap: a fine-grained token with contents write on `homebrew-tap` only, stored as `HOMEBREW_TAP_TOKEN`.
- Signing: the Developer ID Application certificate and its password (`MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`) and an App Store Connect API key for `notarytool` (`NOTARY_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID`). The job imports the certificate into a temporary keychain that is deleted at the end of the job.
- Permissions are set per job, never workflow-wide. `stamp`: `contents: write`. `release-please`: `contents: write`, `pull-requests: write`, `issues: write` (it labels pull requests). Jobs that upload assets: `contents: write`. `index`: `contents: write`. npm and PyPI publish jobs: `contents: read` and `id-token: write`. The repository setting "Allow GitHub Actions to create and approve pull requests" must be on for release-please, and Claude turns it on with `gh api`.

### Failure handling

Release-please runs before anything is built, so a build failure leaves a tag with no assets. Release-please's outputs describe only releases it creates in that run, so re-running a failed run does not rebuild a release that already exists. The workflow therefore also has a `workflow_dispatch` trigger with a `tags` input (for example `tbx-cli-v0.1.0`). A `resolve` job turns either release-please's outputs or the dispatched tags into one release matrix with each tag's commit SHA, and every build and publish job reads that matrix. Recovering a failed release means dispatching the workflow with its tag, and every upload and publish step skips work already done. A tool release is complete when `index.json` lists it, and a `tbx-cli` release is complete when it has `checksums.txt`. `tbx install` and `install.sh` only use complete releases, so they never see a half-published version.

## Calls I made (not agreed with Joe, check these)

- The `stamp` job pushes commits straight to `main` and `release-please` runs after it in the same workflow, because `main` is unprotected. A pull-request flow is the fallback if protection is added.
- `tbx-cli` lives at `tbx/` with its version in `tbx/version.txt`, starts at `0.1.0`, and the npm and PyPI manifests get their version at publish time.
- The release index lives on an orphan `release-index` branch instead of a release asset, because assets cannot be replaced atomically.
- The installer finds `tbx-cli` by tag prefix through the releases API instead of GitHub's "latest" label.
- The Homebrew formula comes from a template in this repo, and the step skips when the formula already has the version.
- Signing and notarizing belong to this work, because Joe has a developer account. Notarization uses an App Store Connect API key, not an Apple ID password.
- Four glibc binaries, with `.deb` and `.rpm` for both Linux architectures.
- HTTP fetch, checksum verification and `tbx update` are part of this work.

- `release-type: simple` with `tool.toml` as the version source, over per-language release types.
- The stamp-file mechanism for the `shared/` rule.
- A single `index.json` for all tools on one branch, instead of an index per tool release.
- `nfpm` for `.deb` and `.rpm`.
- Launcher-style npm and PyPI packages that download the binary on first run, instead of bundling all four binaries in the package.
- `macos-15-intel` for the x64 macOS smoke test. If that runner label is gone, the x64 macOS binary ships without a smoke test and the gap is recorded in the release notes.
- `bun build --compile` cross-compiling all four targets from one runner.

## Unverified

- That `macos-15-intel` runners are still available on GitHub-hosted plans.
- That `bun build --compile --target` produces working binaries for all four targets from a Linux runner. Check before building the workflow.
- That release-please's `toml` updater handles `tool.toml` as written, including the `[[args]]` tables.
- That a `Release-As:` footer on a squash-merge commit is honored for a component release PR.
- Whether a `bun build --compile` binary can be re-signed with a Developer ID identity and the hardened runtime, and which entitlements it needs to start (likely allow-jit and allow-unsigned-executable-memory). Check with a manual sign and notarize of one binary before wiring the job.
- Whether the npm Trusted Publisher can be configured for a package whose first real version comes from the workflow.

## Human-only steps

- Creating the fine-grained `HOMEBREW_TAP_TOKEN` and adding it as a secret needs Joe's login. Claude creates the `joeblackwaslike/homebrew-tap` repo itself.
- Switching npm to a Trusted Publisher and deleting `NPM_TOKEN`.
- Exporting the Developer ID Application certificate as a `.p12` and creating an App Store Connect API key (Joe's Apple login), then `gh secret set` for the five signing secrets.
- Adding a PyPI trusted publisher for `tbx-cli` bound to workflow `release.yml` and environment `pypi` (Joe's PyPI login).

## Left to the builder

Exact workflow job structure and caching, the stamp hash algorithm, the launcher packages' checksum-table format, the `nfpm` config, and the smoke-test commands.
