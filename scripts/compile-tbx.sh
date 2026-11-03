#!/usr/bin/env bash
# Compile tbx into one single-file binary per supported target.
# Usage: compile-tbx.sh <outdir>
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: compile-tbx.sh <outdir>" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
outdir="$1"
mkdir -p "$outdir"

pinned="$(tr -d '[:space:]' <"${root}/.bun-version")"
actual="$(bun --version)"
if [[ "$actual" != "$pinned" ]]; then
  echo "warning: bun ${actual} on PATH differs from .bun-version ${pinned}" >&2
fi

for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  bun build --compile "--target=bun-${target}" "${root}/tbx/src/index.ts" \
    --outfile "${outdir}/tbx-${target}"
done
