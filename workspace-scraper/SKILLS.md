# SKILLS.md

## Core skills

- **fetch(url)** — HTTP GET with proper UA + rate limit + retry. Return HTML +
  status + final URL.
- **extract-article(html)** — title, dateline, body text, hero image, author,
  tags. Used by Crawler when LLM-grade understanding isn't needed.
- **extract-listing(html, selectors)** — list of items per CSS/XPath selectors.
- **extract-jsonld(html)** — pull all structured data blobs.
- **geocode(query)** — area/place name → lat/lng (Google Geocoding API,
  cached aggressively).
- **read-inbox-xlsx(path?, status?, month?)** — read the article tracker xlsx
  from `/opt/.openclaw-ess/inbox/articles/*.xlsx`, return JSON list of rows
  ready for Copywriter / Web Manager to ingest.
- **pull-xlsx-from-drive(name?)** — download the article tracker xlsx from
  Google Drive (auto-exports Google Sheets to xlsx). Replaces the local rsync
  bridge once the operator's local copy goes away. Uses the same OAuth token
  as the Doc reader (`ai@gaiada.com`).
- **read-google-doc(url)** — fetch a Google Doc body as Markdown. Auth: user
  OAuth. Doc must be shared with `ai@gaiada.com`.
- **check-doc-access()** — for each Draft Link in the inbox xlsx, report
  whether `ai@gaiada.com` can read it; output an actionable list of docs to
  share.

## Implementation

### Node side
- Inherits Node 20+ runtime from the openclaw-ess gateway.
- Stateless helpers; no long-running processes here.

### Python side (xlsx + heavier extractors)
- venv at `workspace-scraper/venv/` with `openpyxl`, `requests`, `bs4`.
- Cache: SQLite at `state/cache.sqlite` keyed on (url, date_yyyy_mm_dd).

```bash
# read latest xlsx in inbox, all sheets, ready-to-create rows
./scripts/read-articles-xlsx.py

# only one month + only Drafts
./scripts/read-articles-xlsx.py --month=Apr --status=draft

# write JSON to a file for Web Manager
./scripts/read-articles-xlsx.py --out=/tmp/queue.json
```

## Inbox bridge (local → gda-ai01)

Local Mac-side helper script (in repo at `bridge/sync-articles-inbox.sh`)
rsyncs `~/Downloads/essentialbaliNopenclaw/articles/` →
`gda-ai01:/opt/.openclaw-ess/inbox/articles/`.

Run it after editing the xlsx. The xlsx reader skill picks up the latest file
automatically.

## Output contract

```jsonc
{
  "file": "/opt/.openclaw-ess/inbox/articles/Essential Bali Proofread.xlsx",
  "count": 8,
  "rows": [
    {
      "month": "Apr",
      "row": 2,
      "no": 1.0,
      "title": "10 Best Canggu Places to Stay with Direct Hidden Beach Access",
      "slug": "10-best-canggu-places-to-stay-with-direct-hidden-beach-access",
      "topic_brief": "Mentioning many places to stay around Canggu...",
      "meta_description": "Your dream coastal retreat starts here...",
      "keywords": ["Canggu places to stay"],
      "draft_link": "https://docs.google.com/document/d/.../edit",
      "writer": "Sofia",
      "article_status": "draft",
      "guessed_area": "canggu",
      "guessed_topic": "featured"
    }
  ]
}
```

`guessed_area` / `guessed_topic` are best-effort heuristics. Web Manager should
double-check before pushing to Payload (or have the human approve in the queue
before publish).

## Constraints

- Never commit the xlsx or its contents to git — sync via rsync, keep on disk.
- Treat draft-link Google Docs as PRIVATE — fetch only if explicitly enabled
  with OAuth, never via anonymous unfurl.
