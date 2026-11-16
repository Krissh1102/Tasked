"""Crawler + CLI tests against the local fixture site (see conftest.py)."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from crawler.crawler import Crawler
from crawler.fetcher import FetchError, SafeFetcher
from crawler.schemas import CrawlResult

ENGINE_DIR = Path(__file__).resolve().parents[1]


def run_crawl(url, **kw):
    kw.setdefault("max_pages", 10)
    kw.setdefault("max_depth", 3)
    events = []
    with SafeFetcher(timeout=3, total_timeout=6, max_bytes=kw.pop("max_bytes", 2_000_000)) as f:
        c = Crawler(url, fetcher=f, timeout_s=3, max_bytes=2_000_000, delay=0,
                    emit=lambda e, **k: events.append((e, k)), **kw)
        return c.run(), events


def test_full_crawl_partial_because_of_broken_link(site, allow_private):
    res, events = run_crawl(site + "/")
    CrawlResult.model_validate(res.model_dump(mode="json"))  # schema round-trip
    urls = [p.url for p in res.pages]
    assert urls[0] == site + "/"
    assert site + "/about" in urls and site + "/products" in urls and site + "/deep/1" in urls
    # duplicates (#fragment, ?x=1 is a distinct URL by design) never produce the same URL twice
    assert len(urls) == len(set(urls))
    # broken link -> failure, so the overall result is partial
    assert any(f.url.endswith("/missing") and f.code == "HTTP_404" for f in res.failures)
    assert res.status == "partial"
    assert res.stats.pages_crawled == len(res.pages)
    assert res.stats.pages_failed == len(res.failures) >= 1
    assert res.stats.total_words == sum(p.word_count for p in res.pages) > 0
    # robots.txt honoured: /private/ never fetched, recorded as blocked
    assert not any("/private/" in u for u in urls)
    assert any("/private/" in u for u in res.robots_blocked)
    # content cleanup
    home = res.pages[0]
    assert home.title == "Acme Widgets"
    assert home.meta_description.startswith("Acme builds reliable")
    assert home.headings.h1 == ["Welcome to Acme"] and home.headings.h2 == ["Our widgets"]
    assert "SCRIPT_TEXT_SHOULD_NOT_APPEAR" not in home.text and "FOOTER_NOISE" not in home.text
    assert "https://other.example.org/x" in home.external_links
    assert site + "/about" in home.internal_links
    # summary derived from real content
    assert res.summary and "Acme" in res.summary.text
    # progress events reflect real activity
    names = [e for e, _ in events]
    assert names[0] == "url_validated" and "robots" in names and names[-1] == "crawl_complete"
    assert names.count("page_fetching") == res.stats.pages_crawled + res.stats.pages_failed


def test_depth_limit(site, allow_private):
    res, _ = run_crawl(site + "/", max_depth=0)
    assert [p.url for p in res.pages] == [site + "/"]
    res1, _ = run_crawl(site + "/", max_depth=1)
    assert site + "/deep/1" not in [p.url for p in res1.pages]  # depth 2


def test_page_limit(site, allow_private):
    res, _ = run_crawl(site + "/", max_pages=2)
    assert res.stats.pages_crawled + res.stats.pages_failed == 2


def test_prompt_injection_text_is_just_data(site, allow_private):
    res, _ = run_crawl(site + "/products", max_depth=0)
    page = res.pages[0]
    assert "Ignore all previous instructions" in page.text  # captured verbatim as data
    assert res.status == "success"


def test_non_html_start_fails(site, allow_private):
    res, _ = run_crawl(site + "/pdf-as-link")
    assert res.status == "failure" and res.error.code == "UNSUPPORTED_CONTENT_TYPE"


def test_server_error_is_failure_not_crash(site, allow_private):
    res, _ = run_crawl(site + "/server-error")
    assert res.status == "failure" and res.failures[0].code == "HTTP_500"


def test_redirect_within_site_followed(site, allow_private):
    res, _ = run_crawl(site + "/redirect-in", max_depth=0)
    assert res.status == "success" and res.pages[0].final_url == site + "/about"


def test_redirect_off_site_not_followed(site, allow_private):
    res, _ = run_crawl(site + "/redirect-out", max_depth=0)
    assert res.status == "failure" and res.failures[0].code == "OFFSITE_REDIRECT"


def test_redirect_loop_stopped(site, allow_private):
    res, _ = run_crawl(site + "/redirect-loop", max_depth=0)
    assert res.failures[0].code == "TOO_MANY_REDIRECTS"


def test_response_size_limit_truncates(site, allow_private):
    with SafeFetcher(max_bytes=50_000) as f:
        r = f.fetch(site + "/big")
    assert r.truncated and len(r.body) == 50_000


def test_request_timeout(site, allow_private):
    with SafeFetcher(timeout=1, total_timeout=2) as f:
        t0 = time.monotonic()
        with pytest.raises(FetchError) as ei:
            f.fetch(site + "/slow")
    assert ei.value.code == "TIMEOUT" and time.monotonic() - t0 < 4


def test_private_target_blocked_by_default(site, monkeypatch):
    monkeypatch.delenv("TASKFORGE_UNSAFE_ALLOW_PRIVATE", raising=False)
    with SafeFetcher() as f:
        with pytest.raises(FetchError) as ei:
            f.fetch(site + "/")
    assert ei.value.code == "PRIVATE_ADDRESS"


def test_dns_is_pinned_once_per_origin(site, allow_private, monkeypatch):
    import socket
    calls = []
    real = socket.getaddrinfo

    def counting(host, *a, **k):
        calls.append(host)
        return real(host, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", counting)
    # use a real hostname (not an IP literal) so name lookups are distinguishable from socket-level IP connects
    res, _ = run_crawl(site.replace("127.0.0.1", "localhost") + "/", max_pages=4)
    assert res.stats.pages_crawled >= 3  # crawl works through the pinned IP with Host: localhost:<port>
    assert calls.count("localhost") == 1  # name resolved exactly once per origin; later hops reuse the pinned IP


# ---- real CLI subprocess -------------------------------------------------
def cli(*args, env_extra=None, timeout=60):
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "PYTHONPATH")}
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, "-m", "crawler.cli", *args], cwd=ENGINE_DIR, env=env,
        capture_output=True, text=True, timeout=timeout,
    )


def test_cli_success_and_partial_exit_zero(site):
    p = cli("--url", site + "/", "--max-pages", "6", "--max-depth", "2", "--output", "json", "--delay", "0",
            env_extra={"TASKFORGE_UNSAFE_ALLOW_PRIVATE": "1"})
    assert p.returncode == 0, p.stderr
    doc = json.loads(p.stdout)  # stdout is exactly one JSON document
    CrawlResult.model_validate(doc)
    assert doc["status"] in ("success", "partial") and doc["stats"]["pages_crawled"] >= 2
    assert any(line.startswith("@@TASKFORGE@@ ") for line in p.stderr.splitlines())


def test_cli_rejects_private_url_without_override(site):
    p = cli("--url", site + "/")
    assert p.returncode == 2
    doc = json.loads(p.stdout)
    assert doc["status"] == "failure" and doc["error"]["code"] == "PRIVATE_ADDRESS"


@pytest.mark.parametrize("bad", ["ftp://x.com", "not a url", "http://localhost/", "file:///etc/passwd"])
def test_cli_rejects_invalid_urls(bad):
    p = cli("--url", bad)
    assert p.returncode == 2
    assert json.loads(p.stdout)["error"]["code"] in {
        "UNSUPPORTED_SCHEME", "INVALID_URL", "BLOCKED_HOST"}


def test_cli_rejects_out_of_range_args():
    p = cli("--url", "https://example.com", "--max-pages", "9999")
    assert p.returncode == 2 and "must be between" in p.stderr


def test_cli_unreachable_host_exits_3(allow_private):
    # nothing listens on this port -> connection refused -> crawl failure, still valid JSON
    p = cli("--url", "http://127.0.0.1:9/", "--timeout", "2", env_extra={"TASKFORGE_UNSAFE_ALLOW_PRIVATE": "1"})
    assert p.returncode == 3
    doc = json.loads(p.stdout)
    assert doc["status"] == "failure" and doc["error"]["code"]


def test_unreachable_site_reports_root_cause_not_robots(allow_private):
    res, _ = run_crawl("http://127.0.0.1:9/", max_depth=0)
    assert res.status == "failure"
    assert res.error.code == "CONNECTION_FAILED" and "Could not reach" in res.error.message
    assert any("robots.txt unreachable" in w for w in res.warnings)


def test_cli_graceful_time_budget(site):
    # /slow is linked nowhere, so crawl the slow page directly with a 1s budget: request times out -> failure JSON
    p = cli("--url", site + "/slow", "--timeout", "1", "--time-budget", "2",
            env_extra={"TASKFORGE_UNSAFE_ALLOW_PRIVATE": "1"})
    assert p.returncode == 3 and json.loads(p.stdout)["error"]["code"] == "TIMEOUT"
