# ReadFree — Product Requirements Document

## Purpose
ReadFree lets users read paywalled articles for free by silently resolving
archive.is snapshots and rendering them in a clean, native mobile reader view.
Built for personal use — no publishing, no user accounts, no bookmarks.

Platform: **Android APK (sideloaded) via Expo**. iOS not targeted.

## User Flows

### 1. Manual paste
1. User opens the app → home screen.
2. Pastes a URL (clipboard icon inside input or types).
3. Taps **READ ARTICLE**.
4. Reader view opens → shows resolving state → clean article or friendly error.

### 2. Android Share Target
1. User shares a URL from any app (Chrome, Twitter, etc.) → picks **ReadFree**.
2. App opens directly in the reader view for that URL.

(The share intent filter is registered in `app.json`. Works in the installed
APK; not in web preview.)

## Architecture

### Why hybrid?
archive.is aggressively blocks datacenter IPs (AWS / GCP / Cloudflare) with a
reCAPTCHA challenge. A naïve server-side proxy — whether FastAPI, Cloudflare
Worker, or Vercel function — will fail for real URLs. ReadFree therefore uses a
three-tier resolver:

```
┌─ USER DEVICE (Expo) ──────────────┐      ┌─ BACKEND (FastAPI) ──────────────┐
│ 1. POST /api/resolve  ──────────► │      │  (a) Fetch ORIGINAL URL as       │
│                       ◄──article──│      │      Googlebot/FB/Twitter UA.    │
│ OR 451 →                          │      │      Most paywalled sites serve  │
│                                   │      │      full content for SEO.       │
│ 2. Hidden WebView fetches archive │      │  (b) If (a) has no content,      │
│    on the user's residential IP   │      │      fetch archive.is index +    │
│ 3. Posts raw HTML to /api/extract │      │      snapshot. Often blocked.    │
│                       ──────────► │      │  (c) If (b) blocked → 451.       │
│                       ◄──JSON──── │      │                                  │
│ 4. Renders with react-native-     │      │  /api/extract: run readability-  │
│    render-html (serif, themed)    │      │  lxml on client-supplied HTML.   │
└───────────────────────────────────┘      └──────────────────────────────────┘
```

**Bot-UA direct fetch** is the new primary path and works for HBR, FT, WSJ,
Bloomberg, Medium, The Atlantic, Forbes, The Economist, most Substack posts,
etc. — any site that serves full content to Googlebot for SEO indexing. NYT
recently started blocking crawlers with HTTP 403, so that site falls through
to the archive.is path.

- On-device WebView uses the phone's mobile/Wi-Fi IP, which archive.is
  typically allows. The hidden WebView probes the archive index page, grabs
  the first snapshot link matching `archive.{is|ph|today}/XXXXX`, navigates
  to it, then hands the rendered HTML to the backend.
- Backend runs `readability-lxml` (mozilla-readability port) to strip
  archive.is toolbar, navigation, ads, and return pure article HTML.
- On web preview, the WebView fallback cannot run (archive.is blocks iframe
  embedding via X-Frame-Options). The app shows a clear error message
  in that case. Real Android APK is the target runtime.

## API

| Endpoint            | Method | Purpose                                         |
| ------------------- | ------ | ----------------------------------------------- |
| `/api/health`       | GET    | Liveness check                                  |
| `/api/resolve`      | POST   | Three-tier server-side resolve:  (a) direct bot-UA fetch → (b) Jina Reader → (c) archive.is |
| `/api/extract`      | POST   | Run readability on client-fed snapshot HTML     |

`POST /api/resolve` body: `{"url": "..."}` → `ResolveResponse` or
HTTP 404 / 451 / 502 with `{"detail": "..."}`.

`POST /api/extract` body: `{"html": "...", "url": "...", "snapshot_url": "..."}` →
`ResolveResponse` or HTTP 400 / 451 / 422.

`ResolveResponse`:
```json
{
  "title": "…",
  "content_html": "<div>…</div>",
  "source_url": "https://…",
  "source_domain": "example.com",
  "snapshot_url": "https://archive.ph/AbCd1",
  "byline": null
}
```

## Screens

### Home (`app/index.tsx`)
- Top bar: `READFREE` wordmark (left) + theme toggle (right).
- Headline `Read anything.` + subcopy.
- 56px URL input with inline paste / clear icon.
- Black/white primary **READ ARTICLE** button.
- Footer: `VIA ARCHIVE.IS / ARCHIVE.PH`.

### Reader (`app/reader.tsx`)
- Top bar: back chevron (left) • uppercase `SOURCE.COM` (center) • theme toggle (right).
- Loading state: activity indicator + typographic pulse (`FINDING SNAPSHOT…`,
  `RESOLVING ARCHIVE…`, `LOADING SNAPSHOT…`, `EXTRACTING ARTICLE…`).
- Error state: red badge + `Something went wrong` + friendly message +
  **TRY AGAIN** / **BACK** buttons.
- Article: domain caption → h2 title → divider → serif 18/28 body via
  `react-native-render-html` → **OPEN FULL SNAPSHOT** link.

## Design System
- Archetype: Swiss / editorial brutalism. No AI-slop gradients.
- Light/dark toggle (persists in-memory for the session; respects system by default).
- Typography: system sans-serif for UI, system serif for reader body (18sp / 28 line-height).
- Touch targets ≥ 44×44. Spacing on 8pt grid. Borders 1px.

## Out of Scope
- User accounts / login
- Bookmarks or history
- iOS build
- App store submission
- Publishing / sharing

## Known Limitations
- Web preview cannot fully demonstrate the reader happy path because
  archive.is blocks iframe embedding. The APK build is the real target.
- archive.is rate-limits aggressive clients. Users may briefly see the
  "archive is showing a challenge page" error; retrying after a minute
  usually succeeds.

## Future Enhancements (Monetization / Growth)
- **Shareable clean URLs** — one-tap copy of the clean-reader URL so users
  evangelize the app. Each shared link carries a `?src=readfree` utm that
  opens in ReadFree if installed, or falls back to a mobile install page.
  This turns the app itself into its own distribution channel with zero
  marketing spend — the canonical growth loop for personal-utility reading
  tools (cf. Instapaper, Pocket).
