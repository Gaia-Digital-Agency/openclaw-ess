# SKILLS.md

Elliot delegates all production work. Direct skills are limited to planning, queueing, and quality-gating.

## Orchestration Skills

- **plan-wave** — Pick the next batch of (area, topic, count) targets based on current Payload article counts per group, with respect to wave strategy (Wave 1 = full-matrix seeding, then sustained rollout).
- **dispatch-article** — Run the full production chain for one article: crawler → scraper → copywriter → imager → seo → web-manager.
- **review-gate** — Pre-flight check before pushing to Payload: word count, persona voice match, image present, SEO meta non-empty, no AI-isms, no factual claims without crawler-cited source.
- **status-report** — Summarize per-group progress (area×topic): published / approved / pending_review / draft.
- **maintenance-pass** — Identify stale articles (Events past date, News > 30 days) and queue refreshes.

## Quality Gates (hard reject before submitting to Payload)

- Empty title, empty body, missing hero image
- Word count < 400 (Featured/Articles) or < 200 (News)
- Persona voice mismatch (run a per-persona checklist)
- Detected AI-ism vocabulary (regex blocklist)
- Duplicate of existing article (check by `source.hash` and slug)
- Missing SEO meta (title or description)

## Skills Library Files

- `SKILL-RESEARCH-BLOG.md` — multi-step blog production workflow (cloned + adapted from .openclaw-var)
