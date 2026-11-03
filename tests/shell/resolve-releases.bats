#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/resolve-releases.sh"
  SHA_TOOL=$(printf '1%.0s' {1..40})
  SHA_CLI=$(printf '2%.0s' {1..40})
  TAG_OBJECT=$(printf '3%.0s' {1..40})
  GH_LOG="${BATS_TEST_TMPDIR}/gh.log"
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$bin"
  cat >"${bin}/gh" <<EOF
#!/usr/bin/env bash
echo "\$*" >>'$GH_LOG'
case "\$2" in
  'repos/{owner}/{repo}/git/ref/tags/transcribe-v0.2.0')
    echo '{"ref":"refs/tags/transcribe-v0.2.0","object":{"type":"commit","sha":"$SHA_TOOL"}}' ;;
  'repos/{owner}/{repo}/git/ref/tags/tbx-cli-v0.1.0')
    echo '{"ref":"refs/tags/tbx-cli-v0.1.0","object":{"type":"tag","sha":"$TAG_OBJECT"}}' ;;
  'repos/{owner}/{repo}/git/tags/$TAG_OBJECT')
    echo '{"tag":"tbx-cli-v0.1.0","object":{"type":"commit","sha":"$SHA_CLI"}}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
EOF
  chmod +x "${bin}/gh"
  PATH="${bin}:$PATH"
}

@test "builds the matrix from release-please's per-path outputs" {
  outputs=$(jq -nc --arg t "$SHA_TOOL" --arg c "$SHA_CLI" '{
    releases_created: "true",
    paths_released: "[\"tools/transcribe\",\"tbx\"]",
    "tools/transcribe--release_created": "true",
    "tools/transcribe--tag_name": "transcribe-v0.2.0",
    "tools/transcribe--version": "0.2.0",
    "tools/transcribe--sha": $t,
    "tools/transcribe--body": "notes",
    "tbx--release_created": "true",
    "tbx--tag_name": "tbx-cli-v0.1.0",
    "tbx--version": "0.1.0",
    "tbx--sha": $c
  }')
  run --separate-stderr "$SCRIPT" outputs "$outputs"
  [ "$status" -eq 0 ]
  [ "$output" = "[{\"component\":\"transcribe\",\"tag\":\"transcribe-v0.2.0\",\"version\":\"0.2.0\",\"sha\":\"$SHA_TOOL\",\"kind\":\"tool\"},{\"component\":\"tbx-cli\",\"tag\":\"tbx-cli-v0.1.0\",\"version\":\"0.1.0\",\"sha\":\"$SHA_CLI\",\"kind\":\"cli\"}]" ]
}

@test "an empty matrix when release-please released nothing" {
  run "$SCRIPT" outputs '{"releases_created":"false","paths_released":"[]"}'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "fails when a released path has no tag or sha" {
  run "$SCRIPT" outputs '{"paths_released":"[\"tools/transcribe\"]","tools/transcribe--tag_name":"transcribe-v0.2.0"}'
  [ "$status" -ne 0 ]
}

@test "resolves dispatched tags to commits, peeling annotated tags" {
  run --separate-stderr "$SCRIPT" tags "transcribe-v0.2.0, tbx-cli-v0.1.0 transcribe-v0.2.0"
  [ "$status" -eq 0 ]
  [ "$output" = "[{\"component\":\"transcribe\",\"tag\":\"transcribe-v0.2.0\",\"version\":\"0.2.0\",\"sha\":\"$SHA_TOOL\",\"kind\":\"tool\"},{\"component\":\"tbx-cli\",\"tag\":\"tbx-cli-v0.1.0\",\"version\":\"0.1.0\",\"sha\":\"$SHA_CLI\",\"kind\":\"cli\"}]" ]
}

@test "fails when a dispatched tag does not exist" {
  run "$SCRIPT" tags "transcribe-v9.9.9"
  [ "$status" -ne 0 ]
}

@test "rejects a malformed tag without calling GitHub" {
  run "$SCRIPT" tags 'transcribe-v0.2.0 ../../evil-v1'
  [ "$status" -eq 2 ]
  [ ! -e "$GH_LOG" ]
}

@test "rejects an empty tag list and an unknown mode" {
  run "$SCRIPT" tags " , "
  [ "$status" -eq 2 ]
  run "$SCRIPT" nope x
  [ "$status" -eq 2 ]
}
