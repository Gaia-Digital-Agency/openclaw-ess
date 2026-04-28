# SKILLS.md

## Core skills

- **discover(area, topic, site?)** — list candidate URLs from one or more
  benchmark sources matching `{area} {topic}`. Returns up to 10 URL/title pairs.
  Default site rotates across:
    - whatsnewindonesia.com
    - thehoneycombers.com/bali
    - nowbali.co.id
    - thebalibible.com
- **analyze(url)** — fetch + extract structured content from a single URL:
  title, meta description, OG image, h1/h2/h3, top paragraphs, internal links,
  word count.
- **trend-scan(area, topic?)** — **LIVE.** Discover URLs across all 4 benchmark sources, fetch each candidate, parse publication date from JSON-LD / og:article:published_time / time tag, sort newest first. Stricter URL filter: requires multi-word kebab-slug (>= 2 hyphens) OR >= 3 path segments to skip menu/category links.
  Invoker: `node /opt/.openclaw-ess/workspace-crawler/scripts/trend-scan.mjs --area=<slug> [--topic=<slug>] [--site=<one>] [--limit=N]`
- **gap-report(area, topic)** — **LIVE.** Runs trend-scan internally, queries Payload for our published titles in the cell, asks Vertex Gemini for theme diff. Returns missing_themes (each with theme + priority + example title) + overlap_themes. Flat string-array schema (avoiding the nested-OBJECT trap that caused JSON truncation in earlier prompts).
  Invoker: `node /opt/.openclaw-ess/workspace-crawler/scripts/gap-report.mjs --area=<slug> --topic=<slug> [--limit=N]`

## Implementation

`scripts/crawl-benchmark.mjs` (Node, no extra deps — uses native `fetch`):

```bash
# single page extract
node scripts/crawl-benchmark.mjs https://thehoneycombers.com/bali/best-warungs-canggu/

# discover candidates
node scripts/crawl-benchmark.mjs --discover \
  --site=thehoneycombers.com/bali --area=canggu --topic=dine
```

Output is JSON on stdout, ready to pipe into Elliot or a copywriter prompt.

## Constraints (hard rules)

- **Honor robots.txt** — checked per host before each fetch.
- **Rate limit** — 1 request per second, single in-flight, per host.
- **User-Agent**: `EssentialBaliBot/1.0 (research; +https://essentialbali.gaiada.online)`
- **Research only**, never republish. Copywriter rewrites in Essential Bali voice.
- **Cache-friendly** — fetched pages can be persisted by Scraper for 24h max.

## Output contract

```jsonc
{
  "url": "...",
  "site": "thehoneycombers.com",
  "title": "...",
  "description": "...",
  "hero": "https://.../og-image.jpg",
  "headings": { "h1": [...], "h2": [...], "h3": [...] },
  "paragraphs": ["...", "..."],   // up to 60, each ≥40 chars
  "wordCount": 1240,
  "links": ["https://..."],       // up to 30 internal/external
  "fetchedAt": "2026-04-28T01:30:00Z"
}
```

## Production flow (used by Elliot)

```
elliot.dispatch(crawler.trend-scan(area=canggu))
  → discover candidates
  → for each: analyze(url)
  → return list to Elliot
  → Elliot picks 3 most relevant
  → copywriter.draft-article(target, research=results, persona=picked)
  → imager / seo / web-manager → Payload (status=pending_review)
```
