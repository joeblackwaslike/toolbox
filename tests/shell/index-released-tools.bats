#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/index-released-tools.sh"
  RELEASES="${BATS_TEST_TMPDIR}/releases"
  INDEXED="${BATS_TEST_TMPDIR}/indexed"
  mkdir -p "$RELEASES"
  : >"$INDEXED"
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$bin"
  cat >"${bin}/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$1" = release ] || exit 64
dir='$RELEASES'/"\$3"
[ -d "\$dir" ] || { echo 'release not found' >&2; exit 1; }
case "\$2" in
  view) jq -n '{assets: \$ARGS.positional | map({name: .})}' --args \$(ls "\$dir") ;;
  download)
    [ "\$4" = --pattern ] && [ "\$6" = --output ] && [ "\$7" = - ] || exit 64
    cat "\$dir/\$5" ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "${bin}/gh"
  cat >"${bin}/fake-publish-index" <<EOF
#!/usr/bin/env bash
echo "\$*" >>'$INDEXED'
EOF
  chmod +x "${bin}/fake-publish-index"
  PATH="${bin}:$PATH"
  export TBX_PUBLISH_INDEX="${bin}/fake-publish-index" GH_REPO=o/r
}

sum_of() {
  printf '%s' "$1" | shasum -a 256 | cut -d ' ' -f 1
}

release_tool() {
  local name=$1 version=$2 dir="${RELEASES}/${1}-v${2}" file="${1}-${2}.tar.gz"
  mkdir -p "$dir"
  printf '%s' "$name" >"${dir}/${file}"
  printf '%s  %s\n' "$(sum_of "$name")" "$file" >"${dir}/${file}.sha256"
}

tools_json() {
  local args=() entry
  for entry in "$@"; do args+=("$entry"); done
  jq -nc '$ARGS.positional | map(split(" ") | {component: .[0], version: .[1], tag: "\(.[0])-v\(.[1])", kind: "tool"})' \
    --args "${args[@]}"
}

@test "indexes every released tool with its tarball URL and checksum" {
  release_tool alpha 1.0.0
  release_tool beta 0.2.0
  run --separate-stderr "$SCRIPT" "$(tools_json 'alpha 1.0.0' 'beta 0.2.0')"
  [ "$status" -eq 0 ]
  [ "$(sed -n 1p "$INDEXED")" = "alpha 1.0.0 https://github.com/o/r/releases/download/alpha-v1.0.0/alpha-1.0.0.tar.gz $(sum_of alpha)" ]
  [ "$(sed -n 2p "$INDEXED")" = "beta 0.2.0 https://github.com/o/r/releases/download/beta-v0.2.0/beta-0.2.0.tar.gz $(sum_of beta)" ]
}

@test "skips a tool whose tarball is missing, indexes the rest, then fails naming it" {
  release_tool alpha 1.0.0
  release_tool beta 0.2.0
  release_tool gamma 3.0.0
  rm "${RELEASES}/beta-v0.2.0/beta-0.2.0.tar.gz"
  run --separate-stderr "$SCRIPT" "$(tools_json 'alpha 1.0.0' 'beta 0.2.0' 'gamma 3.0.0')"
  [ "$status" -eq 1 ]
  [ "$(cut -d ' ' -f 1 "$INDEXED" | tr '\n' ' ')" = "alpha gamma " ]
  [[ "$stderr" == *beta-v0.2.0* ]]
  [[ "$stderr" != *alpha-v1.0.0* ]]
}

@test "skips a tool whose checksum asset is missing" {
  release_tool alpha 1.0.0
  release_tool beta 0.2.0
  rm "${RELEASES}/alpha-v1.0.0/alpha-1.0.0.tar.gz.sha256"
  run --separate-stderr "$SCRIPT" "$(tools_json 'alpha 1.0.0' 'beta 0.2.0')"
  [ "$status" -eq 1 ]
  [ "$(cut -d ' ' -f 1 "$INDEXED")" = beta ]
  [[ "$stderr" == *alpha-v1.0.0* ]]
}

@test "skips a tool whose release does not exist" {
  release_tool alpha 1.0.0
  run --separate-stderr "$SCRIPT" "$(tools_json 'alpha 1.0.0' 'beta 0.2.0')"
  [ "$status" -eq 1 ]
  [ "$(cut -d ' ' -f 1 "$INDEXED")" = alpha ]
  [[ "$stderr" == *beta-v0.2.0* ]]
}

@test "does nothing for an empty tool list" {
  run --separate-stderr "$SCRIPT" '[]'
  [ "$status" -eq 0 ]
  [ ! -s "$INDEXED" ]
}

@test "rejects a call without the tool list" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
}
