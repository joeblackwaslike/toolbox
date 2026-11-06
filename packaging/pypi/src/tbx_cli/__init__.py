"""Launcher that downloads, verifies and runs the tbx release binary for this package version."""

import contextlib
import hashlib
import http.client
import os
import platform
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NoReturn

from tbx_cli._checksums import CHECKSUMS, VERSION

DEFAULT_BASE = "https://github.com/joeblackwaslike/toolbox/releases/download"
OS_NAMES = {"darwin": "darwin", "linux": "linux"}
ARCH_NAMES = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}


def _fail(message: str) -> NoReturn:
    sys.stderr.write(f"tbx: {message}\n")
    sys.exit(1)


def asset_name(os_name: str, machine: str, libc: str) -> str:
    """Map the platform to a release asset name, exiting with a clear message when unsupported."""
    os_part = OS_NAMES.get(os_name)
    arch = ARCH_NAMES.get(machine.lower())
    if not os_part or not arch:
        _fail(f"unsupported platform {os_name}/{machine}; need macOS or Linux on arm64 or x64")
    if os_part == "linux" and libc != "glibc":
        _fail("musl-based Linux (such as Alpine) is not supported; the tbx binaries need glibc")
    return f"tbx-{os_part}-{arch}"


def is_allowed_url(url: str) -> bool:
    """Allow https anywhere, and http only for loopback hosts."""
    try:
        parsed = urllib.parse.urlparse(url)
        loopback = parsed.hostname in ("127.0.0.1", "localhost")
    except ValueError:
        return False
    return parsed.scheme == "https" or (parsed.scheme == "http" and loopback)


def _download_base() -> str:
    base = os.environ.get("TBX_DOWNLOAD_BASE", DEFAULT_BASE).rstrip("/")
    if not is_allowed_url(base):
        _fail("the download base must use https (http is allowed only for localhost)")
    return base


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    """Validates each redirect hop before following it, with a bounded hop count."""

    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        if not is_allowed_url(newurl):
            raise urllib.error.HTTPError(newurl, code, f"refusing a redirect to {newurl}", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(url: str) -> bytes:
    opener = urllib.request.build_opener(_RedirectHandler)
    try:
        with opener.open(url, timeout=60) as res:
            if not is_allowed_url(res.geturl()):
                _fail(f"download failed: {url}: refusing a redirect to {res.geturl()}")
            return res.read()
    except (OSError, http.client.HTTPException, ValueError) as err:
        _fail(f"download failed: {url}: {err}")


def _install(asset: str, expected: str, target: Path) -> None:
    url = f"{_download_base()}/tbx-cli-v{VERSION}/{asset}"
    body = _fetch(url)
    if _sha256(body) != expected:
        _fail(f"checksum mismatch for {asset}; refusing to run the download")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{asset}.", suffix=".tmp")
    except OSError as err:
        _fail(f"cannot install cached binary {target}: {err}")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        Path(tmp).chmod(0o755)
        Path(tmp).replace(target)
    except OSError as err:
        _fail(f"cannot install cached binary {target}: {err}")
    finally:
        with contextlib.suppress(FileNotFoundError):
            Path(tmp).unlink()


def main() -> None:
    """Run the pinned tbx binary with the original arguments, downloading it first if needed."""
    asset = asset_name(sys.platform, platform.machine(), platform.libc_ver()[0])
    expected = CHECKSUMS.get(asset)
    if not expected:
        _fail(f"no checksum for {asset} in this package")
    cache_root = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    target = cache_root / "tbx" / VERSION / asset
    try:
        cached_ok = _sha256(target.read_bytes()) == expected
    except FileNotFoundError:
        cached_ok = False
    except OSError as err:
        _fail(f"cannot read cached binary {target}: {err}")
    if not cached_ok:
        _install(asset, expected, target)
    try:
        os.execv(target, [str(target), *sys.argv[1:]])  # noqa: S606
    except OSError as err:
        _fail(f"cannot run {target}: {err}")
