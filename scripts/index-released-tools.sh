#!/usr/bin/env bash
# Adds each released tool to index.json with publish-index.sh. A tool whose release lacks its
# tarball or .sha256 is skipped, so an entry is only added after its tarball is uploaded; the rest
# are still indexed, and the script exits 1 at the end naming every skipped tag.
#
# Usage: index-released-tools.sh <tools JSON from resolve-releases.sh>
# GH_REPO names the repository; TBX_PUBLISH_INDEX overrides publish-index.sh (for tests).
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || {
  echo "index-released-tools.sh needs bash >= 4.4" >&2
  exit 1
}

[ $# -eq 1 ] || {
  echo 'usage: index-released-tools.sh <tools JSON>' >&2
  exit 2
}
: "${GH_REPO:?GH_REPO must name the repository}"
publish=${TBX_PUBLISH_INDEX:-$(dirname "${BASH_SOURCE[0]}")/publish-index.sh}

checksum_of() {
  local tag=$1 file=$2 assets
  assets=$(gh release view "$tag" --json assets </dev/null | jq -r '.assets[].name') || return 1
  grep -qxF -- "$file" <<<"$assets" && grep -qxF -- "${file}.sha256" <<<"$assets" || return 1
  gh release download "$tag" --pattern "${file}.sha256" --output - </dev/null | cut -d ' ' -f 1
}

skipped=()
while read -r name version tag; do
  file="${name}-${version}.tar.gz"
  if ! sha256=$(checksum_of "$tag" "$file"); then
    echo "index-released-tools: $tag has no ${file} or ${file}.sha256; not indexing it" >&2
    skipped+=("$tag")
    continue
  fi
  "$publish" "$name" "$version" "https://github.com/${GH_REPO}/releases/download/${tag}/${file}" "$sha256" </dev/null
done < <(jq -r '.[] | "\(.component) \(.version) \(.tag)"' <<<"$1")

if [ ${#skipped[@]} -gt 0 ]; then
  echo "index-released-tools: skipped ${skipped[*]}" >&2
  exit 1
fi
