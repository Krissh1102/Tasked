"""Command-line entry point:  python -m crawler.cli --url https://example.com

stdout : exactly one JSON document (CrawlResult, or an error object)
stderr : human-readable logs plus machine-readable progress lines prefixed
         with '@@TASKFORGE@@ ' (JSON), which the Node backend turns into SSE.

Exit codes
  0  success or partial (usable JSON on stdout; see "status")
  1  unexpected internal error
  2  invalid arguments / rejected URL
  3  crawl failed (no pages crawled; JSON with "error" on stdout)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from typing import Any

from .crawler import Crawler
from .fetcher import SafeFetcher
from .schemas import SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION
from .security import UrlValidationError

EVENT_PREFIX = "@@TASKFORGE@@ "
EXIT_OK, EXIT_INTERNAL, EXIT_INVALID, EXIT_CRAWL_FAILED = 0, 1, 2, 3


def _emit(event: str, **fields: Any) -> None:
    sys.stderr.write(EVENT_PREFIX + json.dumps({"event": event, "t": time.time(), **fields}, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def _bounded_int(lo: int, hi: int):
    def parse(value: str) -> int:
        try:
            n = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"'{value}' is not an integer")
        if not lo <= n <= hi:
            raise argparse.ArgumentTypeError(f"must be between {lo} and {hi}")
        return n

    return parse


def _bounded_float(lo: float, hi: float):
    def parse(value: str) -> float:
        try:
            n = float(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"'{value}' is not a number")
        if not lo <= n <= hi:
            raise argparse.ArgumentTypeError(f"must be between {lo} and {hi}")
        return n

    return parse


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m crawler.cli", description="TaskForge website crawler")
    p.add_argument("--url", required=True, help="http(s) URL to start crawling from")
    p.add_argument("--max-pages", type=_bounded_int(1, 50), default=5)
    p.add_argument("--max-depth", type=_bounded_int(0, 5), default=2)
    p.add_argument("--output", choices=["json"], default="json")
    p.add_argument("--timeout", type=_bounded_float(1, 60), default=10.0, help="per-request timeout (s)")
    p.add_argument("--max-bytes", type=_bounded_int(10_000, 10_000_000), default=2_000_000, help="max bytes per page")
    p.add_argument("--delay", type=_bounded_float(0, 10), default=0.2, help="politeness delay between requests (s)")
    p.add_argument("--time-budget", type=_bounded_float(1, 600), default=45.0, help="overall crawl budget (s)")
    return p


def _error_doc(url: str, code: str, message: str) -> dict:
    return {
        "schema_version": SCHEMA_VERSION, "tool": TOOL_NAME, "tool_version": TOOL_VERSION,
        "status": "failure", "start_url": url, "pages": [], "failures": [], "robots_blocked": [],
        "warnings": [], "stats": {"pages_discovered": 0, "pages_crawled": 0, "pages_failed": 0,
                                  "pages_skipped_robots": 0, "total_words": 0, "duration_ms": 0},
        "summary": None, "error": {"code": code, "message": message},
    }


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    fetcher = SafeFetcher(timeout=args.timeout, total_timeout=max(args.timeout * 2, 15.0), max_bytes=args.max_bytes)
    try:
        _emit("started", url=args.url, max_pages=args.max_pages, max_depth=args.max_depth)
        crawler = Crawler(
            args.url, max_pages=args.max_pages, max_depth=args.max_depth, fetcher=fetcher,
            timeout_s=args.timeout, max_bytes=args.max_bytes, delay=args.delay,
            time_budget=args.time_budget, respect_robots=True, emit=_emit,
        )
        result = crawler.run()
        sys.stdout.write(json.dumps(result.model_dump(mode="json"), ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()
        return EXIT_CRAWL_FAILED if result.status == "failure" else EXIT_OK
    except UrlValidationError as exc:
        _emit("rejected", code=exc.code, message=exc.message)
        print(f"error: {exc.code}: {exc.message}", file=sys.stderr)
        sys.stdout.write(json.dumps(_error_doc(args.url, exc.code, exc.message)) + "\n")
        return EXIT_INVALID
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # never leak a traceback on stdout
        traceback.print_exc(file=sys.stderr)
        sys.stdout.write(json.dumps(_error_doc(args.url, "INTERNAL_ERROR", f"{exc.__class__.__name__}: {exc}")) + "\n")
        return EXIT_INTERNAL
    finally:
        fetcher.close()


if __name__ == "__main__":
    sys.exit(main())
