import pytest

from crawler.security import (
    UrlValidationError,
    canonicalize_url,
    is_public_ip,
    validate_url,
)


@pytest.mark.parametrize(
    "ip,expected",
    [
        ("93.184.216.34", True),
        ("8.8.8.8", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),  # cloud metadata
        ("100.64.0.1", False),  # CGNAT
        ("0.0.0.0", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("::ffff:127.0.0.1", False),  # v4-mapped loopback
        ("::ffff:8.8.8.8", True),
        ("not-an-ip", False),
    ],
)
def test_is_public_ip(ip, expected):
    assert is_public_ip(ip) is expected


@pytest.mark.parametrize(
    "url,code",
    [
        ("", "INVALID_URL"),
        ("ftp://example.com/x", "UNSUPPORTED_SCHEME"),
        ("file:///etc/passwd", "UNSUPPORTED_SCHEME"),
        ("javascript:alert(1)", "UNSUPPORTED_SCHEME"),
        ("example.com", "UNSUPPORTED_SCHEME"),
        ("http://", "MISSING_HOST"),
        ("http://user:pw@example.com/", "CREDENTIALS_NOT_ALLOWED"),
        ("http://localhost/", "BLOCKED_HOST"),
        ("http://foo.localhost/", "BLOCKED_HOST"),
        ("http://printer.local/", "BLOCKED_HOST"),
        ("http://127.0.0.1/", "PRIVATE_ADDRESS"),
        ("http://127.1/", "PRIVATE_ADDRESS"),
        ("http://2130706433/", "PRIVATE_ADDRESS"),  # decimal form of 127.0.0.1
        ("http://0x7f000001/", "PRIVATE_ADDRESS"),
        ("http://[::1]/", "PRIVATE_ADDRESS"),
        ("http://169.254.169.254/latest/meta-data/", "PRIVATE_ADDRESS"),
        ("http://10.0.0.5:8080/", "PRIVATE_ADDRESS"),
        ("http://example.com:99999/", "INVALID_URL"),
        ("http://exa mple.com/", "INVALID_URL"),
        ("http://example.com/" + "a" * 3000, "URL_TOO_LONG"),
    ],
)
def test_rejects_bad_urls(url, code):
    with pytest.raises(UrlValidationError) as ei:
        validate_url(url, resolve=True)
    assert ei.value.code == code


def test_accepts_public_literal_ip():
    t = validate_url("https://93.184.216.34/path?q=1", resolve=True)
    assert t.host == "93.184.216.34" and t.scheme == "https" and t.port == 443
    assert t.ips == ("93.184.216.34",)


def test_localhost_resolves_private_when_override_on(monkeypatch):
    monkeypatch.setenv("TASKFORGE_UNSAFE_ALLOW_PRIVATE", "1")
    t = validate_url("http://127.0.0.1:8123/x")
    assert t.port == 8123
    assert t.host_header == "127.0.0.1:8123"


def test_override_not_active_by_default(monkeypatch):
    monkeypatch.delenv("TASKFORGE_UNSAFE_ALLOW_PRIVATE", raising=False)
    with pytest.raises(UrlValidationError):
        validate_url("http://127.0.0.1:8123/x")


def test_canonicalize():
    assert canonicalize_url("HTTP://Example.COM:80/a#frag") == "http://example.com/a"
    assert canonicalize_url("https://example.com") == "https://example.com/"
    assert canonicalize_url("https://example.com:8443/a?b=1") == "https://example.com:8443/a?b=1"
