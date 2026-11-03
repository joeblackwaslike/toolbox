#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/release-not-latest.sh"
  GH_LOG="${BATS_TEST_TMPDIR}/gh.log"
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$bin"
  printf '#!/usr/bin/env bash\necho "$*" >>"%s"\n' "$GH_LOG" >"${bin}/gh"
  chmod +x "${bin}/gh"
  PATH="${bin}:$PATH"
}

@test "takes the repo-wide latest label away from a tool release" {
  run "$SCRIPT" transcribe-v0.2.0
  [ "$status" -eq 0 ]
  [ "$(cat "$GH_LOG")" = "release edit transcribe-v0.2.0 --latest=false" ]
}

@test "leaves tbx-cli releases alone" {
  run "$SCRIPT" tbx-cli-v0.1.0
  [ "$status" -eq 2 ]
  [ ! -e "$GH_LOG" ]
}

@test "rejects a missing or malformed tag" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
  run "$SCRIPT" 'not a tag'
  [ "$status" -eq 2 ]
  [ ! -e "$GH_LOG" ]
}
