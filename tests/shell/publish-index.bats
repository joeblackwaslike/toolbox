#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$(cd "${BATS_TEST_DIRNAME}/../../scripts" && pwd)/publish-index.sh"
  REMOTE="${BATS_TEST_TMPDIR}/remote.git"
  SHA_A=$(printf 'a%.0s' {1..64})
  SHA_B=$(printf 'b%.0s' {1..64})
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
  export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
  export TBX_INDEX_REMOTE="$REMOTE"
  git init -q --bare "$REMOTE"
  git init -q "${BATS_TEST_TMPDIR}/work"
  git init -q "${BATS_TEST_TMPDIR}/other"
  cd "${BATS_TEST_TMPDIR}/work" || return
}

index() {
  git --git-dir="$REMOTE" show release-index:index.json
}

commits() {
  git --git-dir="$REMOTE" rev-list --count release-index
}

url() {
  printf 'https://github.com/o/r/releases/download/%s-v%s/%s-%s.tar.gz' "$1" "$2" "$1" "$2"
}

publish() {
  "$SCRIPT" "$1" "$2" "$(url "$1" "$2")" "$3"
}

# Puts a `git` on PATH that, before each of the first $1 pushes, lets a second clone publish
# `racer<n>` first, so the script's push is rejected as non-fast-forward.
race_pushes() {
  local bin="${BATS_TEST_TMPDIR}/bin"
  RACES="${BATS_TEST_TMPDIR}/races"
  echo 0 >"$RACES"
  mkdir -p "$bin"
  cat >"${bin}/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = push ] && [ "\$(cat '$RACES')" -lt $1 ]; then
  n=\$((\$(cat '$RACES') + 1))
  echo "\$n" >'$RACES'
  (cd '${BATS_TEST_TMPDIR}/other' && PATH='$PATH' '$SCRIPT' "racer\$n" 1.0.0 https://example.com/racer.tar.gz '$SHA_B') >/dev/null 2>&1
fi
exec '$(command -v git)' "\$@"
EOF
  chmod +x "${bin}/git"
  PATH="${bin}:$PATH"
}

@test "first publish creates the orphan release-index branch holding only index.json" {
  run publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -eq 0 ]
  [ "$(commits)" -eq 1 ]
  [ "$(git --git-dir="$REMOTE" ls-tree --name-only release-index)" = index.json ]
  [ "$(index | jq -c .)" = "{\"tools\":[{\"name\":\"transcribe\",\"version\":\"0.1.0\",\"artifact\":\"$(url transcribe 0.1.0)\",\"sha256\":\"$SHA_A\"}]}" ]
}

@test "a second entry is added in a new commit and existing entries stay" {
  publish transcribe 0.1.0 "$SHA_A"
  run publish another 0.3.0 "$SHA_B"
  [ "$status" -eq 0 ]
  [ "$(commits)" -eq 2 ]
  [ "$(index | jq -r '.tools[] | "\(.name) \(.version) \(.sha256)"' | tr '\n' ' ')" = "another 0.3.0 $SHA_B transcribe 0.1.0 $SHA_A " ]
}

@test "entries sort by name, then newest version first" {
  publish transcribe 0.2.0 "$SHA_A"
  publish transcribe 0.10.0 "$SHA_A"
  publish transcribe 1.0.0-rc.2 "$SHA_A"
  publish alpha 1.0.0 "$SHA_A"
  publish transcribe 1.0.0 "$SHA_A"
  publish transcribe 1.0.0-rc.10 "$SHA_A"
  publish transcribe 0.9.0 "$SHA_A"
  [ "$(index | jq -r '.tools[] | "\(.name)@\(.version)"' | tr '\n' ' ')" = "alpha@1.0.0 transcribe@1.0.0 transcribe@1.0.0-rc.10 transcribe@1.0.0-rc.2 transcribe@0.10.0 transcribe@0.9.0 transcribe@0.2.0 " ]
}

@test "publishing the same entry twice is a no-op" {
  publish transcribe 0.1.0 "$SHA_A"
  run publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -eq 0 ]
  [ "$(commits)" -eq 1 ]
  [ "$(index | jq '.tools | length')" -eq 1 ]
}

@test "the same name and version with a different sha256 fails and changes nothing" {
  publish transcribe 0.1.0 "$SHA_A"
  run --separate-stderr publish transcribe 0.1.0 "$SHA_B"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"transcribe 0.1.0"*"$SHA_A"* ]]
  [ "$(commits)" -eq 1 ]
  [ "$(index | jq -r '.tools[0].sha256')" = "$SHA_A" ]
}

@test "a push rejected by a concurrent publish is retried from a fresh fetch" {
  publish transcribe 0.1.0 "$SHA_A"
  race_pushes 1
  run publish another 0.3.0 "$SHA_B"
  [ "$status" -eq 0 ]
  [ "$(cat "$RACES")" -eq 1 ]
  [ "$(index | jq -r '[.tools[].name] | join(" ")')" = "another racer1 transcribe" ]
}

@test "a concurrent publish that creates the branch first is retried and kept" {
  race_pushes 1
  run publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -eq 0 ]
  [ "$(commits)" -eq 2 ]
  [ "$(index | jq -r '[.tools[].name] | join(" ")')" = "racer1 transcribe" ]
}

@test "gives up after 5 retries" {
  race_pushes 100
  run --separate-stderr publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -ne 0 ]
  [ "$(cat "$RACES")" -eq 6 ]
  [[ "$stderr" == *"5 retries"* ]]
  [ "$(index | jq '[.tools[] | select(.name == "transcribe")] | length')" -eq 0 ]
}

@test "a push the remote refuses for another reason is not retried" {
  printf '#!/bin/sh\necho x >>"%s"\nexit 1\n' "${BATS_TEST_TMPDIR}/hook-runs" >"${REMOTE}/hooks/pre-receive"
  chmod +x "${REMOTE}/hooks/pre-receive"
  run publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -ne 0 ]
  [ "$(wc -l <"${BATS_TEST_TMPDIR}/hook-runs")" -eq 1 ]
}

@test "fails when the remote is unreachable" {
  export TBX_INDEX_REMOTE="${BATS_TEST_TMPDIR}/missing.git"
  run publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -ne 0 ]
}

@test "rejects a malformed sha256, tool name or argument count" {
  run publish transcribe 0.1.0 ABC
  [ "$status" -eq 2 ]
  run publish Bad_Name 0.1.0 "$SHA_A"
  [ "$status" -eq 2 ]
  run "$SCRIPT" transcribe 0.1.0
  [ "$status" -eq 2 ]
  [ "$(git --git-dir="$REMOTE" branch --list release-index)" = "" ]
}

@test "fails when the release-index branch has no index.json" {
  git -C "${BATS_TEST_TMPDIR}/other" commit -q --allow-empty -m empty
  git -C "${BATS_TEST_TMPDIR}/other" push -q "$REMOTE" HEAD:refs/heads/release-index
  run publish transcribe 0.1.0 "$SHA_A"
  [ "$status" -ne 0 ]
  [ "$(commits)" -eq 1 ]
}
