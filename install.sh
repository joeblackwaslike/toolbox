#!/bin/sh
# Installs the tbx CLI binary from the newest complete tbx-cli GitHub release.
# Usage: curl -fsSL <url>/install.sh | sh -s -- [tool...]
set -eu

api="${TBX_RELEASES_API:-https://api.github.com/repos/joeblackwaslike/toolbox/releases?per_page=100}"
install_dir="${TBX_INSTALL_DIR:-$HOME/.local/share/tbx/bin}"
marker="# added by tbx installer"

die() {
  printf 'tbx installer: %s\n' "$*" >&2
  exit 1
}

say() {
  printf 'tbx installer: %s\n' "$*"
}

os_name="${TBX_UNAME_S:-$(uname -s)}"
arch_name="${TBX_UNAME_M:-$(uname -m)}"

case "$os_name" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) die "Unsupported OS: $os_name" ;;
esac

case "$arch_name" in
arm64 | aarch64) arch=arm64 ;;
x86_64 | amd64) arch=x64 ;;
*) die "Unsupported architecture: $arch_name" ;;
esac

libc="${TBX_LIBC:-}"
if [ -z "$libc" ] && [ "$os" = linux ]; then
  libc=glibc
  if (ldd --version 2>&1 || true) | grep -qi musl; then
    libc=musl
  elif ls /lib/ld-musl-* >/dev/null 2>&1; then
    libc=musl
  fi
fi
[ "$libc" = musl ] && die "Linux musl is not supported in v1 (glibc only)"

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "need sha256sum or shasum"
fi

asset="tbx-${os}-${arch}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "looking up the latest tbx-cli release"
curl -fsSL "$api" -o "$tmp/releases.json" || die "could not fetch $api"

selection="$(awk -v want="$asset" '
  function flush() {
    if (tag ~ /^tbx-cli-v/ && sums != "" && bin != "") {
      print tag, sums, bin
      found = 1
      exit
    }
  }
  /"tag_name"[ \t]*:/ {
    flush()
    tag = $0; sub(/.*"tag_name"[ \t]*:[ \t]*"/, "", tag); sub(/".*/, "", tag)
    sums = ""; bin = ""
    next
  }
  /"browser_download_url"[ \t]*:/ {
    url = $0; sub(/.*"browser_download_url"[ \t]*:[ \t]*"/, "", url); sub(/".*/, "", url)
    n = split(url, parts, "/")
    if (parts[n] == "checksums.txt") sums = url
    else if (parts[n] == want) bin = url
  }
  END { if (!found) flush() }
' "$tmp/releases.json")"

[ -n "$selection" ] || die "No complete tbx-cli release with a $asset binary found"
tag="${selection%% *}"
rest="${selection#* }"
sums_url="${rest%% *}"
bin_url="${rest#* }"

say "installing $tag ($asset)"
curl -fsSL "$sums_url" -o "$tmp/checksums.txt" || die "could not download checksums.txt"
curl -fsSL "$bin_url" -o "$tmp/$asset" || die "could not download $asset"

expected="$(awk -v f="$asset" '$2 == f {print $1}' "$tmp/checksums.txt")"
[ -n "$expected" ] || die "checksums.txt has no entry for $asset"
actual="$(sha256 "$tmp/$asset")"
if [ "$expected" != "$actual" ]; then
  rm -f "$tmp/$asset"
  die "checksum mismatch for $asset"
fi

mkdir -p "$install_dir"
cp "$tmp/$asset" "$install_dir/tbx.tmp"
chmod 755 "$install_dir/tbx.tmp"
mv "$install_dir/tbx.tmp" "$install_dir/tbx"
say "installed $install_dir/tbx"

case ":$PATH:" in
*":$install_dir:"*) on_path=1 ;;
*) on_path=0 ;;
esac

if [ "$on_path" = 0 ]; then
  case "$(basename "${SHELL:-}")" in
  zsh) profile="$HOME/.zshrc" ;;
  bash)
    if [ "$os" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
    ;;
  *) profile="$HOME/.profile" ;;
  esac
  if ! grep -qF "$marker" "$profile" 2>/dev/null; then
    # shellcheck disable=SC2016
    printf '\n%s\nexport PATH="%s:%s"\n' "$marker" "$install_dir" '$PATH' >>"$profile"
    say "added $install_dir to PATH in $profile"
  fi
  say "open a new shell or run: export PATH=\"$install_dir:\$PATH\""
fi

if [ "$#" -gt 0 ]; then
  rc=0
  "$install_dir/tbx" install "$@" || rc=$?
  exit "$rc"
fi
say "next: tbx install <tool>"
