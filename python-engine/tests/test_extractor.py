from crawler.extractor import extract_page, is_crawlable_link
from crawler.summarizer import summarize
from crawler.schemas import PageResult

HTML = b"""<html><head><title>  My   Site </title>
<meta name="description" content="A  test   description">
<base href="https://example.com/docs/">
<script>evil()</script><style>p{}</style></head>
<body><nav>NAVTEXT</nav><h1>Main</h1><h2>Sub A</h2><h2>Sub B</h2><h6>Tiny</h6>
<main><p>Hello   world. This is the real content of the page.</p>
<a href="guide">Rel</a><a href="/abs">Abs</a><a href="https://example.com/abs#x">Dup</a>
<a href="https://www.example.com/www">Www</a><a href="https://other.org/p">Ext</a>
<a href="mailto:a@b.c">M</a><a href="javascript:void(0)">J</a><a href="#top">Top</a><a href="tel:123">T</a></main>
<footer>FOOTERTEXT</footer></body></html>"""


def test_extracts_metadata_headings_and_text():
    ex = extract_page(HTML, "https://example.com/docs/index.html")
    assert ex.title == "My Site"
    assert ex.meta_description == "A test description"
    assert ex.headings.h1 == ["Main"]
    assert ex.headings.h2 == ["Sub A", "Sub B"]
    assert ex.headings.h6 == ["Tiny"]
    assert "Hello world. This is the real content of the page." in ex.text
    assert "evil" not in ex.text and "NAVTEXT" not in ex.text and "FOOTERTEXT" not in ex.text
    assert ex.word_count == len(ex.text.split())


def test_link_classification_and_dedup():
    ex = extract_page(HTML, "https://example.com/docs/index.html")
    assert ex.internal_links == [
        "https://example.com/docs/guide",  # resolved against <base>
        "https://example.com/abs",
        "https://www.example.com/www",  # www counts as same site
    ]
    assert ex.external_links == ["https://other.org/p"]


def test_body_fallback_strips_chrome_when_no_main():
    ex = extract_page(b"<html><body><nav>NAV</nav><p>Body paragraph here.</p><footer>FOOT</footer></body></html>", "http://a.com/")
    assert ex.text == "Body paragraph here."


def test_title_falls_back_to_h1():
    ex = extract_page(b"<html><body><h1>Only H1</h1></body></html>", "http://a.com/")
    assert ex.title == "Only H1"


def test_text_truncation_flag():
    big = ("<html><body><main>" + "word " * 10000 + "</main></body></html>").encode()
    ex = extract_page(big, "http://a.com/")
    assert ex.text_truncated and len(ex.text) <= 20000
    assert ex.word_count == 10000  # counted before truncation


def test_garbage_html_does_not_crash():
    ex = extract_page(b"<<<div><p>unclosed <b>bold<a href=>x", "http://a.com/")
    assert isinstance(ex.text, str)


def test_is_crawlable_link():
    assert is_crawlable_link("https://a.com/page")
    assert is_crawlable_link("https://a.com/")
    assert not is_crawlable_link("https://a.com/doc.PDF")
    assert not is_crawlable_link("https://a.com/img/logo.png")


def test_summary_uses_only_extracted_content():
    page = PageResult(
        url="http://a/", final_url="http://a/", depth=0, status_code=200, title="Acme",
        meta_description="Acme makes widgets.",
        text="Acme builds reliable industrial widgets for factories. Widgets from Acme are tested for durability. Short one.",
    )
    s = summarize([page])
    assert s.method == "extractive"
    assert "Acme" in s.text and "widgets" in s.keywords
    for kp in s.key_points:
        assert kp in page.text  # sentences are copied verbatim, never invented


def test_summary_empty():
    assert "nothing to summarize" in summarize([]).text


def test_headings_do_not_run_into_following_text():
    html = b"<html><body><main><h1>Acme Co</h1><h2>What we do</h2><p>We build reliable widgets for factories.</p></main></body></html>"
    ex = extract_page(html, "http://a.com/")
    assert ex.text == "Acme Co. What we do. We build reliable widgets for factories."
    assert ex.headings.h1 == ["Acme Co"]  # captured headings stay clean
    assert ex.word_count == 11
