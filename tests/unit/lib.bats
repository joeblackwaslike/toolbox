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

@test "tbx_result_json emits compact JSON when TBX_JSON=1" {
  run bash -c "source '$LIB'; TBX_JSON=1 tbx_result_json '{\"a\": 1}'"
  [ "$status" -eq 0 ]
  [ "$output" = '{"a":1}' ]
}

@test "tbx_result_json pretty-prints when TBX_JSON is unset" {
  run bash -c "source '$LIB'; tbx_result_json '{\"a\":1}'"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "{" ]
  [ "${lines[1]}" = '  "a": 1' ]
}

@test "tbx_result_json exits 65 with nothing on stdout for invalid JSON" {
  run --separate-stderr bash -c "source '$LIB'; tbx_result_json 'not json'"
  [ "$status" -eq 65 ]
  [ "$output" = "" ]
  [ -n "$stderr" ]
}

@test "tbx_result_json stdout holds only the JSON" {
  run --separate-stderr bash -c "source '$LIB'; TBX_JSON=1 tbx_result_json '[1,2]'"
  [ "$output" = "[1,2]" ]
  [ "$stderr" = "" ]
}

@test "tbx_result exits 69 with a clear message when jq is missing" {
  run --separate-stderr bash -c "source '$LIB'; PATH=/nonexistent; TBX_JSON=1 tbx_result hi"
  [ "$status" -eq 69 ]
  [[ "$stderr" == *jq* ]]
}

@test "tbx_info and tbx_error write nothing to stdout and the text to stderr" {
  run --separate-stderr bash -c "source '$LIB'; tbx_info hello; tbx_error bad"
  [ "$output" = "" ]
  [ "$stderr" = $'hello\nbad' ]
}

@test "tbx_die without arguments does not crash under set -u" {
  run --separate-stderr bash -c "set -u; source '$LIB'; tbx_die"
  [ "$status" -eq 1 ]
}
