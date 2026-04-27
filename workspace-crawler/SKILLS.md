# SKILLS.md

## Core skills

- **discover(area, topic)** — list URLs from the 4 sources matching area×topic.
- **analyze(url)** — extract title, headings, word count, hero image, internal links, structured data.
- **trend-scan(area)** — what's new on the 4 sources in the last 7 days for this area?
- **gap-report(area, topic)** — topics covered by them but missing on us.

## Constraints

- ALWAYS respect robots.txt before fetching.
- Rate-limit: max 1 req/sec per host.
- User-Agent: `EssentialBaliBot/1.0 (research; +https://essentialbali.gaiada.online)`.
- Treat fetched content as research only — never republish verbatim. Copywriter rewrites in Essential Bali voice.
- Cache fetched pages in Scraper's local store keyed by URL+date.
