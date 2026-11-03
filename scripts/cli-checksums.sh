#!/usr/bin/env bash
# Prints checksums.txt for the four tbx binaries in <dir>: `<sha256>  <bare file name>` per line,
# the format install.sh and render-packaging.sh match exactly.
#
# Usage: cli-checksums.sh <dir>
set -euo pipefail

readonly ASSETS=(tbx-darwin-arm64 tbx-darwin-x64 tbx-linux-arm64 tbx-linux-x64)

[ $# -eq 1 ] || {
  echo 'usage: cli-checksums.sh <dir>' >&2
  exit 2
}
cd "$1"
for asset in "${ASSETS[@]}"; do
  [ -f "$asset" ] || {
    echo "cli-checksums: missing $asset in $1" >&2
    exit 1
  }
done
if command -v sha256sum >/dev/null; then
  sha256sum "${ASSETS[@]}"
else
  shasum -a 256 "${ASSETS[@]}"
fi
