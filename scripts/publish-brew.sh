#!/usr/bin/env bash
# Pushes a rendered tbx-cli formula to the Homebrew tap as Formula/tbx-cli.rb in one commit,
# `tbx-cli <version>`, unless the tap's formula already names <version>. HOMEBREW_TAP_TOKEN reaches
# git through a credential helper that reads it from the environment, so the token is never
# written to .git/config or passed as a process argument. TAP_URL overrides the tap (for tests).
#
# Usage: publish-brew.sh <formula.rb> <version>
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || {
  echo "publish-brew.sh needs bash >= 4.4" >&2
  exit 1
}

die() {
  printf 'publish-brew: %s\n' "$2" >&2
  exit "$1"
}

[ $# -eq 2 ] || die 2 'usage: publish-brew.sh <formula.rb> <version>'
[ -f "$1" ] || die 2 "formula not found: $1"
formula=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
version=$2
[ -n "${HOMEBREW_TAP_TOKEN:-}" ] ||
  die 1 'HOMEBREW_TAP_TOKEN is empty; set it to a fine-grained token with contents write on joeblackwaslike/homebrew-tap'
grep -qF "version \"${version}\"" "$formula" || die 1 "$formula does not name version $version"

export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=''
# shellcheck disable=SC2016 # the helper's shell expands the token, not this one
export GIT_CONFIG_KEY_1=credential.helper \
  GIT_CONFIG_VALUE_1='!f() { [ "$1" = get ] || return 0; echo username=x-access-token; echo "password=${HOMEBREW_TAP_TOKEN}"; }; f'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone --quiet "${TAP_URL:-https://github.com/joeblackwaslike/homebrew-tap.git}" "${work}/tap"
cd "${work}/tap"
branch=$(git symbolic-ref --short HEAD)
dest=Formula/tbx-cli.rb

if [ -f "$dest" ] && grep -qF "version \"${version}\"" "$dest"; then
  echo "the tap formula already names tbx-cli ${version}; nothing to push"
  exit 0
fi
mkdir -p Formula
cp "$formula" "$dest"
git add -- "$dest"
git commit --quiet --message "tbx-cli ${version}" -- "$dest"
for retry in 0 1 2 3; do
  if git push --quiet origin "HEAD:${branch}"; then
    echo "pushed tbx-cli ${version} to the tap"
    exit 0
  fi
  [ "$retry" -lt 3 ] || break
  git pull --quiet --rebase origin "$branch"
done
die 1 'push to the tap still rejected after 3 retries'
