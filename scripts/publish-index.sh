#!/usr/bin/env bash
# Adds one tool release to index.json on the orphan `release-index` branch of the remote
# (`TBX_INDEX_REMOTE`, default `origin`). Run inside any git repository; the commit is built
# with plumbing, so the working tree is never touched.
#
# Usage: publish-index.sh <name> <version> <artifact-url> <sha256>
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || {
  echo "publish-index.sh needs bash >= 4.4" >&2
  exit 1
}

readonly BRANCH=release-index
readonly LOCAL_REF=refs/tbx/release-index
readonly MAX_RETRIES=5

die() {
  printf 'publish-index: %s\n' "$2" >&2
  exit "$1"
}

[ $# -eq 4 ] || die 2 'usage: publish-index.sh <name> <version> <artifact-url> <sha256>'
name=$1 version=$2 artifact=$3 sha256=$4
[[ $name =~ ^[a-z][a-z0-9-]{0,15}$ ]] || die 2 "invalid tool name: $name"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die 2 "invalid version: $version"
[[ $sha256 =~ ^[0-9a-f]{64}$ ]] || die 2 "sha256 must be 64 lowercase hex characters: $sha256"
[ -n "$artifact" ] || die 2 'artifact url is empty'
remote=${TBX_INDEX_REMOTE:-origin}

# Prints the index as it should be after adding the entry, or nothing when it is already there.
merged_index() {
  local current listed
  if [ -n "$1" ]; then
    current=$(git show "$1:index.json")
  else
    current='{"tools":[]}'
  fi
  listed=$(jq -r --arg n "$name" --arg v "$version" \
    '.tools[] | select(.name == $n and .version == $v) | .sha256' <<<"$current")
  if [ -n "$listed" ]; then
    [ "$listed" = "$sha256" ] && return 0
    die 1 "$name $version is already listed with sha256 $listed, not $sha256"
  fi
  # Newest version first within a name, so `tbx install`, which takes the first entry, gets it.
  jq --arg n "$name" --arg v "$version" --arg a "$artifact" --arg s "$sha256" '
    def key: (index("-") // length) as $i
      | [(.[:$i] | split(".") | map(tonumber)), ($i == length), (.[$i + 1:] | split(".") | map(tonumber? // .))];
    .tools += [{name: $n, version: $v, artifact: $a, sha256: $s}]
    | .tools |= (group_by(.name) | map(sort_by(.version | key) | reverse) | add)' <<<"$current"
}

publish_once() {
  local base='' heads index blob tree commit parents=() err
  heads=$(git ls-remote "$remote" "refs/heads/$BRANCH")
  if [ -n "$heads" ]; then
    git fetch -q --no-tags "$remote" "+refs/heads/$BRANCH:$LOCAL_REF"
    base=$(git rev-parse "$LOCAL_REF")
    parents=(-p "$base")
  fi
  index=$(merged_index "$base")
  if [ -z "$index" ]; then
    echo "$name $version is already in the index"
    return 0
  fi
  blob=$(git hash-object -w --stdin <<<"$index")
  tree=$(printf '100644 blob %s\tindex.json\n' "$blob" | git mktree)
  commit=$(git commit-tree "$tree" ${parents[@]+"${parents[@]}"} -m "index: add $name $version")
  if err=$(LC_ALL=C git push -q "$remote" "$commit:refs/heads/$BRANCH" 2>&1); then
    echo "added $name $version to the index"
    return 0
  fi
  printf '%s\n' "$err" >&2
  [[ $err == *"[rejected]"* ]] && return 75
  return 1
}

for ((retry = 0; ; retry++)); do
  # A function called from `||` or `if` runs without errexit, so run it as a plain command.
  set +e
  (
    set -e
    publish_once
  )
  status=$?
  set -e
  [ "$status" -eq 75 ] || exit "$status"
  [ "$retry" -lt "$MAX_RETRIES" ] || die 1 "push still rejected after $MAX_RETRIES retries"
  echo "push rejected by a concurrent update, retrying" >&2
done
