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
