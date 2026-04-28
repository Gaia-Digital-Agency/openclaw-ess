# SKILLS.md

## Core skills

- **generate-hero(article)** — produce 1 hero image (16:9, ~1408×768 native from Imagen 3). **LIVE.**
  - Invoker: `node /opt/.openclaw-ess/workspace-imager/scripts/generate-hero.mjs`
  - Backend: Vertex AI Imagen 3 (`imagen-3.0-generate-002`).
- **generate-inline(article, n)** — produce N inline supporting images (1:1, 1024×1024). **LIVE** (`--inline=N`, max 4).
- **regenerate(article, feedback)** — **LIVE.** Wrapper around generate-hero with feedback-augmented prompt + smart negative-prompt mapping (e.g. "no people" → adds people/faces/humans to negative). Auto-uploads new PNG to GCS via /api/media. Returns both old and new media ids so the caller (or human) can PATCH article.hero to swap.
  Invoker: `node /opt/.openclaw-ess/workspace-imager/scripts/regenerate.mjs --id=N --feedback="..."`
- **alt-text(image, article)** — auto-generated per file (`{title} — {area} {topic} editorial photograph`).

## Invocation

```bash
# Hero (16:9)
echo "{\"area\":\"jimbaran\",\"topic\":\"dine\",\"persona\":\"maya\",
       \"title\":\"Jimbaran beach seafood at golden hour\",
       \"summary\":\"Grilled fish on the sand, sun setting behind the bay.\",
       \"out_dir\":\"/tmp\"}" \
  | node /opt/.openclaw-ess/workspace-imager/scripts/generate-hero.mjs

# 3 inline 1:1 images
node generate-hero.mjs --area=ubud --topic=activities \
  --title="Tegalalang rice walk" --inline=3 --out_dir=/tmp/inline
```

## Output format

```jsonc
{
  "model": "imagen-3.0-generate-002",
  "aspect_ratio": "16:9",
  "prompt": "...",
  "negative_prompt": "...",
  "files": [
    {
      "path": "/tmp/jimbaran-beach-seafood-at-golden-hour-hero.png",
      "mime": "image/png",
      "width": 1408,
      "height": 768,
      "alt_text": "..."
    }
  ]
}
```

## Visual standards

- Photographic, editorial, **never stock-cliché**.
- Honor Balinese culture: traditional dress, temple architecture, geography rendered respectfully.
- No people's faces in close-up unless explicitly requested (avoid IP / likeness issues).
- Always include the area name in the prompt (script does this automatically via `AREA_CUES`).
- Topic also adds a composition cue (e.g. dine → close-up food, golden-hour; nightlife → string lights, dusk).
- Negative prompt always blocks: watermarks, logos, text overlays, blurry, low quality, stock-photo cliché.

## Hand-off to Web Manager

Web Manager uploads `files[].path` via Payload `/api/media`, then sets the
returned media-id as `Article.heroImage` and `Article.images[]`.
