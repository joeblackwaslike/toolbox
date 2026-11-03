#!/usr/bin/env bash
# Signs macOS binaries with a Developer ID Application identity, then notarizes them.
# Secrets come from the environment: MACOS_CERT_P12 (base64 .p12), MACOS_CERT_PASSWORD,
# NOTARY_KEY_P8 (App Store Connect API key, PEM text), NOTARY_KEY_ID, NOTARY_ISSUER_ID.
#
# Usage: sign-macos.sh <binary>...
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

die() {
  printf 'sign-macos: %s\n' "$2" >&2
  exit "$1"
}

[ $# -ge 1 ] || die 2 'Usage: sign-macos.sh <binary>...'
if [ "$(uname -s)" != Darwin ] && [ -z "${TBX_SIGN_ALLOW_ANY_OS:-}" ]; then
  die 2 'must run on macOS (codesign and notarytool are macOS-only)'
fi
for v in MACOS_CERT_P12 MACOS_CERT_PASSWORD NOTARY_KEY_P8 NOTARY_KEY_ID NOTARY_ISSUER_ID; do
  [ -n "${!v:-}" ] || die 2 "missing required environment variable: $v"
done
for bin in "$@"; do
  [ -f "$bin" ] || die 2 "not a file: $bin"
done

umask 077
work=$(mktemp -d)
keychain="${work}/signing.keychain-db"
orig_keychains=()
keychain_added=0

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$keychain_added" = 1 ] && [ "${#orig_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${orig_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work" || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keychain_list=$(security list-keychains -d user)
while IFS= read -r line; do
  line=${line#"${line%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}
  line=${line#\"}
  line=${line%\"}
  if [ -n "$line" ]; then orig_keychains+=("$line"); fi
done <<<"$keychain_list"

cat >"${work}/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
PLIST

printf '%s' "$MACOS_CERT_P12" | base64 --decode >"${work}/cert.p12"
printf '%s\n' "$NOTARY_KEY_P8" >"${work}/notary-key.p8"
chmod 600 "${work}/cert.p12" "${work}/notary-key.p8"

keychain_password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
security create-keychain -p "$keychain_password" "$keychain" >/dev/null
security set-keychain-settings -lut 3600 "$keychain" >/dev/null
security unlock-keychain -p "$keychain_password" "$keychain" >/dev/null
security import "${work}/cert.p12" -k "$keychain" -P "$MACOS_CERT_PASSWORD" \
  -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" \
  "$keychain" >/dev/null
keychain_added=1
security list-keychains -d user -s "$keychain" ${orig_keychains[@]+"${orig_keychains[@]}"} >/dev/null

identity=$(security find-identity -v -p codesigning "$keychain" |
  awk '/Developer ID Application/ { print $2; exit }')
[ -n "$identity" ] || die 1 'no "Developer ID Application" identity found in the imported certificate'

for bin in "$@"; do
  codesign --force --timestamp --options runtime \
    --entitlements "${work}/entitlements.plist" --keychain "$keychain" \
    --sign "$identity" "$bin"
  codesign --verify --strict --verbose=2 "$bin"
done

archive="${work}/tbx-notarize.zip"
stage="${work}/stage"
mkdir "$stage"
for bin in "$@"; do
  cp "$bin" "${stage}/"
done
ditto -c -k "$stage" "$archive"

submit_out="${work}/submit.out"
submit_rc=0
xcrun notarytool submit "$archive" --key "${work}/notary-key.p8" \
  --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait --timeout 20m >"$submit_out" 2>&1 || submit_rc=$?
cat "$submit_out"

submission_id=$(awk '$1 == "id:" { print $2; exit }' "$submit_out")
status=$(awk '$1 == "status:" { s = $2 } END { print s }' "$submit_out")

if [ "$status" != Accepted ]; then
  if [ -n "$submission_id" ]; then
    xcrun notarytool log "$submission_id" --key "${work}/notary-key.p8" \
      --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" || true
  fi
  die 1 "notarization did not succeed (status: ${status:-unknown}, exit ${submit_rc})"
fi
[ "$submit_rc" -eq 0 ] || die 1 "notarytool exited ${submit_rc} despite Accepted"
echo "sign-macos: notarization accepted (${submission_id})"
