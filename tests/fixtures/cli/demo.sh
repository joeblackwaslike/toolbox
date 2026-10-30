#!/usr/bin/env bash
# @file demo.sh
# @brief Shell build of the demo fixture tool: prints what the generated parser produced.

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=/dev/null
source "$here/../../../shared/sh/lib.sh"
# shellcheck source=/dev/null
source "$here/demo-parser.sh"

if [[ $TBX_ARG_SRC == fail ]]; then
  tbx_die 78 "error: failed on purpose"
fi

bool() { if [[ $1 == 1 ]]; then echo true; else echo false; fi; }

tbx_result_json "$(jq -cn \
  --arg src "$TBX_ARG_SRC" \
  --arg dest "$TBX_ARG_DEST" \
  --argjson verbose "$(bool "$TBX_OPT_VERBOSE")" \
  --arg mode "$TBX_OPT_MODE" \
  --arg count "$TBX_OPT_COUNT" \
  --arg inputs "$TBX_OPT_INPUTS" \
  --argjson json "$(bool "$TBX_JSON")" \
  --argjson interactive "$(bool "$TBX_INTERACTIVE")" \
  '{
    args: ({src: $src} + (if $dest == "" then {} else {dest: $dest} end)),
    opts: ({verbose: $verbose, mode: $mode}
      + (if $count == "" then {} else {count: ($count | tonumber)} end)
      + (if $inputs == "" then {} else {inputs: $inputs} end)),
    json: $json,
    interactive: $interactive
  }')"
