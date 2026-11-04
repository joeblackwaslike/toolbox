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

fake_bun() {
  mkdir -p "${BATS_TEST_TMPDIR}/fakebin" "${BATS_TEST_TMPDIR}/cwd"
  cat >"${BATS_TEST_TMPDIR}/fakebin/bun" <<'FAKE'
#!/usr/bin/env bash
[[ "$1" == "--version" ]] && { cat "$(dirname "$0")/../../../../../.bun-version" 2>/dev/null || echo 0; exit 0; }
touch ".fake-00000000.bun-build"
[[ -n "${FAKE_BUN_FAIL:-}" ]] && exit 1
while [[ $# -gt 0 ]]; do [[ "$1" == "--outfile" ]] && touch "$2"; shift; done
FAKE
  chmod +x "${BATS_TEST_TMPDIR}/fakebin/bun"
}

@test "leaves no .bun-build file in the cwd after a successful compile" {
  fake_bun
  cd "${BATS_TEST_TMPDIR}/cwd"
  PATH="${BATS_TEST_TMPDIR}/fakebin:${PATH}" run "$SCRIPT" "${BATS_TEST_TMPDIR}/rel-out"
  [ "$status" -eq 0 ]
  [ -f "${BATS_TEST_TMPDIR}/rel-out/tbx-linux-x64" ]
  [ -z "$(ls -A1 . | grep 'bun-build')" ]
}

@test "leaves no .bun-build file in the cwd after a failed compile" {
  fake_bun
  cd "${BATS_TEST_TMPDIR}/cwd"
  FAKE_BUN_FAIL=1 PATH="${BATS_TEST_TMPDIR}/fakebin:${PATH}" run "$SCRIPT" "${BATS_TEST_TMPDIR}/rel-out"
  [ "$status" -ne 0 ]
  [ -z "$(ls -A1 . | grep 'bun-build')" ]
}
