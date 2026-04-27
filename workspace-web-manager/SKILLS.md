# SKILLS.md

## Core skills

- **submit-article(article)** — POST to Payload `/api/articles` with status=pending_review.
- **upload-media(file, alt, credit)** — POST multipart to Payload `/api/media`, return media ID.
- **link-hero(article_id, media_id)** — PATCH article with hero image reference.
- **submit-comment(article_id, persona, body)** — POST to `/api/comments`.
- **toggle-hero-ad(area, topic, active)** — PATCH `/api/hero-ads` for the area×topic slot.
- **fetch-status(article_id)** — GET status (review/approved/published/rejected).
- **list-pending-review()** — for Elliot's status-report skill.

## Payload contract

- Base URL: `http://gda-s01:4008` (internal) — `PAYLOAD_AI_API_KEY` from env.
- Idempotency: always send `source.hash` so re-runs don't dupe.
- Errors: surface 4xx body to Elliot; retry 5xx with backoff up to 3 times.
- Required fields: title, slug, body_markdown, area, topic, persona, hero_media_id, meta_title, meta_description, source.{url,site,hash}.
