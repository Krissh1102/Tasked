"""Deterministic extractive summariser.

Deliberately NOT an LLM: crawled text is untrusted, and keeping it away from any
model means a malicious page cannot inject instructions into the summary step.
The summary only ever selects sentences/keywords that literally appear on the
crawled pages.
"""

from __future__ import annotations

import re
from collections import Counter

from .schemas import PageResult, Summary

STOPWORDS = set(
    """a about above after again all also am an and any are as at be because been before being below between both
    but by can could did do does doing down during each few for from further had has have having he her here hers
    him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over
    own same she should so some such than that the their theirs them then there these they this those through to too
    under until up very was we were what when where which while who whom why will with would you your yours more
    may use used using one two""".split()
)
_WORD = re.compile(r"[A-Za-z][A-Za-z'-]{2,}")
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])")
MIN_SENT, MAX_SENT = 35, 280


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text) if w.lower() not in STOPWORDS]


def summarize(pages: list[PageResult], *, max_points: int = 4, max_keywords: int = 8) -> Summary:
    if not pages:
        return Summary(text="No pages were crawled successfully, so there is nothing to summarize.")

    corpus = " ".join(p.text for p in pages)
    freq = Counter(_words(corpus))
    keywords = [w for w, _ in freq.most_common(max_keywords) if len(w) >= 4][:max_keywords]

    candidates: list[tuple[float, int, str]] = []
    seen_prefix: set[str] = set()
    order = 0
    for page_idx, page in enumerate(pages):
        for sent in _SENT_SPLIT.split(page.text):
            sent = sent.strip()
            if not (MIN_SENT <= len(sent) <= MAX_SENT):
                continue
            ws = _words(sent)
            if len(ws) < 4:
                continue
            key = sent[:60].lower()
            if key in seen_prefix:
                continue
            seen_prefix.add(key)
            score = sum(freq[w] for w in ws) / (len(ws) ** 0.5)
            if page_idx == 0:
                score *= 1.25  # the entry page best represents the site
            candidates.append((score, order, sent))
            order += 1

    top = sorted(candidates, key=lambda c: -c[0])[:max_points]
    key_points = [s for _, _, s in sorted(top, key=lambda c: c[1])]

    first = pages[0]
    name = first.title or first.final_url
    parts = [f"{name} — crawled {len(pages)} page{'s' if len(pages) != 1 else ''}."]
    if first.meta_description:
        parts.append(first.meta_description.rstrip(".") + ".")
    elif key_points:
        parts.append(key_points[0])
    heads = [h for p in pages for h in p.headings.h1 + p.headings.h2][:4]
    if heads:
        parts.append("Main sections: " + "; ".join(dict.fromkeys(heads)) + ".")
    if keywords:
        parts.append("Recurring topics: " + ", ".join(keywords[:6]) + ".")
    return Summary(text=" ".join(parts), key_points=key_points, keywords=keywords)
