#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/upload-release-asset.sh"
  ASSETS="${BATS_TEST_TMPDIR}/release"
  UPLOADS="${BATS_TEST_TMPDIR}/uploads"
  BUILD="${BATS_TEST_TMPDIR}/build"
  mkdir -p "$ASSETS" "$BUILD"
  : >"$UPLOADS"
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$bin"
  cat >"${bin}/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$1" = release ] || exit 64
shift
[ "\$2" = t-v1.0.0 ] || { echo 'release not found' >&2; exit 1; }
case "\$1" in
  view) jq -n '{assets: \$ARGS.positional | map({name: .})}' --args \$(ls '$ASSETS') ;;
  upload) basename "\$3" >>'$UPLOADS'; cp "\$3" '$ASSETS/' ;;
  download) cp '$ASSETS'/"\$4" "\$6/" ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "${bin}/gh"
  PATH="${bin}:$PATH"
  printf 'tarball' >"${BUILD}/t-1.0.0.tar.gz"
  printf 'sum' >"${BUILD}/t-1.0.0.tar.gz.sha256"
}

@test "uploads assets the release does not have yet" {
  run "$SCRIPT" t-v1.0.0 "${BUILD}/t-1.0.0.tar.gz" "${BUILD}/t-1.0.0.tar.gz.sha256"
  [ "$status" -eq 0 ]
  [ "$(tr '\n' ' ' <"$UPLOADS")" = "t-1.0.0.tar.gz t-1.0.0.tar.gz.sha256 " ]
  cmp "${BUILD}/t-1.0.0.tar.gz" "${ASSETS}/t-1.0.0.tar.gz"
}

@test "skips an asset that is already uploaded with the same bytes" {
  cp "${BUILD}/t-1.0.0.tar.gz" "$ASSETS/"
  run "$SCRIPT" t-v1.0.0 "${BUILD}/t-1.0.0.tar.gz" "${BUILD}/t-1.0.0.tar.gz.sha256"
  [ "$status" -eq 0 ]
  [ "$(tr '\n' ' ' <"$UPLOADS")" = "t-1.0.0.tar.gz.sha256 " ]
}

@test "fails without replacing an existing asset whose bytes differ" {
  printf 'other' >"${ASSETS}/t-1.0.0.tar.gz"
  run --separate-stderr "$SCRIPT" t-v1.0.0 "${BUILD}/t-1.0.0.tar.gz"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"t-1.0.0.tar.gz"*"differs"* ]]
  [ "$(cat "${ASSETS}/t-1.0.0.tar.gz")" = other ]
  [ ! -s "$UPLOADS" ]
}

@test "fails when the release does not exist" {
  run "$SCRIPT" t-v9.9.9 "${BUILD}/t-1.0.0.tar.gz"
  [ "$status" -ne 0 ]
}

@test "rejects a call without files" {
  run "$SCRIPT" t-v1.0.0
  [ "$status" -eq 2 ]
}
