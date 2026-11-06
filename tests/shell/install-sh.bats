#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../install.sh"
  local src="${BATS_TEST_DIRNAME}/../fixtures/releases"
  FIXTURES="${BATS_TEST_TMPDIR}/releases"
  mkdir -p "$FIXTURES"
  local ver name
  for ver in v0.1.0 v0.2.0 v0.3.0; do
    mkdir -p "${FIXTURES}/${ver}"
    : >"${FIXTURES}/${ver}/checksums.txt"
    for name in tbx-darwin-arm64 tbx-darwin-x64 tbx-linux-arm64 tbx-linux-x64; do
      sed -e "s/@NAME@/${name}/" -e "s/@VERSION@/${ver}/" "${src}/tbx.template" >"${FIXTURES}/${ver}/${name}"
      printf '%s  %s\n' "$(hash_of "${FIXTURES}/${ver}/${name}")" "$name" >>"${FIXTURES}/${ver}/checksums.txt"
    done
  done
  rm "${FIXTURES}/v0.3.0/checksums.txt"
  sed "s#@FIXTURES@#${FIXTURES}#g" "${src}/releases.json" >"${FIXTURES}/releases.json"

  export HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "$HOME"
  export SHELL=/bin/zsh
  export TBX_RELEASES_API="file://${FIXTURES}/releases.json"
  export TBX_INSTALL_DIR="${HOME}/.local/share/tbx/bin"
  export TBX_UNAME_S=Linux
  export TBX_UNAME_M=x86_64
  export TBX_LIBC=glibc
  export TBX_TEST_LOG="${BATS_TEST_TMPDIR}/tbx.log"
}

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

@test "installs the newest complete release and skips one without checksums.txt" {
  run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  run "${TBX_INSTALL_DIR}/tbx"
  [ "$output" = "tbx-linux-x64 v0.2.0" ]
  [ -x "${TBX_INSTALL_DIR}/tbx" ]
}

@test "chooses the asset for the requested platform" {
  TBX_UNAME_S=Darwin TBX_UNAME_M=arm64 run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  run "${TBX_INSTALL_DIR}/tbx"
  [ "$output" = "tbx-darwin-arm64 v0.2.0" ]
}

@test "maps aarch64 and amd64 to arm64 and x64" {
  TBX_UNAME_M=aarch64 run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  run "${TBX_INSTALL_DIR}/tbx"
  [ "$output" = "tbx-linux-arm64 v0.2.0" ]
  TBX_UNAME_M=amd64 run sh "$SCRIPT"
  run "${TBX_INSTALL_DIR}/tbx"
  [ "$output" = "tbx-linux-x64 v0.2.0" ]
}

@test "a checksum mismatch aborts and leaves no binary" {
  printf '%s  tbx-linux-x64\n' "$(printf '0%.0s' {1..64})" >"${FIXTURES}/v0.2.0/checksums.txt"
  run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"checksum"* ]]
  [ ! -e "${TBX_INSTALL_DIR}/tbx" ]
  [ ! -e "${TBX_INSTALL_DIR}/tbx.tmp" ]
}

@test "musl exits with the unsupported message" {
  TBX_LIBC=musl run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"musl is not supported in v1"* ]]
}

@test "an unsupported arch exits" {
  TBX_UNAME_M=riscv64 run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported architecture"* ]]
}

@test "an unsupported OS exits" {
  TBX_UNAME_S=FreeBSD run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported OS"* ]]
}

@test "exits when no complete release exists" {
  rm "${FIXTURES}/v0.2.0/checksums.txt"
  sed 's/checksums.txt/other.txt/' "${FIXTURES}/releases.json" >"${FIXTURES}/releases.new"
  mv "${FIXTURES}/releases.new" "${FIXTURES}/releases.json"
  run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"No complete tbx-cli release"* ]]
}

@test "running twice adds the PATH line once" {
  run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'added by tbx installer' "${HOME}/.zshrc")" -eq 1 ]
  grep -qF "export PATH=\"${TBX_INSTALL_DIR}:\$PATH\"" "${HOME}/.zshrc"
}

@test "uses .bash_profile for bash on macOS and .bashrc on Linux" {
  SHELL=/bin/bash TBX_UNAME_S=Darwin run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "${HOME}/.bash_profile" ]
  SHELL=/bin/bash run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "${HOME}/.bashrc" ]
  SHELL=/bin/fish run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "${HOME}/.profile" ]
}

@test "leaves profiles alone when the install dir is already on PATH" {
  PATH="${TBX_INSTALL_DIR}:$PATH" run sh "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -e "${HOME}/.zshrc" ]
}

@test "forwards named tools to tbx install" {
  run sh "$SCRIPT" transcribe cpu
  [ "$status" -eq 0 ]
  [ "$(cat "$TBX_TEST_LOG")" = "tbx install transcribe cpu" ]
}

@test "propagates the exit code of tbx install" {
  TBX_TEST_EXIT=7 run sh "$SCRIPT" transcribe
  [ "$status" -eq 7 ]
}

@test "prints a hint when no tools are named" {
  run sh "$SCRIPT"
  [[ "$output" == *"tbx install <tool>"* ]]
  [ ! -e "$TBX_TEST_LOG" ]
}

@test "fails when checksums.txt has no entry for the platform binary" {
  grep -v 'tbx-linux-x64$' "${FIXTURES}/v0.2.0/checksums.txt" >"${FIXTURES}/new.txt"
  mv "${FIXTURES}/new.txt" "${FIXTURES}/v0.2.0/checksums.txt"
  run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no entry"* ]]
  [ ! -e "${TBX_INSTALL_DIR}/tbx" ]
}

@test "does not match a near-miss asset name" {
  sed 's/tbx-linux-x64"/tbx-linux-x64.deb"/' "${FIXTURES}/releases.json" >"${FIXTURES}/releases.new"
  mv "${FIXTURES}/releases.new" "${FIXTURES}/releases.json"
  run sh "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"No complete tbx-cli release"* ]]
  [[ "$output" == *"latest 100 releases"* ]]
  [ ! -e "${TBX_INSTALL_DIR}/tbx" ]
}

@test "works when piped to sh as documented" {
  run sh -c "cat '$SCRIPT' | sh -s -- transcribe"
  [ "$status" -eq 0 ]
  [ "$(cat "$TBX_TEST_LOG")" = "tbx install transcribe" ]
}

@test "a truncated script executes nothing" {
  local cut
  cut=$(grep -n 'installed .*install_dir' "$SCRIPT" | head -n 1 | cut -d: -f1)
  run sh -c "head -n $cut '$SCRIPT' | sh"
  [ ! -e "${TBX_INSTALL_DIR}/tbx" ]
  [ ! -e "${TBX_INSTALL_DIR}" ]
}
