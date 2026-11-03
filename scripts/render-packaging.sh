#!/usr/bin/env bash
# Renders the npm, PyPI, Homebrew and nfpm packaging for one tbx-cli release.
#
# Usage: render-packaging.sh <version> <checksums.txt> <outdir>
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || {
  echo "render-packaging.sh needs bash >= 4.4" >&2
  exit 1
}

readonly ASSETS=(tbx-darwin-arm64 tbx-darwin-x64 tbx-linux-arm64 tbx-linux-x64)

die() {
  printf 'render-packaging: %s\n' "$2" >&2
  exit "$1"
}

[ $# -eq 3 ] || die 2 'usage: render-packaging.sh <version> <checksums.txt> <outdir>'
version=$1 sums=$2 out=$3
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die 2 "invalid version: $version"
[ -f "$sums" ] || die 2 "checksums file not found: $sums"

[ -z "$(ls -A "$out" 2>/dev/null)" ] || die 2 "output directory is not empty: $out"

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/../packaging" && pwd)

declare -A hash
for asset in "${ASSETS[@]}"; do
  h=$(awk -v n="$asset" 'NF == 2 && $2 == n { print $1 }' "$sums")
  [[ $h =~ ^[0-9a-f]{64}$ ]] || die 2 "missing or malformed sha256 for $asset in $sums"
  hash[$asset]=$h
done

render() {
  local template=$1 dest=$2 arch=${3:-} asset_arch=${4:-} content key
  content=$(<"$template")
  content=${content//'{{VERSION}}'/$version}
  content=${content//'{{ARCH}}'/$arch}
  content=${content//'{{ASSET_ARCH}}'/$asset_arch}
  for asset in "${ASSETS[@]}"; do
    key=${asset^^}
    content=${content//"{{SHA_${key//-/_}}}"/${hash[$asset]}}
  done
  [[ $content != *'{{'* ]] || die 1 "unreplaced marker in $template"
  mkdir -p "$(dirname "$dest")"
  printf '%s\n' "$content" >"$dest"
}

mkdir -p "$out"
cp -R "$src/npm" "$out/npm"
cp -R "$src/pypi" "$out/pypi"
rm "$out/npm/package.json.tmpl" "$out/pypi/pyproject.toml.tmpl" "$out/pypi/src/tbx_cli/_checksums.py.tmpl"

render "$src/npm/package.json.tmpl" "$out/npm/package.json"
render "$src/pypi/pyproject.toml.tmpl" "$out/pypi/pyproject.toml"
render "$src/pypi/src/tbx_cli/_checksums.py.tmpl" "$out/pypi/src/tbx_cli/_checksums.py"
render "$src/homebrew/tbx-cli.rb.tmpl" "$out/homebrew/tbx-cli.rb"
render "$src/nfpm.yaml.tmpl" "$out/nfpm-amd64.yaml" amd64 x64
render "$src/nfpm.yaml.tmpl" "$out/nfpm-arm64.yaml" arm64 arm64
