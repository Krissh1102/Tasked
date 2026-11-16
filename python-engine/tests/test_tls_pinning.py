"""HTTPS + DNS pinning: we connect to the pinned IP but must still verify the
certificate against the REAL hostname (via SNI), so pinning can't be abused to
accept a certificate for the wrong name."""

import shutil
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from crawler.fetcher import FetchError, SafeFetcher

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl not available")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = b"<html><head><title>secure</title></head><body><main>hello over tls</main></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def make_cert(tmp_path, dns_name):
    key, crt = tmp_path / f"{dns_name}.key", tmp_path / f"{dns_name}.crt"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(crt),
         "-days", "1", "-subj", f"/CN={dns_name}", "-addext", f"subjectAltName=DNS:{dns_name}"],
        check=True, capture_output=True,
    )
    return key, crt


def serve(key, crt):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_cert_verified_against_hostname_not_ip(tmp_path, monkeypatch):
    monkeypatch.setenv("TASKFORGE_UNSAFE_ALLOW_PRIVATE", "1")
    key, crt = make_cert(tmp_path, "localhost")
    srv = serve(key, crt)
    try:
        url = f"https://localhost:{srv.server_address[1]}/"
        with SafeFetcher(verify=ssl.create_default_context(cafile=str(crt))) as f:
            r = f.fetch(url)
        assert r.status_code == 200 and b"hello over tls" in r.body
    finally:
        srv.shutdown()


def test_certificate_for_wrong_name_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("TASKFORGE_UNSAFE_ALLOW_PRIVATE", "1")
    key, crt = make_cert(tmp_path, "evil.example")  # cert does not cover 'localhost'
    srv = serve(key, crt)
    try:
        url = f"https://localhost:{srv.server_address[1]}/"
        with SafeFetcher(verify=ssl.create_default_context(cafile=str(crt))) as f:
            with pytest.raises(FetchError) as ei:
                f.fetch(url)
        assert ei.value.code == "TLS_ERROR"
    finally:
        srv.shutdown()
