#!/usr/bin/env bash
# Uploads files to the GitHub release for <tag> without ever replacing an asset. A file whose
# name is already on the release is downloaded and compared: identical bytes are skipped,
# different bytes fail the run.
#
# Usage: upload-release-asset.sh <tag> <file>...
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || {
  echo "upload-release-asset.sh needs bash >= 4.4" >&2
  exit 1
}

die() {
  printf 'upload-release-asset: %s\n' "$2" >&2
  exit "$1"
}

[ $# -ge 2 ] || die 2 'usage: upload-release-asset.sh <tag> <file>...'
tag=$1
shift

existing=$(gh release view "$tag" --json assets | jq -r '.assets[].name')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for file in "$@"; do
  name=$(basename "$file")
  if ! grep -qxF -- "$name" <<<"$existing"; then
    gh release upload "$tag" "$file"
    echo "uploaded $name to $tag"
    continue
  fi
  gh release download "$tag" --pattern "$name" --dir "$work"
  cmp -s "$file" "${work}/${name}" || die 1 "$name on $tag differs from the rebuilt file; not replacing it"
  echo "$name is already on $tag with the same bytes"
done
