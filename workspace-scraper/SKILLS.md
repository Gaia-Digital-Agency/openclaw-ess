# SKILLS.md

## Core skills

- **fetch(url)** — HTTP GET with proper UA + rate limit + retry. Return HTML + status + final URL.
- **extract-article(html)** — title, dateline, body text, hero image, author, tags.
- **extract-listing(html, selectors)** — list of items per CSS/XPath selectors.
- **extract-jsonld(html)** — pull all structured data blobs.
- **geocode(query)** — area/place name → lat/lng (use Google Geocoding API, cache aggressively).

## Tooling

- Python 3.11+, virtualenv at `workspace-scraper/venv/`.
- `requirements.txt`: requests, beautifulsoup4, lxml, dateparser, python-dotenv, googlemaps.
- Cache: SQLite at `state/cache.sqlite` keyed on (url, date_yyyy_mm_dd).
