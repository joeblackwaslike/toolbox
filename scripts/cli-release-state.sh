#!/usr/bin/env bash
# A tbx-cli release is complete once it has checksums.txt, which is always uploaded last.
#
# Usage: cli-release-state.sh <tag>          prints `complete` or `incomplete`
#        cli-release-state.sh --clear <tag>  deletes every asset of an incomplete release, since
#                                            a partial set is unusable and must not be mixed with
#                                            bytes from a new build
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || {
  echo "cli-release-state.sh needs bash >= 4.4" >&2
  exit 1
}

die() {
  printf 'cli-release-state: %s\n' "$2" >&2
  exit "$1"
}

clear=0
if [ "${1:-}" = --clear ]; then
  clear=1
  shift
fi
[ $# -eq 1 ] || die 2 'usage: cli-release-state.sh [--clear] <tag>'
tag=$1

assets=$(gh release view "$tag" --json assets | jq -r '.assets[].name')
if grep -qxF checksums.txt <<<"$assets"; then
  [ "$clear" = 0 ] || die 1 "$tag is complete (it has checksums.txt); not deleting its assets"
  echo complete
  exit 0
fi
if [ "$clear" = 0 ]; then
  echo incomplete
  exit 0
fi
while IFS= read -r name; do
  [ -n "$name" ] || continue
  gh release delete-asset "$tag" "$name" --yes
  echo "deleted partial asset $name from $tag"
done <<<"$assets"
