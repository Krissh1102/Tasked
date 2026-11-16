"""Breadth-first, same-domain, robots-aware crawler."""

from __future__ import annotations

import time
from collections import deque
from typing import Callable, Optional
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from .extractor import extract_page, is_crawlable_link
from .fetcher import FetchError, SafeFetcher
from .schemas import (
    CrawlOptions,
    CrawlResult,
    CrawlStats,
    ErrorInfo,
    PageFailure,
    PageResult,
)
from .security import UrlValidationError, canonicalize_url, site_key
from .summarizer import summarize

ROBOTS_UA = "TaskForgeBot"
MAX_CRAWL_DELAY = 5.0

Emit = Callable[..., None]


def _noop(*_a, **_k) -> None:  # pragma: no cover
    pass


class Crawler:
    def __init__(
        self,
        start_url: str,
        *,
        max_pages: int,
        max_depth: int,
        fetcher: SafeFetcher,
        timeout_s: float,
        max_bytes: int,
        delay: float = 0.2,
        time_budget: float = 45.0,
        respect_robots: bool = True,
        emit: Emit = _noop,
    ) -> None:
        self.start_url = start_url
        self.max_pages = max_pages
        self.max_depth = max_depth
        self.fetcher = fetcher
        self.timeout_s = timeout_s
        self.max_bytes = max_bytes
        self.delay = delay
        self.time_budget = time_budget
        self.respect_robots = respect_robots
        self.emit = emit
        self._robots_error: Optional[ErrorInfo] = None

    # -- robots.txt (RFC 9309 semantics) ---------------------------------
    def _load_robots(self, scheme: str, host_header: str, warnings: list[str]):
        rp = RobotFileParser()
        robots_url = f"{scheme}://{host_header}/robots.txt"
        try:
            res = self.fetcher.fetch(robots_url, allowed_types=None, max_bytes=512_000, host_ok=self._host_ok)
        except FetchError as exc:
            warnings.append(f"robots.txt unreachable ({exc.code}); treating the site as disallowed per RFC 9309.")
            self._robots_error = ErrorInfo(code=exc.code, message=f"Could not reach {host_header}: {exc.message}")
            self.emit("robots", status="unreachable", allowed=False, error=exc.code)
            rp.disallow_all = True
            return rp
        if res.status_code >= 500:
            warnings.append(f"robots.txt returned HTTP {res.status_code}; treating the site as disallowed per RFC 9309.")
            self.emit("robots", status=res.status_code, allowed=False)
            rp.disallow_all = True
        elif res.status_code >= 400:
            self.emit("robots", status=res.status_code, allowed=True, note="no robots.txt")
            rp.allow_all = True
        else:
            rp.parse(res.body.decode(res.charset or "utf-8", errors="replace").splitlines())
            self.emit("robots", status=res.status_code, allowed=True, note="rules loaded")
        return rp

    def _host_ok(self, host: str) -> bool:
        return site_key(host) == self._site

    # -- main loop ---------------------------------------------------------
    def run(self) -> CrawlResult:
        t0 = time.monotonic()
        options = CrawlOptions(
            max_pages=self.max_pages,
            max_depth=self.max_depth,
            timeout_s=self.timeout_s,
            max_bytes=self.max_bytes,
            respect_robots=self.respect_robots,
        )
        target = self.fetcher.validate(self.start_url)  # raises UrlValidationError
        self._site = site_key(target.host)
        self.emit("url_validated", url=target.url, host=target.host, ips=list(target.ips))

        warnings: list[str] = []
        pages: list[PageResult] = []
        failures: list[PageFailure] = []
        robots_blocked: list[str] = []

        rp: Optional[RobotFileParser] = None
        delay = self.delay
        if self.respect_robots:
            rp = self._load_robots(target.scheme, target.host_header, warnings)
            cd = rp.crawl_delay(ROBOTS_UA)
            if cd:
                delay = max(delay, min(float(cd), MAX_CRAWL_DELAY))

        start = target.url
        seen: set[str] = {start}
        queue: deque[tuple[str, int]] = deque([(start, 0)])
        discovered = 1
        attempts = 0

        while queue and attempts < self.max_pages:
            if time.monotonic() - t0 > self.time_budget:
                warnings.append(f"Time budget of {self.time_budget:.0f}s reached; crawl stopped early.")
                break
            url, depth = queue.popleft()

            if rp is not None and not rp.can_fetch(ROBOTS_UA, url):
                robots_blocked.append(url)
                self.emit("robots_blocked", url=url)
                continue

            if attempts > 0 and delay:
                time.sleep(delay)
            attempts += 1
            self.emit("page_fetching", url=url, depth=depth, index=attempts, max_pages=self.max_pages)
            try:
                res = self.fetcher.fetch(url, host_ok=self._host_ok)
                if res.status_code >= 400:
                    raise FetchError(f"HTTP_{res.status_code}", f"HTTP {res.status_code}", res.status_code)
                self.emit(
                    "page_fetched", url=url, status=res.status_code, bytes=len(res.body),
                    ms=res.duration_ms, truncated=res.truncated,
                )
                ex = extract_page(res.body, res.final_url, charset=res.charset)
            except FetchError as exc:
                failures.append(PageFailure(url=url, depth=depth, code=exc.code, error=exc.message, status_code=exc.status_code))
                self.emit("page_failed", url=url, code=exc.code, error=exc.message)
                continue
            except UrlValidationError as exc:  # defensive: validate() already wrapped in fetch
                failures.append(PageFailure(url=url, depth=depth, code=exc.code, error=exc.message))
                self.emit("page_failed", url=url, code=exc.code, error=exc.message)
                continue
            except Exception as exc:  # parser bugs must not kill the whole crawl
                failures.append(PageFailure(url=url, depth=depth, code="EXTRACTION_ERROR", error=f"{exc.__class__.__name__}: {exc}"))
                self.emit("page_failed", url=url, code="EXTRACTION_ERROR", error=str(exc))
                continue

            pages.append(
                PageResult(
                    url=url, final_url=res.final_url, depth=depth, status_code=res.status_code,
                    title=ex.title, meta_description=ex.meta_description, headings=ex.headings,
                    text=ex.text, text_truncated=ex.text_truncated, word_count=ex.word_count,
                    internal_links=ex.internal_links, external_links=ex.external_links,
                    content_truncated=res.truncated, fetch_ms=res.duration_ms,
                )
            )
            self.emit(
                "page_extracted", url=url, words=ex.word_count, internal_links=len(ex.internal_links),
                external_links=len(ex.external_links), title=ex.title,
            )

            if depth < self.max_depth:
                for link in ex.internal_links:
                    canon = canonicalize_url(link)
                    if canon in seen or not is_crawlable_link(canon):
                        continue
                    if urlsplit(canon).scheme not in ("http", "https"):
                        continue
                    seen.add(canon)
                    discovered += 1
                    queue.append((canon, depth + 1))

        # pages still queued when we stopped count as discovered but not crawled
        if not pages:
            status = "failure"
        elif failures:
            status = "partial"
        else:
            status = "success"

        stats = CrawlStats(
            pages_discovered=discovered,
            pages_crawled=len(pages),
            pages_failed=len(failures),
            pages_skipped_robots=len(robots_blocked),
            total_words=sum(p.word_count for p in pages),
            duration_ms=int((time.monotonic() - t0) * 1000),
        )
        error = None
        if status == "failure":
            if failures:
                f0 = failures[0]
                error = ErrorInfo(code=f0.code, message=f"Could not crawl {f0.url}: {f0.error}")
            elif self._robots_error is not None:
                error = self._robots_error  # root cause: the site could not be reached at all
            elif robots_blocked:
                error = ErrorInfo(code="ROBOTS_DISALLOWED", message="robots.txt does not allow crawling this site.")
            else:
                error = ErrorInfo(code="NO_PAGES", message="No pages were crawled.")

        summary = summarize(pages)
        self.emit("crawl_complete", status=status, **stats.model_dump())
        return CrawlResult(
            status=status, start_url=start, options=options, pages=pages, failures=failures,
            robots_blocked=robots_blocked, warnings=warnings, stats=stats, summary=summary, error=error,
        )
