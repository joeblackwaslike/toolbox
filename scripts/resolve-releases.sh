#!/usr/bin/env bash
# Prints the release matrix as a compact JSON array of
# {component, tag, version, sha, kind}, kind being `cli` for tbx-cli and `tool` otherwise.
#
# Usage: resolve-releases.sh outputs <release-please outputs as JSON>
#        resolve-releases.sh tags "<tag>[ ,]<tag>..."   (looks each tag up with `gh api`)
set -euo pipefail
shopt -s inherit_errexit

readonly TAG_PATTERN='^([a-z][a-z0-9-]{0,15})-v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$'

die() {
  printf 'resolve-releases: %s\n' "$2" >&2
  exit "$1"
}

from_outputs() {
  jq -c '. as $o | ($o.paths_released // "[]" | fromjson) | map(
    . as $p
    | ($o["\($p)--tag_name"] // error("no tag_name for \($p)")) as $tag
    | {component: ($tag | capture("^(?<c>.+)-v[0-9]").c), tag: $tag,
       version: ($o["\($p)--version"] // error("no version for \($p)")),
       sha: ($o["\($p)--sha"] // error("no sha for \($p)"))})' <<<"$1"
}

object_of() {
  gh api "$1" | jq -r '.object.type + " " + .object.sha'
}

commit_of() {
  local object
  object=$(object_of "repos/{owner}/{repo}/git/ref/tags/$1")
  if [ "${object%% *}" = tag ]; then
    object=$(object_of "repos/{owner}/{repo}/git/tags/${object#* }")
  fi
  [ "${object%% *}" = commit ] || die 1 "$1 does not point at a commit"
  printf '%s\n' "${object#* }"
}

from_tags() {
  local tags=() tag sha entries=()
  read -r -a tags <<<"${1//,/ }"
  [ ${#tags[@]} -gt 0 ] || die 2 'no tags given'
  for tag in "${tags[@]}"; do
    [[ $tag =~ $TAG_PATTERN ]] || die 2 "not a release tag: $tag"
  done
  for tag in "${tags[@]}"; do
    sha=$(commit_of "$tag")
    [[ $tag =~ $TAG_PATTERN ]]
    entries+=("$(jq -nc --arg c "${BASH_REMATCH[1]}" --arg t "$tag" --arg v "${BASH_REMATCH[2]}" --arg s "$sha" \
      '{component: $c, tag: $t, version: $v, sha: $s}')")
  done
  printf '%s\n' "${entries[@]}" | jq -sc 'reduce .[] as $e ([]; if any(.[]; .tag == $e.tag) then . else . + [$e] end)'
}

[ $# -eq 2 ] || die 2 'usage: resolve-releases.sh outputs <json> | tags "<tags>"'
case $1 in
outputs) matrix=$(from_outputs "$2") ;;
tags) matrix=$(from_tags "$2") ;;
*) die 2 "unknown mode: $1" ;;
esac
jq -c 'map(. + {kind: (if .component == "tbx-cli" then "cli" else "tool" end)})' <<<"$matrix"
