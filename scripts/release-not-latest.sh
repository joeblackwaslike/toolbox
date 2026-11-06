#!/usr/bin/env bash
# Clears GitHub's repo-wide "latest" label from a tool release, so only tbx-cli releases hold it.
#
# Usage: release-not-latest.sh <tool tag>
set -euo pipefail

die() {
  printf 'release-not-latest: %s\n' "$2" >&2
  exit "$1"
}

[ $# -eq 1 ] || die 2 'usage: release-not-latest.sh <tool tag>'
[[ $1 =~ ^[a-z][a-z0-9-]{0,15}-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die 2 "not a release tag: $1"
[[ $1 != tbx-cli-v* ]] || die 2 "$1 is a tbx-cli release, which may be latest"
gh release edit "$1" --latest=false
