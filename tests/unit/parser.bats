#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  DEMO="${BATS_TEST_DIRNAME}/../fixtures/cli/demo.sh"
  GOLDEN="${BATS_TEST_DIRNAME}/../fixtures/tools/demo/usage.json"
}

# Runs the demo with stdin held open by a pipe that never writes, so a prompt would hang
# until timeout kills it (exit 124).
demo_open() {
  timeout 10 bash "$DEMO" "$@" < <(sleep 30)
}

@test "exits 2 when a required argument is missing and -y is set" {
  run --separate-stderr demo_open -y
  [ "$status" -eq 2 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"missing required argument 'src'"* ]]
  [[ "$stderr" == *"Usage: demo [options] <src> [dest]"* ]]
}

@test "--json on a non-tty stdin prints valid JSON only to stdout" {
  run --separate-stderr demo_open in.txt --json -v --count 3
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  expected='{"args":{"src":"in.txt"},"opts":{"verbose":true,"mode":"fast","count":3},"json":true,"interactive":false}'
  [ "$(jq -cS . <<<"$output")" = "$(jq -cS . <<<"$expected")" ]
}

@test "--help --json output deep-equals the manifest-derived usage" {
  run --separate-stderr bash "$DEMO" --help --json
  [ "$status" -eq 0 ]
  [ "$(jq -cS . <<<"$output")" = "$(jq -cS . "$GOLDEN")" ]
}

@test "unknown flag exits 2" {
  run --separate-stderr bash "$DEMO" in.txt --bogus
  [ "$status" -eq 2 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"Usage: demo"* ]]
}

@test "exits 2 for a non-integer int option, a missing value and too many arguments" {
  run bash "$DEMO" in.txt --count many
  [ "$status" -eq 2 ]
  run bash "$DEMO" in.txt --mode
  [ "$status" -eq 2 ]
  run bash "$DEMO" a b c
  [ "$status" -eq 2 ]
}

@test "human help goes to stdout and exits 0 without required arguments" {
  run --separate-stderr bash "$DEMO" -h
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "Usage: demo [options] <src> [dest]" ]
  [[ "$output" == *"--no-input"* ]]
  [ "$stderr" = "" ]
}

@test "parses defaults, --opt=value, attached and combined short flags and --" {
  run bash "$DEMO" --json in.txt out.txt -mslow --count=2
  [ "$(jq -c .args <<<"$output")" = '{"src":"in.txt","dest":"out.txt"}' ]
  [ "$(jq -c .opts <<<"$output")" = '{"verbose":false,"mode":"slow","count":2}' ]
  run bash "$DEMO" --json -vy -- --not-a-flag
  [ "$(jq -c .args <<<"$output")" = '{"src":"--not-a-flag"}' ]
  [ "$(jq -c .opts.verbose <<<"$output")" = true ]
}

@test "a tool's own exit code passes through" {
  run --separate-stderr bash "$DEMO" fail
  [ "$status" -eq 78 ]
  [ "$output" = "" ]
}

@test "the generated parser runs under set -euo pipefail on bash 3.2 and current bash" {
  for shell in /bin/bash bash; do
    [ -x "$(command -v "$shell")" ] || continue
    run --separate-stderr "$shell" -c "set -euo pipefail; source '$DEMO' in.txt --json"
    [ "$status" -eq 0 ]
    [ "$(jq -c .args <<<"$output")" = '{"src":"in.txt"}' ]
    run --separate-stderr "$shell" -c "set -euo pipefail; source '$DEMO' --json -- in.txt"
    [ "$status" -eq 0 ]
    run --separate-stderr "$shell" -c "set -euo pipefail; source '$DEMO' -y"
    [ "$status" -eq 2 ]
  done
}

@test "interactive only on a tty without -y or --json" {
  on_tty() {
    if [[ "$(uname)" == Darwin ]]; then
      script -q /dev/null bash "$DEMO" "$@" </dev/null
    else
      script -qec "bash '$DEMO' $*" /dev/null </dev/null
    fi | tr -d '\r' | sed '1s/^[^{]*//'
  }
  [ "$(on_tty in.txt | jq -c .interactive)" = true ]
  [ "$(on_tty in.txt -y | jq -c .interactive)" = false ]
  [ "$(on_tty in.txt --no-input | jq -c .interactive)" = false ]
  [ "$(on_tty in.txt --json | jq -c .interactive)" = false ]
  run bash "$DEMO" in.txt
  [ "$(jq -c .interactive <<<"$output")" = false ]
}
