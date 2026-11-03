"""Launcher that downloads, verifies and runs the tbx release binary for this package version."""

import contextlib
import hashlib
import os
import platform
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from tbx_cli._checksums import CHECKSUMS, VERSION

DEFAULT_BASE = "https://github.com/joeblackwaslike/toolbox/releases/download"
OS_NAMES = {"darwin": "darwin", "linux": "linux"}
ARCH_NAMES = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}


def _fail(message: str) -> None:
    sys.stderr.write(f"tbx: {message}\n")
    sys.exit(1)


def _asset_name() -> str:
    os_name = OS_NAMES.get(sys.platform)
    arch = ARCH_NAMES.get(platform.machine().lower())
    if not os_name or not arch:
        _fail(
            f"unsupported platform {sys.platform}/{platform.machine()}; need macOS or Linux on arm64 or x64"
        )
    if os_name == "linux" and any(Path("/lib").glob("ld-musl-*")):
        _fail("musl-based Linux (such as Alpine) is not supported; the tbx binaries need glibc")
    return f"tbx-{os_name}-{arch}"


def _download_base() -> str:
    base = os.environ.get("TBX_DOWNLOAD_BASE", DEFAULT_BASE).rstrip("/")
    url = urllib.parse.urlparse(base)
    loopback = url.hostname in ("127.0.0.1", "localhost")
    if url.scheme != "https" and not (url.scheme == "http" and loopback):
        _fail("the download base must use https (http is allowed only for localhost)")
    return base


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fetch(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=60) as res:  # noqa: S310
            return res.read()
    except OSError as err:
        _fail(f"download failed: {url}: {err}")
    return b""


def _install(asset: str, expected: str, target: Path) -> None:
    url = f"{_download_base()}/tbx-cli-v{VERSION}/{asset}"
    body = _fetch(url)
    if _sha256(body) != expected:
        _fail(f"checksum mismatch for {asset}; refusing to run the download")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{asset}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        Path(tmp).chmod(0o755)
        Path(tmp).replace(target)
    finally:
        with contextlib.suppress(FileNotFoundError):
            Path(tmp).unlink()


def main() -> None:
    """Run the pinned tbx binary with the original arguments, downloading it first if needed."""
    asset = _asset_name()
    expected = CHECKSUMS.get(asset)
    if not expected:
        _fail(f"no checksum for {asset} in this package")
    cache_root = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    target = cache_root / "tbx" / VERSION / asset
    try:
        cached_ok = _sha256(target.read_bytes()) == expected
    except OSError:
        cached_ok = False
    if not cached_ok:
        _install(asset, expected, target)
    os.execv(target, [str(target), *sys.argv[1:]])  # noqa: S606
