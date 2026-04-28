# SKILL-READ-INBOX.md

Read article briefs from the inbox xlsx tracker, push as drafts to Payload.

## Inputs

- `/opt/.openclaw-ess/inbox/articles/Essential Bali Proofread.xlsx`
  (synced from Azlan's local `~/Downloads/essentialbaliNopenclaw/articles/` via
  `bridge/sync-articles-inbox.sh`).

## Trigger phrases

- "process inbox articles"
- "load this month's content briefs"
- "import xlsx → drafts"

## Sequence

1. **Scraper.read-inbox-xlsx(month?)** — JSON list of rows ready to push.
2. **Filter** — only rows with `article_status` ∈ {draft, in progress, ready}
   AND `seo_title` non-empty.
3. **Resolve area + topic** — start with `guessed_area` / `guessed_topic`;
   if either missing, dispatch to Copywriter for human-readable inference.
4. **(Optional) Copywriter.expand-from-brief** — if `draft_link` is empty AND
   `topic_brief` is short, ask Copywriter to expand into a full article body
   from `{title, brief, keywords}`.
5. **Imager.generate-hero(article)** — 16:9 Imagen 3.
6. **Web Manager.submit-article** — POST to Payload `status=pending_review`,
   sets `source.hash = "xlsx:{month}:{row}"` for idempotency.

## Output

Status report to Elliot:

```
processed 8 rows from Essential Bali Proofread.xlsx (Apr)
  · 6 created → pending_review
  · 1 already-imported (matched source.hash)
  · 1 skipped (article_status=published)
```

## Constraints

- **Don't fetch Google Docs** unless OAuth is set up (drafts are private by
  default). For now, treat `draft_link` as a reference URL only.
- **Idempotent** — re-running the skill never duplicates rows.
- **Human-in-the-loop** — never auto-publish. Always `pending_review`.

## Example

```bash
# from gda-ai01 shell, dry run reading the xlsx
python3 /opt/.openclaw-ess/workspace-scraper/scripts/read-articles-xlsx.py \
  --month=Apr --status=draft \
  | jq '.rows | length'
# → 8
```
