#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  LIB="${BATS_TEST_DIRNAME}/../../shared/sh/lib.sh"
}

@test "tbx_die exits with the given code and writes to stderr" {
  run --separate-stderr bash -c "source '$LIB'; tbx_die 78 'bad config'"
  [ "$status" -eq 78 ]
  [ "$output" = "" ]
  [ "$stderr" = "bad config" ]
}

@test "tbx_result prints text to stdout by default" {
  run bash -c "source '$LIB'; tbx_result hello"
  [ "$status" -eq 0 ]
  [ "$output" = "hello" ]
}

@test "tbx_result prints a JSON string when TBX_JSON=1" {
  run bash -c "source '$LIB'; TBX_JSON=1 tbx_result hello"
  [ "$status" -eq 0 ]
  [ "$output" = '"hello"' ]
}
