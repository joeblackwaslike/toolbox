#!/usr/bin/env bats

setup() {
  ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  SCRIPT="${ROOT}/scripts/sign-macos.sh"
  WORK="${BATS_TEST_TMPDIR}"
  FAKEBIN="${WORK}/fakebin"
  mkdir -p "$FAKEBIN"
  export FAKE_LOG="${WORK}/calls.log"
  export FAKE_STATE="${WORK}/keychains"
  : >"$FAKE_LOG"
  printf '    "/Users/x/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n' >"$FAKE_STATE"

  cat >"${FAKEBIN}/security" <<'FAKE'
#!/usr/bin/env bash
echo "security $*" >>"$FAKE_LOG"
case "$1" in
list-keychains)
  if [ "$3" = "-s" ]; then
    shift 3
    : >"$FAKE_STATE"
    for k in "$@"; do printf '    "%s"\n' "$k" >>"$FAKE_STATE"; done
  else
    cat "$FAKE_STATE"
  fi
  ;;
find-identity)
  echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Joe Black (TEAM123456)"'
  echo '     1 valid identities found'
  ;;
esac
exit 0
FAKE
  cat >"${FAKEBIN}/codesign" <<'FAKE'
#!/usr/bin/env bash
echo "codesign $*" >>"$FAKE_LOG"
prev=
for a in "$@"; do
  [ "$prev" = --entitlements ] && cat "$a" >"${FAKE_LOG}.ent"
  prev=$a
done
exit 0
FAKE
  cat >"${FAKEBIN}/ditto" <<'FAKE'
#!/usr/bin/env bash
echo "ditto $*" >>"$FAKE_LOG"
for a in "$@"; do last=$a; done
: >"$last"
FAKE
  cat >"${FAKEBIN}/xcrun" <<'FAKE'
#!/usr/bin/env bash
echo "xcrun $*" >>"$FAKE_LOG"
prev=
for a in "$@"; do
  if [ "$prev" = --key ]; then
    ls -l "$a" | cut -c1-10 >>"${FAKE_LOG}.keymode"
    cat "$a" >"${FAKE_LOG}.keycontent"
  fi
  prev=$a
done
case "$2" in
submit)
  echo "Conducting pre-submission checks"
  echo "  id: 11111111-2222-3333-4444-555555555555"
  echo "  status: ${FAKE_NOTARY_STATUS:-Accepted}"
  ;;
log) echo "NOTARY-LOG-BODY issues: bad thing" ;;
esac
exit 0
FAKE
  chmod +x "$FAKEBIN"/*
  PATH="${FAKEBIN}:${PATH}"
  export PATH

  export TBX_SIGN_ALLOW_ANY_OS=1
  export MACOS_CERT_P12="U0VDUkVUUDEyREFUQQ=="
  export MACOS_CERT_PASSWORD="p12-pass-SECRET"
  export NOTARY_KEY_P8=$'-----BEGIN PRIVATE KEY-----\nSECRETP8LINE\n-----END PRIVATE KEY-----'
  export NOTARY_KEY_ID="KEYID-SECRET"
  export NOTARY_ISSUER_ID="issuer-SECRET-uuid"

  BIN="${WORK}/tbx-darwin-arm64"
  BIN2="${WORK}/tbx-darwin-x64"
  echo one >"$BIN"
  echo two >"$BIN2"
}

line_no() { grep -n -m1 -- "$1" "$FAKE_LOG" | cut -d: -f1; }

@test "no arguments exits non-zero with usage" {
  run "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "refuses to run on a non-macOS host" {
  unset TBX_SIGN_ALLOW_ANY_OS
  uname_os=$(uname -s)
  [ "$uname_os" = Darwin ] && skip "running on macOS"
  run "$SCRIPT" "$BIN"
  [ "$status" -ne 0 ]
  [[ "$output" == *"macOS"* ]]
}

@test "each missing variable fails fast and is named" {
  for v in MACOS_CERT_P12 MACOS_CERT_PASSWORD NOTARY_KEY_P8 NOTARY_KEY_ID NOTARY_ISSUER_ID; do
    run env -u "$v" "$SCRIPT" "$BIN"
    [ "$status" -ne 0 ]
    [[ "$output" == *"$v"* ]]
  done
  [ ! -s "$FAKE_LOG" ]
}

@test "signs, verifies and notarizes in order" {
  run "$SCRIPT" "$BIN" "$BIN2"
  [ "$status" -eq 0 ]
  create=$(line_no "security create-keychain")
  import=$(line_no "security import")
  part=$(line_no "security set-key-partition-list")
  ident=$(line_no "security find-identity -v -p codesigning")
  sign=$(line_no "codesign --force")
  verify=$(line_no "codesign --verify --strict --verbose=2")
  zip=$(line_no "ditto")
  submit=$(line_no "xcrun notarytool submit")
  [ "$create" -lt "$import" ]
  [ "$import" -lt "$part" ]
  [ "$part" -lt "$ident" ]
  [ "$ident" -lt "$sign" ]
  [ "$sign" -lt "$verify" ]
  [ "$verify" -lt "$zip" ]
  [ "$zip" -lt "$submit" ]
  grep -q -- "security import .* -T /usr/bin/codesign" "$FAKE_LOG"
  grep -q -- "set-key-partition-list -S apple-tool:,apple: -s" "$FAKE_LOG"
  [ "$(grep -c '^codesign --force' "$FAKE_LOG")" -eq 2 ]
  grep -q -- "--timestamp --options runtime --entitlements .* --sign 0123456789ABCDEF" "$FAKE_LOG"
  grep -q -- "--wait" "$FAKE_LOG"
  grep -q -- "--key-id KEYID-SECRET --issuer issuer-SECRET-uuid" "$FAKE_LOG"
}

@test "entitlements are the five Bun-documented keys" {
  run "$SCRIPT" "$BIN"
  [ "$status" -eq 0 ]
  for k in allow-jit allow-unsigned-executable-memory disable-executable-page-protection \
    allow-dyld-environment-variables disable-library-validation; do
    grep -q "com.apple.security.cs.${k}</key>" "${FAKE_LOG}.ent"
  done
}

@test "p8 is written with mode 600 and holds the key text" {
  run "$SCRIPT" "$BIN"
  [ "$status" -eq 0 ]
  [ "$(cat "${FAKE_LOG}.keymode")" = "-rw-------" ]
  grep -q SECRETP8LINE "${FAKE_LOG}.keycontent"
}

@test "success deletes the keychain and restores the search list" {
  run "$SCRIPT" "$BIN"
  [ "$status" -eq 0 ]
  grep -q "^security delete-keychain" "$FAKE_LOG"
  [ "$(cat "$FAKE_STATE")" = $'    "/Users/x/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"' ]
}

@test "Invalid notarization exits non-zero, prints the log and still cleans up" {
  FAKE_NOTARY_STATUS=Invalid run "$SCRIPT" "$BIN"
  [ "$status" -ne 0 ]
  [[ "$output" == *"NOTARY-LOG-BODY"* ]]
  grep -q "xcrun notarytool log 11111111-2222-3333-4444-555555555555" "$FAKE_LOG"
  grep -q "^security delete-keychain" "$FAKE_LOG"
  [ "$(wc -l <"$FAKE_STATE" | tr -d ' ')" = 2 ]
}

@test "signing failure still deletes the keychain and restores the list" {
  printf '#!/usr/bin/env bash\necho "codesign $*" >>"$FAKE_LOG"\nexit 1\n' >"${FAKEBIN}/codesign"
  run "$SCRIPT" "$BIN"
  [ "$status" -ne 0 ]
  grep -q "^security delete-keychain" "$FAKE_LOG"
  [ "$(wc -l <"$FAKE_STATE" | tr -d ' ')" = 2 ]
  ! grep -q "notarytool submit" "$FAKE_LOG"
}

@test "no secret reaches output; argv carries only the p12 password (import) and notary ids" {
  run "$SCRIPT" "$BIN"
  [ "$status" -eq 0 ]
  for s in "$MACOS_CERT_P12" SECRETP8LINE; do
    [[ "$output" != *"$s"* ]]
    ! grep -q -- "$s" "$FAKE_LOG"
  done
  [[ "$output" != *"KEYID-SECRET"* && "$output" != *"issuer-SECRET-uuid"* ]]
  [[ "$output" != *"p12-pass-SECRET"* ]]
  [ "$(grep -c -- 'p12-pass-SECRET' "$FAKE_LOG")" -eq 1 ]
  grep -- 'p12-pass-SECRET' "$FAKE_LOG" | grep -q '^security import'
}
