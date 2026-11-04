import hashlib
import http.server
import importlib
import os
import platform
import subprocess
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VERSION = "9.8.7"
STUB = b'#!/bin/sh\necho "STUB-RAN $*"\n'
ASSETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]


class Handler(http.server.BaseHTTPRequestHandler):
    """Serves the stub binary and counts requests."""

    body = STUB
    hits = 0
    truncate = False
    redirect_target = None

    def do_GET(self):
        """Serve the stub for release asset paths."""
        type(self).hits += 1
        if self.path == "/second":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(type(self).body)
            return
        if self.path == "/loop":
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.end_headers()
            return
        if not self.path.startswith(f"/tbx-cli-v{VERSION}/tbx-"):
            self.send_response(404)
            self.end_headers()
            return
        if type(self).redirect_target is not None:
            self.send_response(302)
            self.send_header("Location", type(self).redirect_target)
            self.end_headers()
            return
        self.send_response(200)
        if type(self).truncate:
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b"short")
            return
        self.end_headers()
        self.wfile.write(type(self).body)

    def log_message(self, *args):
        """Silence request logging."""


@pytest.fixture(scope="session")
def rendered(tmp_path_factory):
    work = tmp_path_factory.mktemp("render")
    sums = work / "checksums.txt"
    digest = hashlib.sha256(STUB).hexdigest()
    sums.write_text("".join(f"{digest}  tbx-{a}\n" for a in ASSETS))
    out = work / "out"
    subprocess.run(
        ["bash", str(ROOT / "scripts/render-packaging.sh"), VERSION, str(sums), str(out)],
        check=True,
    )
    return out


@pytest.fixture
def env(tmp_path, rendered):
    Handler.body = STUB
    Handler.hits = 0
    Handler.truncate = False
    Handler.redirect_target = None
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {
        **os.environ,
        "PYTHONPATH": str(rendered / "pypi/src"),
        "TBX_DOWNLOAD_BASE": f"http://127.0.0.1:{server.server_address[1]}",
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
    }
    server.shutdown()


def run(env, *args):
    return subprocess.run(
        [sys.executable, "-m", "tbx_cli", *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def cached(env):
    d = Path(env["XDG_CACHE_HOME"]) / "tbx" / VERSION
    return list(d.iterdir()) if d.exists() else []


def test_downloads_verifies_and_execs(env):
    r = run(env, "install", "--flag")
    assert r.stderr == ""
    assert r.stdout == "STUB-RAN install --flag\n"
    assert Handler.hits == 1


def test_tampered_download_is_rejected_and_not_cached(env):
    Handler.body = b"#!/bin/sh\necho TAMPERED\n"
    r = run(env, "install")
    assert "TAMPERED" not in r.stdout
    assert r.returncode != 0
    assert "checksum" in r.stderr.lower()
    assert cached(env) == []


def test_second_run_uses_cache(env):
    assert run(env, "a").returncode == 0
    Handler.hits = 0
    r = run(env, "b")
    assert r.stdout == "STUB-RAN b\n"
    assert Handler.hits == 0


def test_non_loopback_http_is_refused(env):
    r = run({**env, "TBX_DOWNLOAD_BASE": "http://example.com"}, "x")
    assert r.returncode != 0
    assert "https" in r.stderr.lower()


def test_tampered_cached_binary_is_replaced_not_run(env):
    assert run(env, "a").returncode == 0
    (cached_file,) = cached(env)
    cached_file.write_text("#!/bin/sh\necho TAMPERED\n")
    Handler.hits = 0
    r = run(env, "b")
    assert r.stdout == "STUB-RAN b\n"
    assert Handler.hits == 1
    assert cached_file.read_bytes() == STUB


def test_truncated_download_fails_cleanly(env):
    Handler.truncate = True
    r = run(env, "x")
    assert r.returncode != 0
    assert "Traceback" not in r.stderr
    assert "download failed" in r.stderr
    assert cached(env) == []


def test_redirect_to_non_loopback_is_refused_before_second_request(env):
    Handler.redirect_target = "http://example.com/elsewhere"
    r = run(env, "x")
    assert r.returncode != 0
    assert "refusing a redirect" in r.stderr
    assert Handler.hits == 1
    assert cached(env) == []


def test_redirect_within_allowed_hosts_is_followed(env):
    base = env["TBX_DOWNLOAD_BASE"]
    Handler.redirect_target = f"{base}/second"
    r = run(env, "x")
    assert r.returncode == 0
    assert Handler.hits == 2


def test_unreadable_cache_fails_with_context_instead_of_downloading(env, rendered, monkeypatch):
    monkeypatch.syspath_prepend(str(rendered / "pypi/src"))
    tbx_cli = importlib.import_module("tbx_cli")
    asset = tbx_cli.asset_name(sys.platform, platform.machine(), platform.libc_ver()[0])
    target = Path(env["XDG_CACHE_HOME"]) / "tbx" / VERSION / asset
    target.mkdir(parents=True)
    r = run(env, "x")
    assert r.returncode != 0
    assert "Traceback" not in r.stderr
    assert "cannot read cached binary" in r.stderr
    assert Handler.hits == 0


def test_exec_of_non_executable_cached_binary_fails_with_context(env):
    assert run(env, "a").returncode == 0
    (cached_file,) = cached(env)
    cached_file.chmod(0o644)
    Handler.hits = 0
    r = run(env, "b")
    assert r.returncode != 0
    assert "Traceback" not in r.stderr
    assert "cannot run" in r.stderr
    assert Handler.hits == 0


def test_too_many_redirects_fails_clearly(env):
    Handler.redirect_target = "/loop"
    r = run(env, "x")
    assert r.returncode != 0
    assert "Traceback" not in r.stderr
    assert "download failed" in r.stderr


def test_only_https_final_urls_or_loopback_http(rendered, monkeypatch):
    monkeypatch.syspath_prepend(str(rendered / "pypi/src"))
    is_allowed_url = importlib.import_module("tbx_cli").is_allowed_url

    assert is_allowed_url("https://objects.githubusercontent.com/x")
    assert is_allowed_url("http://127.0.0.1:8080/x")
    assert not is_allowed_url("http://example.com/x")


def test_unsupported_platform_and_musl_messages(rendered, monkeypatch, capsys):
    monkeypatch.syspath_prepend(str(rendered / "pypi/src"))
    asset_name = importlib.import_module("tbx_cli").asset_name

    assert asset_name("linux", "aarch64", "glibc") == "tbx-linux-arm64"
    with pytest.raises(SystemExit):
        asset_name("win32", "AMD64", "")
    assert "unsupported platform" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        asset_name("linux", "x86_64", "")
    assert "musl" in capsys.readouterr().err
