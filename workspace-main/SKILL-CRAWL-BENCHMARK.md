# SKILL-CRAWL-BENCHMARK.md

Multi-step skill: research a (area, topic) cell against the 4 benchmark sites
and produce 1-3 ready-to-publish article drafts in Payload.

## Trigger phrases

- "research canggu dine"
- "find new content for ubud wellness"
- "what's trending in seminyak nightlife"

## Sequence

1. **Crawler.discover** — across all 4 sources for `{area} {topic}`.
2. **Filter** — Elliot picks 3 most relevant URLs (recency, title fit, source diversity).
3. **Crawler.analyze(url)** — for each picked URL, extract structured content.
4. **Copywriter.draft-article** — feed: target=(area, topic), research=results,
   persona=auto-pick (e.g. Maya for Dine, Sari for Nightlife).
5. **Imager.generate-hero(article)** — Imagen 3, photographic, 16:9.
6. **SEO.optimize-meta(article, target)** — meta title/desc, schema markup.
7. **Elliot.review-gate(article)** — quality checks (word count, banned phrases,
   factuality, idempotency via source.hash).
8. **Web Manager.submit-article(article)** — POST to Payload `status=pending_review`.

## Quality gates (before Web Manager submit)

- Word count ≥ 400 (Featured/Articles), ≥ 200 (News).
- No banned phrases: `delve`, `tapestry`, `hidden gem`, `bustling`, `myriad`.
- Persona voice match score ≥ 7/10.
- All facts grounded in `research[].url` (no fabrication).
- `source.hash = sha256(url)` set so re-runs don't dupe.

## Failure handling

- robots.txt disallow → drop URL, pick next candidate.
- Rate limit hit → backoff 5s, continue.
- 0 candidates → report empty result to user; do not submit anything.

## Example invocation (CLI helper)

```bash
node /opt/.openclaw-ess/workspace-crawler/scripts/crawl-benchmark.mjs \
  --discover --site=thehoneycombers.com/bali --area=canggu --topic=dine \
  | jq -r '.candidates[].href' \
  | head -3 \
  | while read url; do
      node /opt/.openclaw-ess/workspace-crawler/scripts/crawl-benchmark.mjs "$url"
    done
```

In production Elliot dispatches this via the gateway, not the CLI.
