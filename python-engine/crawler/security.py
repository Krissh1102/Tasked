"""URL validation and SSRF defences for the crawler.

Every URL the crawler touches (start URL, discovered links, redirect targets,
robots.txt) goes through :func:`validate_url`. A URL is accepted only if:

* the scheme is http or https,
* it carries no embedded credentials,
* the host is not an obviously internal name (localhost, *.local, ...),
* EVERY address the host resolves to is a public, globally routable IP.

The resolved addresses are returned so the fetcher can connect to the validated
IP directly (DNS pinning). That closes the DNS-rebinding window between
"check" and "connect".

The environment variable ``TASKFORGE_UNSAFE_ALLOW_PRIVATE=1`` disables the
private-address check. It exists ONLY so the automated tests can crawl a local
fixture server. The Node backend never sets it (it launches the CLI with a
minimal, allow-listed environment).
"""

from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

ALLOW_PRIVATE_ENV = "TASKFORGE_UNSAFE_ALLOW_PRIVATE"
MAX_URL_LENGTH = 2048
DEFAULT_PORTS = {"http": 80, "https": 443}
BLOCKED_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".localdomain",
    ".home.arpa",
    ".lan",
    ".intranet",
)


class UrlValidationError(ValueError):
    """Raised when a URL is rejected. ``code`` is a stable machine-readable id."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ValidatedTarget:
    url: str  # canonical URL string
    scheme: str
    host: str  # IDNA/ASCII lower-case, no trailing dot
    port: int
    ips: tuple[str, ...] = field(default_factory=tuple)

    @property
    def host_header(self) -> str:
        if self.port == DEFAULT_PORTS.get(self.scheme):
            return f"[{self.host}]" if ":" in self.host else self.host
        h = f"[{self.host}]" if ":" in self.host else self.host
        return f"{h}:{self.port}"


def private_allowed() -> bool:
    return os.environ.get(ALLOW_PRIVATE_ENV) == "1"


def is_public_ip(value: str) -> bool:
    """True only for globally routable unicast addresses."""
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip in ipaddress.ip_network("64:ff9b::/96"):  # NAT64 -> embedded v4
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif ip.sixtofour is not None:  # 2002::/16
            ip = ip.sixtofour
    if ip.is_multicast:
        return False
    return bool(ip.is_global)


def site_key(host: str) -> str:
    """Host identity used for same-domain checks (ignores a leading www.)."""
    host = host.lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def canonicalize_url(url: str) -> str:
    """Normalise a URL for duplicate detection: lowercase scheme/host, drop the
    fragment and default port, make an empty path '/'."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower().rstrip(".")
    netloc = f"[{host}]" if ":" in host else host
    try:
        port = parts.port
    except ValueError:
        port = None
    if port and port != DEFAULT_PORTS.get(scheme):
        netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def _to_ascii_host(host: str) -> str:
    host = host.strip().rstrip(".").lower()
    if not host:
        raise UrlValidationError("MISSING_HOST", "URL has no host.")
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise UrlValidationError("INVALID_URL", f"Invalid host name: {exc}") from exc


def validate_url(url: str, *, resolve: bool = True) -> ValidatedTarget:
    """Validate ``url`` and (optionally) resolve + vet its addresses."""
    if not isinstance(url, str) or not url.strip():
        raise UrlValidationError("INVALID_URL", "URL is empty.")
    url = url.strip()
    if len(url) > MAX_URL_LENGTH:
        raise UrlValidationError("URL_TOO_LONG", f"URL exceeds {MAX_URL_LENGTH} characters.")
    if any(ch in url for ch in ("\r", "\n", "\x00", " ")):
        raise UrlValidationError("INVALID_URL", "URL contains whitespace or control characters.")
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        port = parts.port
        hostname = parts.hostname
    except ValueError as exc:
        raise UrlValidationError("INVALID_URL", f"Malformed URL: {exc}") from exc

    if scheme not in DEFAULT_PORTS:
        raise UrlValidationError(
            "UNSUPPORTED_SCHEME",
            f"Only http and https URLs are allowed (got '{scheme or 'none'}').",
        )
    if parts.username is not None or parts.password is not None:
        raise UrlValidationError("CREDENTIALS_NOT_ALLOWED", "URLs with embedded credentials are not allowed.")
    if not hostname:
        raise UrlValidationError("MISSING_HOST", "URL has no host.")

    host = _to_ascii_host(hostname)
    port = port or DEFAULT_PORTS[scheme]
    if not (1 <= port <= 65535):
        raise UrlValidationError("INVALID_URL", "Port out of range.")

    allow_private = private_allowed()
    if not allow_private:
        if host == "localhost" or host.endswith(BLOCKED_SUFFIXES):
            raise UrlValidationError("BLOCKED_HOST", f"Host '{host}' is an internal name and is blocked.")

    ips: list[str] = []
    if resolve:
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise UrlValidationError("DNS_FAILURE", f"Could not resolve '{host}': {exc.strerror or exc}") from exc
        for info in infos:
            addr = info[4][0]
            if addr not in ips:
                ips.append(addr)
        if not ips:
            raise UrlValidationError("DNS_FAILURE", f"'{host}' resolved to no addresses.")
        if not allow_private:
            bad = [a for a in ips if not is_public_ip(a)]
            if bad:
                raise UrlValidationError(
                    "PRIVATE_ADDRESS",
                    f"'{host}' resolves to a non-public address ({bad[0]}); request blocked.",
                )
    else:
        # literal-IP check without DNS (used by pure unit tests)
        try:
            ipaddress.ip_address(host)
            if not allow_private and not is_public_ip(host):
                raise UrlValidationError("PRIVATE_ADDRESS", f"Address {host} is not public; request blocked.")
        except ValueError:
            pass

    canonical = canonicalize_url(urlunsplit((scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, parts.query, "")))
    return ValidatedTarget(url=canonical, scheme=scheme, host=host, port=port, ips=tuple(ips))
