from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import re
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from readability import Document

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("readfree")

# MongoDB (kept for platform parity; not used actively)
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI()
api_router = APIRouter(prefix="/api")

# ---------- Config ----------

ARCHIVE_MIRRORS = [
    "https://archive.ph",
    "https://archive.is",
    "https://archive.today",
]

UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
)

SNAPSHOT_PATTERN = re.compile(
    r"^https?://archive\.(?:is|ph|today|li|md|vn|fo)/([A-Za-z0-9]{4,8})/?$"
)

REQUEST_HEADERS = {
    "User-Agent": UA,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}

TIMEOUT = httpx.Timeout(25.0, connect=15.0)

# ---------- Models ----------

class ResolveRequest(BaseModel):
    url: str = Field(..., description="Original article URL to resolve via archive.is")


class ExtractRequest(BaseModel):
    html: str = Field(..., description="Raw snapshot HTML fetched by the client")
    url: str = Field(..., description="Original source URL (for domain + link base)")
    snapshot_url: Optional[str] = Field(
        default=None, description="archive.is snapshot URL the client resolved to"
    )


class ResolveResponse(BaseModel):
    title: str
    content_html: str
    source_url: str
    source_domain: str
    snapshot_url: str
    byline: Optional[str] = None


# ---------- Helpers ----------

def _domain_of(url: str) -> str:
    try:
        host = urlparse(url).hostname or ""
        return host.lower().removeprefix("www.")
    except Exception:
        return ""


def _extract_first_snapshot(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "lxml")
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith("//"):
            href = "https:" + href
        if SNAPSHOT_PATTERN.match(href.rstrip("/")):
            return href.rstrip("/")
    return None


async def _fetch(session: httpx.AsyncClient, url: str) -> httpx.Response:
    return await session.get(url, headers=REQUEST_HEADERS, follow_redirects=True)


def _strip_archive_chrome(html: str) -> str:
    """Remove archive.is injected toolbar / challenge UI before readability."""
    soup = BeautifulSoup(html, "lxml")
    for sel in [
        "#HEADER", "#FOOTER", "#HEAD", "#HEAD_BLOCK", "#TOP", "#TOP_BLOCK",
        "#SHARE_LONGLINK_BLOCK", "#DIVALERT", "#archive",
        ".g-recaptcha", "script", "noscript", "style",
        "iframe[src*='recaptcha']", "iframe[src*='archive']",
    ]:
        for tag in soup.select(sel):
            tag.decompose()
    return str(soup)


def _absolutize_assets(content_html: str, base_url: str) -> str:
    soup = BeautifulSoup(content_html, "lxml")
    parsed = urlparse(base_url)
    base_root = f"{parsed.scheme}://{parsed.hostname}" if parsed.scheme and parsed.hostname else ""

    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or img.get("data-original") or ""
        if not src:
            img.decompose()
            continue
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/") and base_root:
            src = base_root + src
        img["src"] = src
        if img.has_attr("srcset"):
            del img["srcset"]
        if img.has_attr("data-src"):
            del img["data-src"]

    for tag in soup.find_all(["script", "noscript", "style"]):
        tag.decompose()
    return str(soup)


def _readability_extract(html: str, source_url: str, snapshot_url: str) -> ResolveResponse:
    cleaned = _strip_archive_chrome(html)
    try:
        doc = Document(cleaned)
        title = (doc.short_title() or "").strip() or _domain_of(source_url)
        summary_html = doc.summary(html_partial=True)
    except Exception as e:
        logger.exception("Readability failed")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract article content: {e}",
        )

    if not summary_html or len(summary_html) < 200:
        raise HTTPException(
            status_code=422,
            detail="Could not extract readable content from the snapshot.",
        )

    content_html = _absolutize_assets(summary_html, source_url)

    return ResolveResponse(
        title=title,
        content_html=content_html,
        source_url=source_url,
        source_domain=_domain_of(source_url),
        snapshot_url=snapshot_url or source_url,
    )


async def _resolve_snapshot(target_url: str) -> tuple[str, str]:
    """Server-side attempt (fast-path). Will often be blocked from datacenter IPs."""
    last_error: Optional[str] = None

    async with httpx.AsyncClient(timeout=TIMEOUT, http2=False) as session:
        for mirror in ARCHIVE_MIRRORS:
            index_url = f"{mirror}/newest/{target_url}"
            try:
                idx_resp = await _fetch(session, index_url)
            except httpx.RequestError as e:
                last_error = f"network:{e.__class__.__name__}"
                continue

            final_url = str(idx_resp.url).rstrip("/")
            if SNAPSHOT_PATTERN.match(final_url) and idx_resp.status_code == 200:
                return final_url, idx_resp.text

            if idx_resp.status_code in (429, 403) or "g-recaptcha" in idx_resp.text[:20000]:
                last_error = "blocked_by_archive"
                continue
            if idx_resp.status_code >= 400:
                last_error = f"index_status:{idx_resp.status_code}"
                continue

            snapshot = _extract_first_snapshot(idx_resp.text)
            if not snapshot:
                last_error = "no_snapshot_found"
                continue

            try:
                snap_resp = await _fetch(session, snapshot)
            except httpx.RequestError as e:
                last_error = f"snapshot_network:{e.__class__.__name__}"
                continue

            if snap_resp.status_code != 200 or "g-recaptcha" in snap_resp.text[:20000]:
                last_error = f"snapshot_bad:{snap_resp.status_code}"
                continue

            return snapshot, snap_resp.text

    if last_error == "no_snapshot_found":
        raise HTTPException(
            status_code=404,
            detail="No archived version found for this article.",
        )
    if last_error == "blocked_by_archive":
        # Signal to client that it should retry via its WebView path.
        raise HTTPException(
            status_code=451,
            detail="Server-side fetch blocked by archive.is. Client will retry via on-device fetch.",
        )
    raise HTTPException(
        status_code=502,
        detail="Could not reach archive. Check your connection.",
    )


# ---------- Routes ----------

@api_router.get("/")
async def root():
    return {"service": "ReadFree proxy", "status": "ok"}


@api_router.get("/health")
async def health():
    return {"status": "ok"}


@api_router.post("/resolve", response_model=ResolveResponse)
async def resolve_article(payload: ResolveRequest):
    """
    Primary server-side path: fetch archive.is index + first snapshot,
    run readability. Returns HTTP 451 when our datacenter IP is blocked so
    the client falls back to its on-device fetcher.
    """
    raw_url = payload.url.strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="URL is required.")
    if not raw_url.lower().startswith(("http://", "https://")):
        raw_url = "https://" + raw_url

    parsed = urlparse(raw_url)
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid URL.")

    logger.info("Resolving %s (server-side attempt)", raw_url)

    snapshot_url, snapshot_html = await _resolve_snapshot(raw_url)
    return _readability_extract(snapshot_html, raw_url, snapshot_url)


@api_router.post("/extract", response_model=ResolveResponse)
async def extract_article(payload: ExtractRequest):
    """
    Client-fed path: the app's hidden WebView fetched the archive snapshot
    (using the device's IP, which archive.is doesn't block), and POSTs the
    resulting HTML here. We run readability and return clean content.
    """
    raw_url = payload.url.strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="Source URL is required.")
    if not raw_url.lower().startswith(("http://", "https://")):
        raw_url = "https://" + raw_url

    if not payload.html or len(payload.html) < 500:
        raise HTTPException(
            status_code=400, detail="HTML payload is empty or too short."
        )

    # Reject obvious captcha / block pages so client can retry
    head = payload.html[:30000]
    if "g-recaptcha" in head or "Please enable JavaScript" in head and len(payload.html) < 20000:
        raise HTTPException(
            status_code=451,
            detail="archive.is returned a challenge page. Please try again in a moment.",
        )

    snapshot_url = (payload.snapshot_url or raw_url).strip()
    return _readability_extract(payload.html, raw_url, snapshot_url)


# ---------- App wiring ----------

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
