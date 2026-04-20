"""ReadFree backend API tests."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://readfree-preview.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---------- /api/health ----------
class TestHealth:
    def test_health_ok(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_root(self, api):
        r = api.get(f"{BASE_URL}/api/", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert data.get("status") == "ok"


# ---------- /api/resolve ----------
class TestResolve:
    def test_resolve_empty_url_returns_400(self, api):
        r = api.post(f"{BASE_URL}/api/resolve", json={"url": ""}, timeout=15)
        assert r.status_code == 400
        assert "detail" in r.json()

    def test_resolve_invalid_url_returns_400(self, api):
        # "not a url" -> prefixed with https:// -> hostname parse attempt
        # "://" doesn't add host properly; urlparse of "https://not a url" has hostname "not a url" actually.
        # Use a clearly malformed value: just whitespace
        r = api.post(f"{BASE_URL}/api/resolve", json={"url": "   "}, timeout=15)
        assert r.status_code == 400

    def test_resolve_real_url_expected_block_or_error(self, api):
        # Expected: 451 (blocked by archive), 502 (gateway), or 404 (no snapshot)
        # since datacenter IP is blocked by archive.is
        r = api.post(
            f"{BASE_URL}/api/resolve",
            json={"url": "https://www.wsj.com/articles/some-article-12345"},
            timeout=60,
        )
        assert r.status_code in (200, 404, 451, 502), f"Unexpected status {r.status_code}: {r.text[:200]}"
        body = r.json()
        if r.status_code != 200:
            assert "detail" in body
            assert isinstance(body["detail"], str) and len(body["detail"]) > 0


# ---------- /api/extract ----------
SAMPLE_HTML = """
<!DOCTYPE html>
<html>
<head>
  <title>Sample Article</title>
  <script>var x = 1;</script>
</head>
<body>
  <div id="HEADER">archive.is toolbar that should be removed</div>
  <div id="FOOTER">archive.is footer chrome</div>
  <article>
    <h1>The Quick Brown Fox</h1>
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus lacinia odio vitae vestibulum vestibulum. Cras venenatis euismod malesuada. In hac habitasse platea dictumst. Proin dapibus ornare ante, eu rutrum nibh placerat ut. Praesent vel neque vel sapien tincidunt vulputate.</p>
    <p>Suspendisse potenti. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae. Maecenas quis lorem eu lectus faucibus accumsan. Donec tristique lectus ac lorem pulvinar, at ultricies nunc dictum.</p>
    <img src="/images/hero.jpg" alt="hero"/>
    <p>Nulla facilisi. Integer et lorem vitae dui pellentesque ullamcorper. Cras ut felis nec lacus faucibus malesuada non sed justo. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas.</p>
  </article>
  <script>var tracking = true;</script>
</body>
</html>
""" + ("<p>Extra padding content.</p>" * 20)


class TestExtract:
    def test_extract_valid_returns_clean_article(self, api):
        r = api.post(
            f"{BASE_URL}/api/extract",
            json={
                "html": SAMPLE_HTML,
                "url": "https://example.com/article/sample",
                "snapshot_url": "https://archive.ph/abcd1",
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Required keys
        for key in ("title", "content_html", "source_domain", "source_url", "snapshot_url"):
            assert key in body, f"missing key {key}"
        # Archive chrome should be stripped
        assert "HEADER" not in body["content_html"] or "archive.is toolbar" not in body["content_html"]
        assert "<script" not in body["content_html"]
        # Relative img should be absolutized
        assert "https://example.com/images/hero.jpg" in body["content_html"]
        assert body["source_domain"] == "example.com"

    def test_extract_short_html_returns_400(self, api):
        r = api.post(
            f"{BASE_URL}/api/extract",
            json={"html": "<p>short</p>", "url": "https://example.com/x"},
            timeout=15,
        )
        assert r.status_code == 400
        assert "detail" in r.json()

    def test_extract_recaptcha_returns_451(self, api):
        captcha_html = (
            "<html><body>"
            + "<div class='g-recaptcha' data-sitekey='x'></div>"
            + ("<p>filler content to pass length check</p>" * 30)
            + "</body></html>"
        )
        assert len(captcha_html) >= 500
        r = api.post(
            f"{BASE_URL}/api/extract",
            json={"html": captcha_html, "url": "https://example.com/paywall"},
            timeout=15,
        )
        assert r.status_code == 451
        assert "detail" in r.json()

    def test_extract_empty_url_returns_400(self, api):
        r = api.post(
            f"{BASE_URL}/api/extract",
            json={"html": SAMPLE_HTML, "url": ""},
            timeout=15,
        )
        assert r.status_code == 400
