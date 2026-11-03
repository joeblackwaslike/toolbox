#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup_file() {
  curl -fsI --max-time 5 https://github.com >/dev/null 2>&1 || return 0
  export OUT="${BATS_FILE_TMPDIR}/out"
}

setup() {
  curl -fsI --max-time 5 https://github.com >/dev/null 2>&1 ||
    skip "no network: cross-compiling downloads target runtimes"
  ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  SCRIPT="${ROOT}/scripts/compile-tbx.sh"
}

host_target() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

@test "no argument exits non-zero with usage" {
  run -2 "$SCRIPT"
  [[ "$output" == *"Usage:"* ]]
}

@test "compiles four executables that run" {
  run "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
    [ -x "${OUT}/tbx-${t}" ]
  done
  bin="${OUT}/tbx-$(host_target)"
  run "$bin" --version
  [ "$status" -eq 0 ]
  [ "$output" = "$(cat "${ROOT}/tbx/version.txt")" ]
  home="${BATS_TEST_TMPDIR}/home"
  mkdir -p "$home"
  HOME="$home" XDG_DATA_HOME="$home/data" XDG_STATE_HOME="$home/state" XDG_CONFIG_HOME="$home/config" run "$bin" list
  [ "$status" -eq 0 ]
}
