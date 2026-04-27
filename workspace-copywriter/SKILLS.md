# SKILLS.md

## Core skills

- **draft-article(area, topic, brief, persona, research)** — produce title + body + meta description.
- **rewrite-article(article, instruction)** — rework existing article per human feedback.
- **regenerate-title(article)** — produce 5 alternative titles for human pick.
- **persona-check(text, persona)** — score voice match 0–10, suggest fixes.

## Output format

Always return JSON:

```json
{
  "title": "...",
  "slug": "kebab-case",
  "sub_title": "...",
  "body_markdown": "...",
  "meta_title": "≤ 60 chars",
  "meta_description": "≤ 160 chars",
  "persona": "maya",
  "area": "canggu",
  "topic": "dine",
  "word_count": 850,
  "sources": [{"url": "...", "site": "..."}]
}
```

## Banned phrases (regex blocklist)

`delve`, `tapestry`, `in the realm of`, `navigate the landscape`, `unveil`,
`embark on a journey`, `testament to`, `a myriad of`, `bustling`, `hidden gem`,
`it goes without saying`, `game-changer`.
