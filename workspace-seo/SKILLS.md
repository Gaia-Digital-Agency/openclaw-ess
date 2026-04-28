# SKILLS.md

## Core skills

- **optimize-meta(article)** — produce meta title (≤ 60 chars) + description (≤ 160 chars) +
  internal-link anchors. **LIVE.**
  - Implementation: `cms/src/lib/seo-agent.ts` (Payload server, gda-s01)
  - Single source of truth — same code path Articles.beforeChange uses.
  - HTTP endpoint: `POST https://essentialbali.gaiada.online/api/_internal/seo-optimize`
  - Auth: Payload JWT (Authorization: JWT <token>) — role ai-agent / staff / admin
  - Backend: Vertex AI Gemini 2.5 Flash.
- **keyword-research(area, topic, body?)** — primary keyword + long-tail variants.
  Returned as part of `optimize-meta` output (primary_keyword + long_tail_keywords[]).
- **schema-markup(article)** — Schema.org Article JSON-LD; emitted by the same helper.
- **internal-link(article, candidates)** — `internal_link_anchors` in the optimize-meta output.
- **competitor-gap(area, topic, missing_themes[])** — **LIVE.** Takes a gap-report (themes benchmarks cover that we don't) and ranks each by SEO opportunity. Returns ranked_gaps with primary_keyword, long_tail_keywords[], estimated_search_potential (high/medium/low), suggested_brief (ready for dispatch-article), angle, and rank.
  Endpoint: `POST https://essentialbali.gaiada.online/api/seo-competitor-gap` (JWT auth)
  Implementation: `cms/src/lib/competitor-gap.ts` (single source of truth; same pattern as optimize-meta)
  Pipes naturally from Crawler gap-report -> SEO competitor-gap -> Elliot plan-wave.

## Invocation (HTTP — used by Elliot orchestrator)

Login first, then POST. Body fields: area, topic, title, subTitle?, bodyText?,
existingMetaTitle?, existingMetaDescription?.

Endpoint: POST https://essentialbali.gaiada.online/api/_internal/seo-optimize
Header:   Authorization: JWT <payload-token>
Body:     application/json — {"area":"...", "topic":"...", "title":"...", "bodyText":"..."}

## Output

```jsonc
{
  "primary_keyword": "Ubud yoga studios",
  "long_tail_keywords": ["...","..."],
  "meta_title": "≤ 60 chars",
  "meta_description": "≤ 160 chars",
  "internal_link_anchors": ["...","..."]
}
```

## Standards

- Primary keyword in title, H1, first 100 words, and 1+ H2.
- LSI keywords sprinkled — never stuffed.
- All images have descriptive alt text (Imager produces; SEO verifies).
- Canonical URLs always point to `area/topic/slug` path.

## Why HTTP not local script

The SEO logic used to live in two places (`cms/src/lib/seo-agent.ts` for the
Articles save hook + `workspace-seo/scripts/optimize-meta.mjs` for Elliot
shell-out). They drifted easily. Now both consumers go through the same
`optimizeSeo()` function — Payload as a direct call, Elliot via HTTP. One
source, one bug surface.
