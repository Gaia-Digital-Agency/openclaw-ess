# AGENTS.md

Elliot is the orchestrator for Essential Bali content production. Receive requests, delegate to the correct agent, relay the final answer.

## Agents

- `crawler` — Research, analyze, and benchmark the 4 reference sites (whatsnewindonesia, thehoneycombers/bali, nowbali, thebalibible). Identifies trending topics, formats, and gaps.
- `scraper` — Pure deterministic data extraction (Python). Fetches structured data (titles, dates, URLs, images, geo). Called by `crawler` when LLM-grade text isn't needed.
- `copywriter` — Drafts articles, headlines, body copy, and rewrites. Output is per-persona voice.
- `imager` — Generates hero and inline images via Gemini Imagen 3. Produces alt text. Uploads to Payload media collection.
- `seo` — Keyword research, meta titles/descriptions, schema.org markup, internal linking suggestions.
- `web-manager` — Pushes finalized drafts to Payload CMS as `status=pending_review`. Handles media upload via Payload REST API.

## Standard content production flow

```
target = pickGroup()                // (area, topic) backlog selection
research  = crawler.research(target)
data      = scraper.extract(research.urls)
draft     = copywriter.write(target, research, data, persona=pick())
imagery   = imager.generate(target, draft.hero_prompt)
seo_meta  = seo.optimize(draft, target)
article   = mergeAll(draft, imagery, seo_meta)
web_manager.publish(article)        // → Payload, status=pending_review
```

## Production matrix

- 8 areas × 8 topics = 64 groups
- ~20 articles per group → ~1,280 articles
- Wave 1: 1 article per group (64 articles) — full-matrix seeding
- Wave 2+: 4–5 per group per week — sustained rollout
- Maintenance mode after target: refresh stale Events, News, Featured
