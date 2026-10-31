#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

URL="https://www.youtube.com/watch?v=5m0qiw062r8"

make_stub() {
  { printf '#!%s\n' "$BASH_BIN"; cat; } >"$STUBS/$1"
  chmod +x "$STUBS/$1"
}

install_stubs() {
  rm -f "$STUBS"/*
  make_stub ffmpeg <<'STUB'
exit 0
STUB
  make_stub deno <<'STUB'
exit 0
STUB
  make_stub claude <<'STUB'
echo "claude $*" >>"$STUB_LOG"
printf '%s\n' "$@" >"$STUB_CLAUDE_ARGS"
cat >"$STUB_CLAUDE_STDIN"
[[ ${STUB_CLAUDE_MODE:-ok} == fail ]] && { echo "claude boom" >&2; exit 1; }
printf '%s\n' "${STUB_CLAUDE_OUTPUT:-# Formatted}"
STUB
  make_stub uvx <<'STUB'
echo "uvx $*" >>"$STUB_LOG"
case "$*" in
  *yt-dlp*)
    echo "yt-dlp stdout noise"
    out=""
    prev=""
    for a in "$@"; do
      [[ $prev == --output ]] && out="$a"
      prev="$a"
    done
    case "${STUB_YTDLP_MODE:-ok}" in
      fail_cookies)
        if [[ "$*" == *--cookies-from-browser* ]]; then
          echo "cookie boom" >&2
          exit 1
        fi
        ;;
      fail_always)
        echo "ytdlp boom" >&2
        exit 1
        ;;
      no_file)
        exit 0
        ;;
    esac
    printf 'fake-audio' >"${out/'%(ext)s'/mp3}"
    ;;
  *mlx_whisper*)
    echo "whisper stdout noise"
    [[ ${STUB_WHISPER_MODE:-ok} == fail ]] && { echo "whisper boom" >&2; exit 1; }
    audio=""
    outdir=""
    prev=""
    for a in "$@"; do
      if [[ $prev == mlx_whisper ]]; then audio="$a"; fi
      if [[ $prev == --output-dir ]]; then outdir="$a"; fi
      prev="$a"
    done
    base="${audio##*/}"; base="${base%.mp3}"
    if [[ ${STUB_WHISPER_MODE:-ok} == empty ]]; then
      : >"$outdir/$base.txt"
    else
      printf '%s\n' "${STUB_TRANSCRIPT:-hello world transcript}" >"$outdir/$base.txt"
    fi
    ;;
esac
STUB
}

# Runs a command with a background watchdog that kills it after $1 seconds, without
# depending on the GNU-only `timeout` binary (absent on macOS by default).
with_deadline() {
  local secs=$1
  shift
  "$@" <&0 &
  local cmd_pid=$!
  sleep "$secs" 2>/dev/null &
  local sleep_pid=$!
  (wait "$sleep_pid" 2>/dev/null && kill -TERM "$cmd_pid" 2>/dev/null) &
  local watcher_pid=$!
  local status=0
  wait "$cmd_pid" 2>/dev/null || status=$?
  kill "$sleep_pid" "$watcher_pid" 2>/dev/null
  wait "$sleep_pid" "$watcher_pid" 2>/dev/null
  return "$status"
}

setup() {
  TOOL="${BATS_TEST_DIRNAME}/../../src/transcribe"
  BASH_BIN="$(command -v bash)"
  T="$(mktemp -d)"
  STUBS="$T/stubs"
  BASE="$T/base"
  TMPROOT="$T/tmp"
  LOG="$T/calls.log"
  mkdir -p "$STUBS" "$BASE" "$TMPROOT"
  : >"$LOG"
  local cmd
  for cmd in mktemp rm cat dirname bun jq; do
    ln -s "$(command -v "$cmd")" "$BASE/$cmd"
  done
  install_stubs
  export STUB_LOG="$LOG"
  export STUB_CLAUDE_STDIN="$T/claude_stdin"
  export STUB_CLAUDE_ARGS="$T/claude_args"
  unset STUB_YTDLP_MODE STUB_WHISPER_MODE STUB_CLAUDE_MODE STUB_CLAUDE_OUTPUT STUB_TRANSCRIPT
}

teardown() {
  rm -rf "$T"
}

run_tool() {
  run --separate-stderr env PATH="$STUBS:$BASE" TMPDIR="$TMPROOT" "$BASH_BIN" "$TOOL" "$@" </dev/null
}

count_calls() {
  local n
  n="$(grep -cF -- "$1" "$LOG" || true)"
  printf '%s' "${n:-0}"
}

@test "no arguments exits 2 with usage and starts nothing" {
  run_tool
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"Usage: transcribe"* ]]
  [ "$output" = "" ]
  [ "$(count_calls uvx)" = "0" ]
}

@test "extra arguments exit 2 with usage" {
  run_tool "$URL" extra
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"too many arguments"* ]]
  [[ "$stderr" == *"Usage: transcribe"* ]]
}

@test "missing url exits 2 with nothing on stdout" {
  run_tool --json
  [ "$status" -eq 2 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"missing required argument 'url'"* ]]
}

@test "each missing dependency exits 69 before downloading" {
  local cmd
  for cmd in uvx ffmpeg deno claude; do
    install_stubs
    rm -f "$STUBS/$cmd"
    : >"$LOG"
    run_tool "$URL"
    [ "$status" -eq 69 ]
    [[ "$stderr" == *"missing dependency: $cmd"* ]]
    [ "$(count_calls yt-dlp)" = "0" ]
  done
}

@test "missing claude exits 69 with a clear message and empty stdout" {
  rm -f "$STUBS/claude"
  run_tool "$URL"
  [ "$status" -eq 69 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"missing dependency: claude"* ]]
}

@test "stdout is only the claude output" {
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = "# Formatted" ]
}

@test "tool noise goes to stderr" {
  run_tool "$URL"
  [[ "$stderr" == *"yt-dlp stdout noise"* ]]
  [[ "$stderr" == *"whisper stdout noise"* ]]
}

@test "yt-dlp gets its robust flags" {
  run_tool "$URL"
  local calls
  calls="$(<"$LOG")"
  [[ "$calls" == *"yt-dlp[default]"* ]]
  [[ "$calls" == *"bestaudio/best"* ]]
  [[ "$calls" == *"--remote-components ejs:github"* ]]
  [[ "$calls" == *"--cookies-from-browser chrome"* ]]
  [[ "$calls" == *"$URL"* ]]
}

@test "a cookie failure retries without cookies" {
  export STUB_YTDLP_MODE=fail_cookies
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = "# Formatted" ]
  [[ "$stderr" == *"retrying without browser cookies"* ]]
  [ "$(grep -F 'yt-dlp[default]' "$LOG" | grep -vcF -- '--cookies-from-browser' || true)" = "1" ]
}

@test "a download failure aborts before transcription" {
  export STUB_YTDLP_MODE=fail_always
  run_tool "$URL"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"download failed"* ]]
  [ "$output" = "" ]
  [ "$(count_calls mlx_whisper)" = "0" ]
  [ "$(count_calls claude)" = "0" ]
}

@test "a missing audio file is reported" {
  export STUB_YTDLP_MODE=no_file
  run_tool "$URL"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"no audio file produced"* ]]
  [ "$(count_calls mlx_whisper)" = "0" ]
}

@test "a transcription failure aborts before claude" {
  export STUB_WHISPER_MODE=fail
  run_tool "$URL"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"transcription failed"* ]]
  [ "$(count_calls claude)" = "0" ]
}

@test "an empty transcript aborts before claude" {
  export STUB_WHISPER_MODE=empty
  run_tool "$URL"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"empty transcript"* ]]
  [ "$(count_calls claude)" = "0" ]
}

@test "claude receives the prompt as the system prompt and the transcript on stdin" {
  export STUB_TRANSCRIPT="the quick brown fox"
  run_tool "$URL"
  [ "$status" -eq 0 ]
  local -a args=()
  local line
  while IFS= read -r line; do args+=("$line"); done <"$STUB_CLAUDE_ARGS"
  [ "${#args[@]}" -eq 9 ]
  [ "${args[0]}" = "-p" ]
  [ "${args[1]}" = "--tools" ]
  [ "${args[2]}" = "" ]
  [ "${args[3]}" = "--setting-sources" ]
  [ "${args[4]}" = "" ]
  [ "${args[5]}" = "--strict-mcp-config" ]
  [ "${args[6]}" = "--no-session-persistence" ]
  [ "${args[7]}" = "--system-prompt" ]
  [[ "${args[8]}" == "Reformat the following audio transcript"* ]]
  [[ "$(<"$STUB_CLAUDE_STDIN")" == *"the quick brown fox"* ]]
}

@test "claude never runs without every tool disabled" {
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$(count_calls claude)" = "1" ]
  local -a args=()
  local line
  while IFS= read -r line; do args+=("$line"); done <"$STUB_CLAUDE_ARGS"
  local i tools=0
  for i in "${!args[@]}"; do
    if [ "${args[$i]}" = "--tools" ]; then
      tools=$((tools + 1))
      [ "${args[$((i + 1))]}" = "" ]
    fi
  done
  [ "$tools" -eq 1 ]
  [ "$(grep -c '^claude ' "$LOG")" = "$(grep -c '^claude -p --tools  --setting-sources  ' "$LOG")" ]
}

@test "yt-dlp and mlx-whisper run at pinned versions" {
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$(grep -cF -- "uvx --from yt-dlp[default]==2026.8.19 yt-dlp " "$LOG")" = "1" ]
  [ "$(grep -cF -- "uvx --from mlx-whisper==0.4.3 mlx_whisper " "$LOG")" = "1" ]
  [ "$(grep -c '^uvx ' "$LOG")" = "2" ]
}

@test "a claude failure propagates" {
  export STUB_CLAUDE_MODE=fail
  run_tool "$URL"
  [ "$status" -ne 0 ]
}

@test "the temp dir is removed on success" {
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$TMPROOT")" ]
}

@test "the temp dir is removed on failure" {
  export STUB_YTDLP_MODE=fail_always
  run_tool "$URL"
  [ "$status" -ne 0 ]
  [ -z "$(ls -A "$TMPROOT")" ]
}

@test "a markdown fence wrapper is stripped" {
  export STUB_CLAUDE_OUTPUT=$'```markdown\n# Title\n\nBody\n```'
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = $'# Title\n\nBody' ]
}

@test "a bare fence wrapper is stripped" {
  export STUB_CLAUDE_OUTPUT=$'```\n# Title\n\nBody\n```'
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = $'# Title\n\nBody' ]
}

@test "inner code blocks survive the wrapper strip" {
  export STUB_CLAUDE_OUTPUT=$'```markdown\n# Title\n\n```python\nx = 1\n```\n\nBody\n```'
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = $'# Title\n\n```python\nx = 1\n```\n\nBody' ]
}

@test "unfenced output with a code block is untouched" {
  export STUB_CLAUDE_OUTPUT=$'# Title\n\n```python\nx = 1\n```'
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = $'# Title\n\n```python\nx = 1\n```' ]
}

@test "an unclosed fence is untouched" {
  export STUB_CLAUDE_OUTPUT=$'```markdown\n# Title\n\nBody'
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = $'```markdown\n# Title\n\nBody' ]
}

@test "fence stripping still propagates a claude failure" {
  export STUB_CLAUDE_MODE=fail
  export STUB_CLAUDE_OUTPUT=$'```markdown\n# Title\n```'
  run_tool "$URL"
  [ "$status" -ne 0 ]
}

@test "--json prints one object with the url and the markdown" {
  export STUB_CLAUDE_OUTPUT=$'# Title\n\nBody'
  run_tool "$URL" --json
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  [ "$(jq -r .url <<<"$output")" = "$URL" ]
  [ "$(jq -r .markdown <<<"$output")" = $'# Title\n\nBody' ]
  [ "$(jq -r 'keys | join(",")' <<<"$output")" = "markdown,url" ]
  [[ "$stderr" == *"whisper stdout noise"* ]]
}

@test "--json failures keep stdout empty" {
  export STUB_YTDLP_MODE=fail_always
  run_tool "$URL" --json
  [ "$status" -ne 0 ]
  [ "$output" = "" ]
}

@test "-y never prompts" {
  run --separate-stderr with_deadline 20 env PATH="$STUBS:$BASE" TMPDIR="$TMPROOT" "$BASH_BIN" "$TOOL" -y "$URL" < <(sleep 25)
  [ "$status" -eq 0 ]
  [ "$output" = "# Formatted" ]
}

@test "-y with the url missing exits 2 instead of waiting" {
  run --separate-stderr with_deadline 20 env PATH="$STUBS:$BASE" TMPDIR="$TMPROOT" "$BASH_BIN" "$TOOL" -y < <(sleep 25)
  [ "$status" -eq 2 ]
}

@test "both yt-dlp calls pass the url after --" {
  export STUB_YTDLP_MODE=fail_cookies
  run_tool "$URL"
  [ "$status" -eq 0 ]
  [ "$(grep -F 'yt-dlp[default]' "$LOG" | grep -cF -- "-- $URL" || true)" = "2" ]
  [ "$(grep -F 'yt-dlp[default]' "$LOG" | grep -cF -- "chrome -- $URL" || true)" = "1" ]
}

@test "a url starting with a dash is passed after -- and not as an option" {
  run_tool -- --exec=evil
  [ "$(grep -F 'yt-dlp[default]' "$LOG" | grep -cF -- " -- --exec=evil" || true)" -ge "1" ]
  [ "$(grep -F 'yt-dlp[default]' "$LOG" | grep -F -- "--exec=evil" | grep -cvF -- " -- --exec=evil" || true)" = "0" ]
}

@test "--json without jq exits 69 before any download" {
  rm -f "$BASE/jq"
  run_tool "$URL" --json
  [ "$status" -eq 69 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"missing dependency: jq"* ]]
  [ "$(count_calls yt-dlp)" = "0" ]
}
