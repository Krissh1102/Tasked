"""Pydantic models describing the crawler's JSON output (schema_version 1.0)."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"
TOOL_NAME = "taskforge-crawler"
TOOL_VERSION = "1.0.0"


class Headings(BaseModel):
    h1: list[str] = Field(default_factory=list)
    h2: list[str] = Field(default_factory=list)
    h3: list[str] = Field(default_factory=list)
    h4: list[str] = Field(default_factory=list)
    h5: list[str] = Field(default_factory=list)
    h6: list[str] = Field(default_factory=list)


class PageResult(BaseModel):
    url: str
    final_url: str
    depth: int
    status_code: int
    title: Optional[str] = None
    meta_description: Optional[str] = None
    headings: Headings = Field(default_factory=Headings)
    text: str = ""
    text_truncated: bool = False
    word_count: int = 0
    internal_links: list[str] = Field(default_factory=list)
    external_links: list[str] = Field(default_factory=list)
    content_truncated: bool = False  # response body hit the size limit
    fetch_ms: int = 0


class PageFailure(BaseModel):
    url: str
    depth: int
    code: str
    error: str
    status_code: Optional[int] = None


class CrawlStats(BaseModel):
    pages_discovered: int = 0
    pages_crawled: int = 0
    pages_failed: int = 0
    pages_skipped_robots: int = 0
    total_words: int = 0
    duration_ms: int = 0


class CrawlOptions(BaseModel):
    max_pages: int
    max_depth: int
    timeout_s: float
    max_bytes: int
    same_domain_only: bool = True
    respect_robots: bool = True


class Summary(BaseModel):
    method: Literal["extractive"] = "extractive"
    text: str = ""
    key_points: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)


class ErrorInfo(BaseModel):
    code: str
    message: str


class CrawlResult(BaseModel):
    schema_version: str = SCHEMA_VERSION
    tool: str = TOOL_NAME
    tool_version: str = TOOL_VERSION
    status: Literal["success", "partial", "failure"]
    start_url: str
    options: Optional[CrawlOptions] = None
    pages: list[PageResult] = Field(default_factory=list)
    failures: list[PageFailure] = Field(default_factory=list)
    robots_blocked: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    stats: CrawlStats = Field(default_factory=CrawlStats)
    summary: Optional[Summary] = None
    error: Optional[ErrorInfo] = None
