#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

URL="https://www.youtube.com/watch?v=5m0qiw062r8"

make_stub() {
  { printf '#!%s\n' "$(command -v bash)"; cat; } >"$STUBS/$1"
  chmod +x "$STUBS/$1"
}

setup() {
  if [ -z "${TBX_TOOL_BIN:-}" ]; then
    skip "TBX_TOOL_BIN is not set; run this suite through 'tbx verify transcribe'"
  fi
  STUBS="$(mktemp -d)"
  make_stub ffmpeg <<'STUB'
exit 0
STUB
  make_stub deno <<'STUB'
exit 0
STUB
  make_stub claude <<'STUB'
cat >/dev/null
printf '%s\n' '# Formatted'
STUB
  make_stub uvx <<'STUB'
case "$*" in
  *yt-dlp*)
    [[ ${STUB_FAIL:-} == download ]] && { echo "ytdlp boom" >&2; exit 1; }
    out=""
    prev=""
    for a in "$@"; do
      [[ $prev == --output ]] && out="$a"
      prev="$a"
    done
    printf 'fake-audio' >"${out/'%(ext)s'/mp3}"
    ;;
  *mlx_whisper*)
    outdir=""
    prev=""
    for a in "$@"; do
      [[ $prev == --output-dir ]] && outdir="$a"
      prev="$a"
    done
    printf 'hello world\n' >"$outdir/audio.txt"
    ;;
esac
STUB
}

teardown() {
  [ -z "${STUBS:-}" ] || rm -rf "$STUBS"
}

@test "--help and --help --json describe the same usage" {
  run --separate-stderr "$TBX_TOOL_BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: transcribe [options] <url>"* ]]
  local text="$output"
  run --separate-stderr "$TBX_TOOL_BIN" --help --json
  [ "$status" -eq 0 ]
  [ "$(jq -r .name <<<"$output")" = "transcribe" ]
  [[ "$text" == *"Usage: $(jq -r .usage <<<"$output")"* ]]
}

@test "prints the formatted markdown for a url" {
  PATH="$STUBS:$PATH" run --separate-stderr "$TBX_TOOL_BIN" -y "$URL"
  [ "$status" -eq 0 ]
  [ "$output" = "# Formatted" ]
}

@test "--json prints one object and nothing else on stdout" {
  PATH="$STUBS:$PATH" run --separate-stderr "$TBX_TOOL_BIN" -y --json "$URL"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  [ "$(jq -r .url <<<"$output")" = "$URL" ]
  [ "$(jq -r .markdown <<<"$output")" = "# Formatted" ]
}

@test "a failed download exits 1 with nothing on stdout" {
  STUB_FAIL=download PATH="$STUBS:$PATH" run --separate-stderr "$TBX_TOOL_BIN" -y "$URL"
  [ "$status" -eq 1 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"download failed"* ]]
}

@test "a missing url exits 2" {
  run --separate-stderr "$TBX_TOOL_BIN" -y
  [ "$status" -eq 2 ]
  [ "$output" = "" ]
}

@test "a missing dependency exits 69" {
  local bash_bin
  bash_bin="$(command -v bash)"
  mkdir "$STUBS/bare"
  ln -s "$bash_bin" "$STUBS/bare/bash"
  run --separate-stderr env PATH="$STUBS/bare" "$TBX_TOOL_BIN" -y "$URL"
  [ "$status" -eq 69 ]
  [ "$output" = "" ]
  [[ "$stderr" == *"missing dependency"* ]]
}
