#!/usr/bin/env bash
# @file lib.sh
# @brief Shared helpers for tbx shell tools: errors and output.
# @description
#   Source this file. Set TBX_JSON=1 to make tbx_result and tbx_result_json print JSON.
#   Exit codes: 65 invalid JSON input, 69 jq missing.

# @description Print an informational message to stderr.
# @arg $@ string Message.
tbx_info() {
  printf '%s\n' "$*" >&2
}

# @description Print an error message to stderr.
# @arg $@ string Message.
tbx_error() {
  printf '%s\n' "$*" >&2
}

# @description Print a message to stderr and exit with the given code.
# @arg $1 int Exit code (default 1).
# @arg $@ string Message.
# @exitcode $1 Always exits with the given code.
tbx_die() {
  local code="${1:-1}"
  shift || true
  tbx_error "$*"
  exit "$code"
}

_tbx_need_jq() {
  command -v jq >/dev/null 2>&1 || tbx_die 69 "jq is required but not installed"
}

# @description Print text to stdout. With TBX_JSON=1 the text is emitted as a JSON string.
# @arg $1 string Result text.
# @stdout The result.
tbx_result() {
  if [[ "${TBX_JSON:-}" == "1" ]]; then
    _tbx_need_jq
    jq -n --arg v "$1" '$v'
  else
    printf '%s\n' "$1"
  fi
}

# @description Validate a JSON document and print it: compact with TBX_JSON=1, pretty otherwise.
# @arg $1 string JSON document.
# @stdout The JSON document.
# @exitcode 65 Input is not valid JSON; nothing is written to stdout.
# @exitcode 69 jq is not installed.
tbx_result_json() {
  _tbx_need_jq
  local flags=()
  [[ "${TBX_JSON:-}" == "1" ]] && flags=(-c)
  local rendered
  rendered=$(printf '%s' "$1" | jq "${flags[@]}" .) || tbx_die 65 "invalid JSON"
  printf '%s\n' "$rendered"
}
