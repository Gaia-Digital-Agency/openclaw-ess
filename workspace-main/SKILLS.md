# SKILLS.md

Elliot delegates all production work. Direct skills are limited to planning, queueing, and quality-gating.

## Orchestration Skills

- **plan-wave** — **LIVE.** Reads live Payload counts per (area, topic), computes per-cell deficit against the 20-per-cell target, picks a sensible persona + brief from a rotating template library, emits a prioritised dispatch queue. With `--execute` runs the queue at 1/min by default with retry-on-failure.
  Invoker: `node /opt/.openclaw-ess/workspace-main/scripts/plan-wave.mjs`
  Modes: plan-only (default) | `--dry-run` | `--execute`
  Args: `--limit=N`, `--gap=SECONDS` (pacing).
- **dispatch-article** — **LIVE.** Run the full production chain for one article: copywriter → seo → imager → web-manager (POSTs as `pending_review`).
  Invoker: `node /opt/.openclaw-ess/workspace-main/scripts/dispatch-article.mjs`
  Path B semantics: hash-locked when an existing article holds the same source.hash with status pending_review/approved/published; rejected or deleted articles do not block.
- **review-gate** — **LIVE.** Pre-flight checks before submit. Returns `{ok, issues}` where each issue is `{level: error|warning, code, message}`. Hard rules: empty title/body/area/topic, missing hero, word_count below topic floor, banned phrases, SEO meta missing/too-long, duplicate source.hash. Soft rules: long body, no sources, no keywords. Exit code 0 = pass, 2 = fail.
  Invoker: `node /opt/.openclaw-ess/workspace-main/scripts/review-gate.mjs --id=N` (or pipe JSON)
- **status-report** — **LIVE.** Per-cell snapshot of the production matrix; counts every status (published/approved/pending_review/draft/rejected) per (area, topic). Default JSON; `--table` for human-readable grid; `--status=<one>` to focus on a single status column.
  Invoker: `node /opt/.openclaw-ess/workspace-main/scripts/status-report.mjs`
- **maintenance-pass** — **LIVE.** Scan published articles, find: events older than 14 days, news older than --news-days (default 30), features older than --feature-days (default 180). Dry-run by default. With --apply: flips expired events to status=draft (drops them from public + sitemap, keeps audit). Stale news/features stay published; their list feeds plan-wave for refresh dispatches.
  Invoker: `node /opt/.openclaw-ess/workspace-main/scripts/maintenance-pass.mjs [--apply] [--news-days=N] [--feature-days=N]`

## Quality Gates (hard reject before submitting to Payload)

- Empty title, empty body, missing hero image
- Word count < 400 (Featured/Articles) or < 200 (News)
- Persona voice mismatch (run a per-persona checklist)
- Detected AI-ism vocabulary (regex blocklist)
- Duplicate of existing article (check by `source.hash` and slug)
- Missing SEO meta (title or description)

## Skills Library Files

- `SKILL-RESEARCH-BLOG.md` — multi-step blog production workflow (cloned + adapted from .openclaw-var)
