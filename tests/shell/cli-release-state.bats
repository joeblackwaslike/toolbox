#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/cli-release-state.sh"
  ASSETS="${BATS_TEST_TMPDIR}/release"
  DELETED="${BATS_TEST_TMPDIR}/deleted"
  mkdir -p "$ASSETS"
  : >"$DELETED"
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$bin"
  cat >"${bin}/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$1" = release ] || exit 64
shift
[ "\$2" = tbx-cli-v0.1.0 ] || { echo 'release not found' >&2; exit 1; }
case "\$1" in
  view) jq -n '{assets: \$ARGS.positional | map({name: .})}' --args \$(ls '$ASSETS') ;;
  delete-asset)
    [ "\$4" = --yes ] || exit 64
    rm '$ASSETS'/"\$3"
    echo "\$3" >>'$DELETED' ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "${bin}/gh"
  PATH="${bin}:$PATH"
}

add_assets() {
  local name
  for name in "$@"; do printf '%s' "$name" >"${ASSETS}/${name}"; done
}

@test "a release without assets is incomplete" {
  run --separate-stderr "$SCRIPT" tbx-cli-v0.1.0
  [ "$status" -eq 0 ]
  [ "$output" = incomplete ]
}

@test "a release with assets but no checksums.txt is incomplete" {
  add_assets tbx-darwin-arm64 tbx-linux-x64
  run --separate-stderr "$SCRIPT" tbx-cli-v0.1.0
  [ "$status" -eq 0 ]
  [ "$output" = incomplete ]
}

@test "a release with checksums.txt is complete" {
  add_assets tbx-darwin-arm64 tbx-linux-x64 checksums.txt
  run --separate-stderr "$SCRIPT" tbx-cli-v0.1.0
  [ "$status" -eq 0 ]
  [ "$output" = complete ]
}

@test "an asset that only ends in checksums.txt does not make the release complete" {
  add_assets old-checksums.txt
  run --separate-stderr "$SCRIPT" tbx-cli-v0.1.0
  [ "$output" = incomplete ]
}

@test "fails when the release does not exist" {
  run --separate-stderr "$SCRIPT" tbx-cli-v9.9.9
  [ "$status" -ne 0 ]
  [ -z "$output" ]
}

@test "--clear deletes every asset of an incomplete release" {
  add_assets tbx-darwin-arm64 tbx-linux-x64 tbx-cli_0.1.0_amd64.deb
  run --separate-stderr "$SCRIPT" --clear tbx-cli-v0.1.0
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$ASSETS")" ]
  [ "$(sort "$DELETED" | tr '\n' ' ')" = "tbx-cli_0.1.0_amd64.deb tbx-darwin-arm64 tbx-linux-x64 " ]
}

@test "--clear on a release without assets deletes nothing" {
  run --separate-stderr "$SCRIPT" --clear tbx-cli-v0.1.0
  [ "$status" -eq 0 ]
  [ ! -s "$DELETED" ]
}

@test "--clear refuses to touch a complete release" {
  add_assets tbx-darwin-arm64 checksums.txt
  run --separate-stderr "$SCRIPT" --clear tbx-cli-v0.1.0
  [ "$status" -eq 1 ]
  [[ "$stderr" == *complete* ]]
  [ ! -s "$DELETED" ]
  [ -f "${ASSETS}/checksums.txt" ]
}

@test "rejects a call without a tag" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
  run "$SCRIPT" --clear
  [ "$status" -eq 2 ]
}
