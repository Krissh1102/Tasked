"""SSRF-hardened HTTP fetching.

* Every hop (initial URL and each redirect) is validated by ``validate_url``.
* The connection goes to the already-validated IP (DNS pinning); the original
  host is sent as the Host header and TLS SNI/verification hostname, so
  certificate checks still apply to the real name.
* Redirects are followed manually so each destination can be re-validated.
* Response bodies are streamed and cut off at ``max_bytes`` (measured after
  decompression) and a total wall-clock deadline guards against slow drips.
* The environment proxy is ignored (``trust_env=False``): pinning requires a
  direct connection.
"""

from __future__ import annotations

import ssl
import time
from dataclasses import dataclass, field
from typing import Callable, Optional
from urllib.parse import urljoin

import httpx

from .security import UrlValidationError, ValidatedTarget, validate_url

USER_AGENT = "TaskForgeBot/1.0 (+hackathon crawler; respects robots.txt)"
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
HTML_TYPES = ("text/html", "application/xhtml+xml")


class FetchError(Exception):
    def __init__(self, code: str, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class FetchResult:
    url: str
    final_url: str
    status_code: int
    content_type: str
    body: bytes
    truncated: bool
    duration_ms: int
    charset: Optional[str] = None
    redirects: list[str] = field(default_factory=list)


class SafeFetcher:
    def __init__(
        self,
        *,
        timeout: float = 10.0,
        total_timeout: float = 20.0,
        max_bytes: int = 2_000_000,
        max_redirects: int = 5,
        verify: "bool | ssl.SSLContext" = True,
    ) -> None:
        self.max_bytes = max_bytes
        self.total_timeout = total_timeout
        self.max_redirects = max_redirects
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout),
            follow_redirects=False,
            trust_env=False,
            verify=verify,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
                "Accept-Language": "en;q=0.9",
            },
        )
        self._targets: dict[str, ValidatedTarget] = {}

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "SafeFetcher":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- validation (DNS result cached per origin so one crawl pins one IP set)
    def validate(self, url: str) -> ValidatedTarget:
        probe = validate_url(url, resolve=False)
        key = f"{probe.scheme}://{probe.host}:{probe.port}"
        cached = self._targets.get(key)
        if cached is None:
            cached = validate_url(url, resolve=True)
            self._targets[key] = cached
        return ValidatedTarget(
            url=probe.url, scheme=probe.scheme, host=probe.host, port=probe.port, ips=cached.ips
        )

    def fetch(
        self,
        url: str,
        *,
        allowed_types: Optional[tuple[str, ...]] = HTML_TYPES,
        max_bytes: Optional[int] = None,
        host_ok: Optional[Callable[[str], bool]] = None,
    ) -> FetchResult:
        limit = max_bytes or self.max_bytes
        current = url
        redirects: list[str] = []
        started = time.monotonic()
        for _ in range(self.max_redirects + 1):
            try:
                # cheap syntactic check first, so off-site hosts are refused before any DNS lookup
                probe = validate_url(current, resolve=False)
                if host_ok is not None and not host_ok(probe.host):
                    raise FetchError("OFFSITE_REDIRECT", f"Redirected to a different site ({probe.host}); not followed.")
                target = self.validate(current)
            except UrlValidationError as exc:
                raise FetchError(exc.code, exc.message) from exc
            resp = self._request_once(target, allowed_types, limit, started)
            if resp.status_code in REDIRECT_STATUSES and resp.location:
                current = urljoin(target.url, resp.location)
                redirects.append(current)
                continue
            return FetchResult(
                url=url,
                final_url=target.url,
                status_code=resp.status_code,
                content_type=resp.content_type,
                body=resp.body,
                truncated=resp.truncated,
                duration_ms=int((time.monotonic() - started) * 1000),
                charset=resp.charset,
                redirects=redirects,
            )
        raise FetchError("TOO_MANY_REDIRECTS", f"More than {self.max_redirects} redirects.")

    # ------------------------------------------------------------------
    @dataclass
    class _Raw:
        status_code: int
        content_type: str
        body: bytes
        truncated: bool
        charset: Optional[str]
        location: Optional[str]

    def _request_once(self, target: ValidatedTarget, allowed_types, limit: int, started: float) -> "_Raw":
        last_err: Optional[Exception] = None
        for ip in target.ips[:3]:
            pinned = httpx.URL(target.url).copy_with(host=ip)
            try:
                return self._stream(pinned, target, allowed_types, limit, started)
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                last_err = exc  # try next pinned address
                continue
            except FetchError:
                raise
            except httpx.TimeoutException as exc:
                raise FetchError("TIMEOUT", f"Request timed out: {exc.__class__.__name__}") from exc
            except httpx.InvalidURL as exc:
                raise FetchError("INVALID_URL", str(exc)) from exc
            except httpx.HTTPError as exc:
                raise FetchError("HTTP_ERROR", f"{exc.__class__.__name__}: {exc}") from exc
        msg = str(last_err) if last_err else "connection failed"
        if "CERTIFICATE" in msg.upper() or "SSL" in msg.upper():
            raise FetchError("TLS_ERROR", f"TLS verification failed: {msg}")
        if isinstance(last_err, httpx.ConnectTimeout):
            raise FetchError("TIMEOUT", "Connection timed out.")
        raise FetchError("CONNECTION_FAILED", f"Could not connect to {target.host}: {msg}")

    def _stream(self, pinned: httpx.URL, target: ValidatedTarget, allowed_types, limit: int, started: float) -> "_Raw":
        headers = {"Host": target.host_header}
        ext = {"sni_hostname": target.host} if target.scheme == "https" else {}
        with self._client.stream("GET", pinned, headers=headers, extensions=ext) as resp:
            ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            location = resp.headers.get("location")
            if resp.status_code in REDIRECT_STATUSES:
                return self._Raw(resp.status_code, ctype, b"", False, None, location)
            if resp.status_code >= 400:
                return self._Raw(resp.status_code, ctype, b"", False, None, None)
            if allowed_types is not None and not any(ctype.startswith(t) for t in allowed_types):
                raise FetchError(
                    "UNSUPPORTED_CONTENT_TYPE",
                    f"Not an HTML page (content-type: {ctype or 'unknown'}).",
                    resp.status_code,
                )
            chunks: list[bytes] = []
            size = 0
            truncated = False
            for chunk in resp.iter_bytes():
                if time.monotonic() - started > self.total_timeout:
                    raise FetchError("TIMEOUT", f"Response took longer than {self.total_timeout:.0f}s.")
                size += len(chunk)
                if size > limit:
                    keep = len(chunk) - (size - limit)
                    if keep > 0:
                        chunks.append(chunk[:keep])
                    truncated = True
                    break
                chunks.append(chunk)
            return self._Raw(resp.status_code, ctype, b"".join(chunks), truncated, resp.charset_encoding, None)
