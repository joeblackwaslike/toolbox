#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$(cd "${BATS_TEST_DIRNAME}/../../scripts" && pwd)/render-packaging.sh"
  OUT="${BATS_TEST_TMPDIR}/out"
  SUMS="${BATS_TEST_TMPDIR}/checksums.txt"
  for pair in darwin-arm64:1 darwin-x64:2 linux-arm64:3 linux-x64:4; do
    printf '%s  tbx-%s\n' "$(printf "${pair##*:}%.0s" {1..64})" "${pair%%:*}"
  done >"$SUMS"
}

@test "renders every package with the version and all four checksums" {
  run "$SCRIPT" 1.2.3 "$SUMS" "$OUT"
  [ "$status" -eq 0 ]
  for f in npm/package.json pypi/pyproject.toml pypi/src/tbx_cli/_checksums.py homebrew/tbx-cli.rb nfpm-amd64.yaml nfpm-arm64.yaml; do
    [ -f "$OUT/$f" ]
    grep -q '1\.2\.3' "$OUT/$f"
  done
  for f in npm/package.json pypi/src/tbx_cli/_checksums.py homebrew/tbx-cli.rb; do
    for d in 1 2 3 4; do
      grep -q "$(printf "${d}%.0s" {1..64})" "$OUT/$f"
    done
  done
  [ -x "$OUT/npm/bin/tbx.js" ]
  [ -f "$OUT/pypi/src/tbx_cli/__main__.py" ]
}

@test "leaves no unreplaced markers" {
  "$SCRIPT" 1.2.3 "$SUMS" "$OUT"
  run grep -rF '{{' "$OUT"
  [ "$status" -eq 1 ]
}

@test "nfpm configs differ by arch and source binary" {
  "$SCRIPT" 1.2.3 "$SUMS" "$OUT"
  grep -q 'arch: amd64' "$OUT/nfpm-amd64.yaml"
  grep -q 'tbx-linux-x64' "$OUT/nfpm-amd64.yaml"
  grep -q 'arch: arm64' "$OUT/nfpm-arm64.yaml"
  grep -q 'tbx-linux-arm64' "$OUT/nfpm-arm64.yaml"
}

@test "rejects a bad version" {
  run "$SCRIPT" 1.2 "$SUMS" "$OUT"
  [ "$status" -ne 0 ]
  [ ! -e "$OUT" ]
}

@test "rejects a checksums file missing an asset" {
  grep -v linux-x64 "$SUMS" >"${SUMS}.short"
  run "$SCRIPT" 1.2.3 "${SUMS}.short" "$OUT"
  [ "$status" -ne 0 ]
}

@test "rejects a malformed checksum" {
  awk 'NR==1{sub(/^1/,"z")}1' "$SUMS" >"${SUMS}.bad"
  run "$SCRIPT" 1.2.3 "${SUMS}.bad" "$OUT"
  [ "$status" -ne 0 ]
}

@test "rejects wrong argument count" {
  run "$SCRIPT" 1.2.3
  [ "$status" -ne 0 ]
}
