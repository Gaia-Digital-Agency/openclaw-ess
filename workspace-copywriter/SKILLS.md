# SKILLS.md

## Core skills

- **draft-article(area, topic, brief, persona, research, target_words?)** — **LIVE.** Produce title + body + meta in one call.
  Invoker: `node /opt/.openclaw-ess/workspace-copywriter/scripts/draft-article.mjs`
  Backend: Vertex AI Gemini 2.5 Flash (`asia-southeast1`), schema-bound JSON output.
  Quality gates run in-script: banned-phrase scan, word-count check, meta caps.
- **rewrite-article(article, instruction)** — **LIVE.** Take existing article + instruction, produce fresh draft with augmented brief. Tags revision via `source.hash` suffix (`_v2`, `_v3`, …) so it replaces, not duplicates.
  Invoker: `node /opt/.openclaw-ess/workspace-copywriter/scripts/rewrite-article.mjs --id=N --instruction="..."`
  Or pipe JSON stdin with `{title, body_markdown, area, topic, persona, instruction}`.
- **regenerate-title(article)** — **LIVE.** Produces 5 alternative titles (≤60 chars each), each tagged with an editorial angle. Vertex Gemini schema-bound, temperature 0.7.
  Invoker: `node /opt/.openclaw-ess/workspace-copywriter/scripts/regenerate-title.mjs --id=N`
  Or pipe JSON stdin with `{title, sub_title, body_markdown, area, topic, persona}`.
- **persona-check(text, persona)** — *scaffolded.* Score voice match 0–10, suggest fixes. Owned by Elliot orchestrator post-draft.

## Invocation

```bash
echo '{"area":"canggu","topic":"dine","persona":"maya","brief":"three honest warungs","target_words":350}' \
  | node /opt/.openclaw-ess/workspace-copywriter/scripts/draft-article.mjs

# or with --flags
node draft-article.mjs --area=canggu --topic=dine --persona=maya \
  --brief="best warungs" --target_words=350
```

## Output format (draft-article)

```jsonc
{
  "title": "...",
  "slug": "kebab-case",
  "sub_title": "...",
  "body_markdown": "...",
  "meta_title": "≤ 60 chars",
  "meta_description": "≤ 160 chars",
  "keywords": ["..."],
  "persona": "maya",
  "area": "canggu",
  "topic": "dine",
  "word_count": 850,
  "sources": [{"url": "...", "site": "..."}],
  "banned_phrases_found": []
}
```

## Output format (rewrite-article)

Same shape as draft-article plus `revised_from_id` (when called via `--id`),
`revision` integer (2, 3, 4, …), and `instruction` echoed back. The
`source.hash` field carries the parent's hash with a `_vN` suffix so
callers can recognise this as a revision and PATCH the original article
instead of POSTing a new one.

## Output format (regenerate-title)

```jsonc
{
  "source_title": "Canggu's True Morning Taste: Local Breakfast Picks",
  "area": "canggu",
  "topic": "dine",
  "alternatives": [
    { "title": "...", "angle": "numbered list" },
    { "title": "...", "angle": "question hook" },
    { "title": "...", "angle": "lead with the dish" },
    { "title": "...", "angle": "lead with the place" },
    { "title": "...", "angle": "early-bird benefit" }
  ]
}
```

## Personas (voice presets)

- **maya** — local foodie. Warm, sensory. Names ingredients specifically.
- **komang** — activities + wellness guide. Practical, calm, safety-aware.
- **putu** — cultural insider. Italicises Balinese terms on first use. No exoticisation.
- **sari** — nightlife + events reporter. Energetic, short paragraphs.

## Banned phrases (regex blocklist enforced in-script)

`delve`, `tapestry`, `hidden gem`, `bustling`, `in the realm of`,
`navigate the landscape`, `unveil`, `embark on a journey`, `testament to`,
`a myriad of`, `it goes without saying`, `game-changer`.

If any are found in the model output, `banned_phrases_found` is populated and
Elliot should reject + re-prompt.
