# openclaw-ess

AI agent system that produces and manages content for **Essential Bali** (https://essentialbali.gaiada.online).

Runs on `gda-ai01` at `/opt/.openclaw-ess`. Talks to the website's Payload CMS over HTTPS to CRUD articles, comments, media, and hero-ad slots.

---

## What it does

```
   ┌──────────────────────────────────────────────────────────┐
   │             openclaw-ess  (this repo)                     │
   │                                                           │
   │   Elliot (orchestrator, Haiku)                            │
   │      │                                                    │
   │      ├── Crawler  (Gemini)   research benchmark sites     │
   │      ├── Scraper  (Python)   deterministic data extract   │
   │      ├── Copywriter (Gemini) draft article body           │
   │      ├── Imager   (Imagen 3) hero + inline images         │
   │      ├── SEO      (Gemini)   meta, schema, internal links │
   │      └── Web Manager (Gemini) push to Payload via REST    │
   └────────────────────────┬─────────────────────────────────┘
                            │ HTTPS (Payload REST + API key)
                            ▼
                   ┌─────────────────────┐
                   │ Payload CMS @ s01   │
                   │ (Phase D, port 4008)│
                   └────────┬────────────┘
                            │
                            ▼
                   ┌─────────────────────┐
                   │ PostgreSQL          │
                   │ essentialbali_db    │
                   └─────────────────────┘
```

---

## Agent schema

### Roster

| ID | Display name | Workspace | Primary model | Fallback | Sub-agents |
|---|---|---|---|---|---|
| `main` | **Elliot** | `workspace-main` | `anthropic/claude-haiku-4-5` | `google/gemini-2.5-flash` | all 6 below |
| `copywriter` | Copywriter | `workspace-copywriter` | `google/gemini-2.5-flash` | `google/gemini-2.5-flash` | — |
| `web-manager` | Web Manager | `workspace-web-manager` | `google/gemini-2.5-flash` | `google/gemini-2.5-flash` | — |
| `seo` | SEO | `workspace-seo` | `google/gemini-2.5-flash` | `google/gemini-2.5-flash` | — |
| `imager` | Imager | `workspace-imager` | `google/imagen-3.0-generate-002` | `google/gemini-2.5-flash` | — |
| `crawler` | Crawler | `workspace-crawler` | `google/gemini-2.5-flash` | `google/gemini-2.5-flash` | — |
| `scraper` | Scraper | `workspace-scraper` | `google/gemini-2.5-flash` (Python deterministic) | — | — |

### Workspace file convention

Every workspace has the same .md skeleton (cloned from the `.openclaw-var` template):

```
workspace-<id>/
├── IDENTITY.md     who this agent is, self-introduction
├── AGENTS.md       sub-agent map (leaf agents say "no sub-agents")
├── SOUL.md         output rules, tone, banned phrases
├── SKILLS.md       enumerated capabilities + I/O contracts
├── HEARTBEAT.md    when to wake (idle / scheduled / webhook)
├── MEMORY.md       what to persist long-term
├── TOOLS.md        which plugins this workspace can use
├── USER.md         who calls this agent
└── state/          runtime state (gitignored)
```

### Message contracts

Every agent returns **structured JSON**. Copywriter example:

```json
{
  "title": "Where the Surf Meets Brunch in Canggu",
  "slug": "where-surf-meets-brunch-canggu",
  "sub_title": "...",
  "body_markdown": "...",
  "meta_title": "≤ 60 chars",
  "meta_description": "≤ 160 chars",
  "persona": "maya",
  "area": "canggu",
  "topic": "dine",
  "word_count": 850,
  "sources": [{"url":"...", "site":"thehoneycombers.com"}]
}
```

Web Manager translates this into a Payload `POST /api/articles` payload with `status=pending_review`.

### Production flow (one article)

```
target = elliot.plan-wave().pick()
research  = crawler.discover(target)
data      = scraper.extract(research.urls)
draft     = copywriter.draft-article(target, research, data, persona=elliot.pick-persona())
images    = imager.generate-hero(draft) + imager.generate-inline(draft, n=2)
seo_meta  = seo.optimize-meta(draft, target) + seo.schema-markup(draft)
article   = merge(draft, images, seo_meta)
elliot.review-gate(article)               # hard quality checks
web_manager.submit-article(article)       # → Payload pending_review
                                          # → human approves in Payload admin
```

### Quality gates (hard reject before Payload submission)

- Empty title / body / hero image
- Word count below threshold (Featured ≥ 400, News ≥ 200)
- Persona voice mismatch (per-persona regex + heuristic check)
- AI-ism vocabulary detected (`delve`, `tapestry`, `hidden gem`, `bustling`, …)
- Duplicate by `source.hash` or slug
- Missing SEO meta (title or description)

### Personas

Multiple writer personas (per E-E-A-T best practice):

| Persona | Voice | Best for |
|---|---|---|
| Maya | local foodie, warm, sensory | Dine, Featured |
| Komang | activities guide, practical | Activities, Health & Wellness |
| Putu | cultural insider, thoughtful | People & Culture, News |
| Sari | nightlife reporter, energetic | Nightlife, Events |

Personas live in Payload as a `personas` collection (avatar, bio, preferred topics).

---

## Production matrix

```
            Events  News  Featured  Dine  Health  Nightlife  Activities  People&Culture
Canggu        20     20      20     20     20        20          20             20
Kuta          20     20      20     20     20        20          20             20
Ubud          20     20      20     20     20        20          20             20
Jimbaran      20     20      20     20     20        20          20             20
Denpasar      20     20      20     20     20        20          20             20
Kintamani     20     20      20     20     20        20          20             20
Singaraja     20     20      20     20     20        20          20             20
Nusa Penida   20     20      20     20     20        20          20             20
                                                                    Total ≈ 1,280
```

**Wave plan:**
- **Wave 1** — 1 article per group (64 articles): full-matrix seeding, lets Google discover topology
- **Wave 2–N** — 4–5/group/week (~256/wave): 5 waves complete the target
- **Maintenance** — refresh stale Events, News, Featured indefinitely

Each of the 64 cells also has a **hero ad slot** (placeholder: "Ads space > Canggu > Events" until activated). Toggle via Payload admin (`Activate / Deactivate`).

---

## File structure

```
.openclaw-ess/
├── README.md               ← you are here
├── openclaw.json           central config (gitignored — contains config + agent roster)
├── .gitignore
├── plugins/                MCP tools, shared (gitignored runtime config)
├── workspace-main/         Elliot (orchestrator)
├── workspace-copywriter/
├── workspace-web-manager/
├── workspace-seo/
├── workspace-imager/
├── workspace-crawler/
├── workspace-scraper/
├── agents/<id>/            runtime per-agent state (sessions/ are gitignored)
├── memory/                 long-term memory sqlite stores (gitignored)
├── identity/               device IDs (gitignored)
├── credentials/            API key secrets (gitignored)
├── devices/, canvas/, docs/, logs/, tasks/    runtime
└── update-check.json       (gitignored)
```

---

## Wiring to Essential Bali (Phase D and beyond)

- **Payload base URL:** `http://gda-s01.asia-southeast1-b.c.gda-viceroy.internal:4008` (internal GCP network)
- **API key env var:** `PAYLOAD_AI_API_KEY` (loaded into `credentials/`)
- **Site base URL** (used in copy & links): `https://essentialbali.gaiada.online`

---

## Repos

| Repo | GitHub |
|---|---|
| openclaw-ess (this) | `git@github.com:Gaia-Digital-Agency/openclaw-ess.git` |
| essentialbali | `git@github.com:Gaia-Digital-Agency/essentialbali.git` |

---

## Local dev / ops

```bash
# SSH
ssh gda-ai01

# Inspect
cat /opt/.openclaw-ess/openclaw.json
ls /opt/.openclaw-ess/workspace-main/

# Tail logs
tail -f /opt/.openclaw-ess/logs/*.log
```

---

## Roadmap

| Phase | Status |
|---|---|
| A — `dev` branch on essentialbali | ✅ done |
| B — sitemap/robots fix + READMEs | ✅ done |
| C — `.openclaw-ess` scaffold (this) | 🔄 in progress |
| D — 3PVTRN migration on essentialbali | ⏳ pending |
| Cutover — DNS to `essentialbali.com` | ⏳ later |
