#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  if [ -z "${TBX_TOOL_BIN:-}" ]; then
    skip "TBX_TOOL_BIN is not set; run this suite through 'tbx verify mdlink'"
  fi
  REPO="$(mktemp -d)"
  mkdir -p "$REPO/docs"
  touch "$REPO/docs/a.md"
  REPO="$(cd "$REPO" && pwd -P)"
}

teardown() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO"
}

@test "the built tool prints a root-relative link" {
  cd "$REPO"
  run --separate-stderr "$TBX_TOOL_BIN" --root "$REPO" docs/a.md:3-5
  [ "$status" -eq 0 ]
  [ "$output" = '[docs/a.md:3-5](docs/a.md#L3-L5)' ]
}

@test "the built tool prints the link as JSON with --json" {
  cd "$REPO"
  run --separate-stderr "$TBX_TOOL_BIN" --root "$REPO" --json docs/a.md
  [ "$status" -eq 0 ]
  [ "$output" = '"[docs/a.md](docs/a.md)"' ]
}

@test "the built tool exits 2 on a reversed line range" {
  cd "$REPO"
  run --separate-stderr "$TBX_TOOL_BIN" --root "$REPO" docs/a.md:5-3
  [ "$status" -eq 2 ]
  [ -z "$output" ]
}
