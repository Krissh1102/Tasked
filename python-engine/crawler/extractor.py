"""HTML -> structured page data. All page content is treated as untrusted DATA:
it is only ever parsed and copied into JSON, never interpreted or executed."""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Comment

from .schemas import Headings
from .security import canonicalize_url, site_key

MAX_TEXT_CHARS = 20_000
MAX_HEADINGS_PER_LEVEL = 50
MAX_LINKS_PER_KIND = 200

NOISE_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "object", "embed"]
CHROME_TAGS = ["nav", "footer", "header", "aside", "form"]
SKIP_EXTENSIONS = {
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".zip", ".gz", ".tar",
    ".rar", ".7z", ".mp3", ".mp4", ".avi", ".mov", ".wav", ".css", ".js", ".json", ".xml", ".woff",
    ".woff2", ".ttf", ".eot", ".exe", ".dmg", ".iso", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
}
_WS = re.compile(r"\s+")


def _clean(text: str) -> str:
    return _WS.sub(" ", text).strip()


def is_crawlable_link(url: str) -> bool:
    path = urlsplit(url).path.lower()
    dot = path.rfind(".")
    return not (dot != -1 and path[dot:] in SKIP_EXTENSIONS)


class Extracted:
    __slots__ = (
        "title", "meta_description", "headings", "text", "text_truncated",
        "word_count", "internal_links", "external_links",
    )

    def __init__(self) -> None:
        self.title: Optional[str] = None
        self.meta_description: Optional[str] = None
        self.headings = Headings()
        self.text = ""
        self.text_truncated = False
        self.word_count = 0
        self.internal_links: list[str] = []
        self.external_links: list[str] = []


def extract_page(html: bytes | str, page_url: str, *, charset: Optional[str] = None) -> Extracted:
    if isinstance(html, bytes):
        soup = BeautifulSoup(html, "html.parser", from_encoding=charset)
    else:
        soup = BeautifulSoup(html, "html.parser")
    out = Extracted()

    # --- metadata ------------------------------------------------------
    if soup.title and soup.title.string is not None:
        out.title = _clean(soup.title.get_text()) or None
    desc = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)}) or soup.find(
        "meta", attrs={"property": re.compile(r"^og:description$", re.I)}
    )
    if desc and desc.get("content"):
        out.meta_description = _clean(str(desc["content"])) or None

    # --- links (before we strip anything) ------------------------------
    base_tag = soup.find("base", href=True)
    base_url = urljoin(page_url, str(base_tag["href"])) if base_tag else page_url
    page_site = site_key(urlsplit(page_url).hostname or "")
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = str(a["href"]).strip()
        if not href or href.startswith("#"):
            continue
        try:
            absolute = urljoin(base_url, href)
            parts = urlsplit(absolute)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not parts.hostname:
            continue
        canon = canonicalize_url(absolute)
        if canon in seen:
            continue
        seen.add(canon)
        if site_key(parts.hostname) == page_site:
            if len(out.internal_links) < MAX_LINKS_PER_KIND:
                out.internal_links.append(canon)
        elif len(out.external_links) < MAX_LINKS_PER_KIND:
            out.external_links.append(canon)

    # --- cleanup --------------------------------------------------------
    for tag in soup(NOISE_TAGS):
        tag.decompose()
    for c in soup.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()

    # --- headings -------------------------------------------------------
    for level in range(1, 7):
        items = getattr(out.headings, f"h{level}")
        for h in soup.find_all(f"h{level}"):
            t = _clean(h.get_text(" "))
            if t and len(items) < MAX_HEADINGS_PER_LEVEL:
                items.append(t)
    if not out.title and out.headings.h1:
        out.title = out.headings.h1[0]

    # Headings carry no sentence punctuation; add a terminator so they do not run into the next
    # paragraph (this only affects the flattened text, headings were already captured above).
    for h in soup.find_all(re.compile(r"^h[1-6]$")):
        nodes = [n for n in h.find_all(string=True) if str(n).strip()]
        if nodes and str(nodes[-1]).rstrip()[-1] not in ".!?:;":
            nodes[-1].replace_with(str(nodes[-1]).rstrip() + ".")

    # --- main text --------------------------------------------------------
    root = soup.find("main") or soup.find("article") or soup.find(attrs={"role": "main"})
    if root is None:
        root = soup.body or soup
        for tag in root.find_all(CHROME_TAGS):
            tag.decompose()
    text = _clean(root.get_text(" "))
    out.word_count = len(text.split()) if text else 0
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS].rsplit(" ", 1)[0]
        out.text_truncated = True
    out.text = text
    return out
