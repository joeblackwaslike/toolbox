#!/usr/bin/env bash
# @file lib.sh
# @brief Shared helpers for tbx shell tools: errors and output.
# @description
#   Source this file. Set TBX_JSON=1 to make tbx_result print JSON.

# @description Print a message to stderr and exit with the given code.
# @arg $1 int Exit code.
# @arg $2 string Message.
# @exitcode $1 Always exits with the given code.
tbx_die() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# @description Print a result to stdout, as a JSON string when TBX_JSON=1.
# @arg $1 string Result text.
# @stdout The result.
tbx_result() {
  if [[ "${TBX_JSON:-}" == "1" ]]; then
    jq -n --arg v "$1" '$v'
  else
    printf '%s\n' "$1"
  fi
}
