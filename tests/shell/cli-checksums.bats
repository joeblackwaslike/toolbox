#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/cli-checksums.sh"
  BINS="${BATS_TEST_TMPDIR}/some dir/cli"
  mkdir -p "$BINS"
  local target
  for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
    printf 'binary %s' "$target" >"${BINS}/tbx-${target}"
  done
}

expected_sum() {
  printf 'binary %s' "$1" | shasum -a 256 | cut -d ' ' -f 1
}

@test "prints one sha256sum line per binary with bare file names" {
  run --separate-stderr "$SCRIPT" "$BINS"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 4 ]
  local line
  for line in "${lines[@]}"; do
    [[ "$line" =~ ^[0-9a-f]{64}\ \ tbx-(darwin|linux)-(arm64|x64)$ ]]
  done
  [ "${lines[0]}" = "$(expected_sum darwin-arm64)  tbx-darwin-arm64" ]
  [ "${lines[1]}" = "$(expected_sum darwin-x64)  tbx-darwin-x64" ]
  [ "${lines[2]}" = "$(expected_sum linux-arm64)  tbx-linux-arm64" ]
  [ "${lines[3]}" = "$(expected_sum linux-x64)  tbx-linux-x64" ]
}

@test "ignores other files in the directory" {
  printf 'x' >"${BINS}/tbx-cli_0.1.0_amd64.deb"
  printf 'x' >"${BINS}/checksums.txt"
  run --separate-stderr "$SCRIPT" "$BINS"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 4 ]
}

@test "the output is accepted by render-packaging.sh" {
  "$SCRIPT" "$BINS" >"${BATS_TEST_TMPDIR}/checksums.txt"
  run "${BATS_TEST_DIRNAME}/../../scripts/render-packaging.sh" 0.1.0 \
    "${BATS_TEST_TMPDIR}/checksums.txt" "${BATS_TEST_TMPDIR}/out"
  [ "$status" -eq 0 ]
  grep -qF "$(expected_sum linux-x64)" "${BATS_TEST_TMPDIR}/out/homebrew/tbx-cli.rb"
}

@test "fails when a binary is missing" {
  rm "${BINS}/tbx-linux-arm64"
  run --separate-stderr "$SCRIPT" "$BINS"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *tbx-linux-arm64* ]]
  [ -z "$output" ]
}

@test "rejects a call without a directory" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
}
