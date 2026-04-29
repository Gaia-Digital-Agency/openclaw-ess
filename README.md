# openclaw-ess

AI agent system that produces and manages content for **Essential Bali** (https://essentialbali.gaiada.online).

Runs on `gda-ai01` at `/opt/.openclaw-ess`. Talks to the website's Payload CMS at `https://essentialbali.gaiada.online/api/*` to CRUD articles, hero ads, subscribers, and newsletters.

Mission Control: **https://ess.gaiada0.online** (paste the gateway token from `openclaw.json` to connect).

---

## What it does

```
   ┌──────────────────────────────────────────────────────────┐
   │             openclaw-ess  (this repo)                     │
   │                                                           │
   │   Elliot (orchestrator, Haiku via Vertex)                 │
   │      │                                                    │
   │      ├── Crawler  (Gemini)   research benchmark sites     │
   │      ├── Scraper  (Python)   xlsx + Google Docs reader    │
   │      ├── Copywriter (Gemini) draft article body           │
   │      ├── Imager   (Imagen 3) hero + inline images         │
   │      ├── SEO      (Gemini)   meta, schema, internal links │
   │      └── Web Manager (Gemini) push to Payload via REST    │
   └────────────────────────┬─────────────────────────────────┘
                            │ HTTPS (JWT login → /api/*)
                            ▼
                   ┌─────────────────────┐
                   │ Payload CMS         │
                   │ essentialbali       │
                   │ .gaiada.online/admin│
                   └────────┬────────────┘
                            │
                            ▼
                   ┌─────────────────────┐
                   │ PostgreSQL          │
                   │ essentialbali_db    │
                   └─────────────────────┘
```

**Talk to Elliot from inside the CMS** — `/admin/elliot` (sidebar: AI agent → Talk to Elliot). Same chat is also available from any public page via the floating bubble (bottom-right).

All 7 entities (Elliot + 6 sub-agents) expose **39 skills total** — every skill is currently 🟢 LIVE. Per-skill status (LIVE / scaffolded), invocation contracts, and skill-specific links are visible on the `/admin/elliot` page and in `/var/www/essentialbali/docs/user_guide.md`.

---

## Repo layout

```
.openclaw-ess/
├── README.md                  ← you are here
├── package.json               shared deps (google-auth-library, formdata-node)
├── openclaw.json              instance config (gitignored)
├── .gitignore
├── bridge/
│   └── sync-articles-inbox.sh    legacy rsync helper
├── credentials/                  (gitignored — secrets)
│   ├── gda-viceroy-vertex.json   service account, Vertex AI access
│   ├── .env.vertex               GCP project + model env
│   ├── .env.payload              PAYLOAD_AGENT_EMAIL / PASSWORD / BASE_URL for JWT login
│   ├── drive_credentials.json    OAuth client (mirror of /var/www/gdrive)
│   └── google-user-token.json    user OAuth token (ai@gaiada.com)
├── inbox/
│   └── articles/                 xlsx tracker drops (synced from Drive)
├── workspace-main/                  Elliot — orchestrator
│   ├── IDENTITY.md / SOUL.md / SKILLS.md / AGENTS.md / …
│   ├── SKILL-CRAWL-BENCHMARK.md     multi-agent skill: research → article draft
│   ├── SKILL-READ-INBOX.md          multi-agent skill: xlsx → article drafts
│   └── scripts/
│       ├── plan-wave.mjs            picks deficit cells, builds dispatch queue,
│       │                             --execute fires at 1/min with retry
│       ├── dispatch-article.mjs     full chain crawler → copy → SEO → imager → web-manager
│       ├── status-report.mjs        per-cell status counts (table or JSON)
│       ├── review-gate.mjs          standalone pre-flight: {ok, issues}
│       └── maintenance-pass.mjs     stale-content sweep (Events > 14d, News > 30d, …)
├── workspace-copywriter/
│   ├── SKILLS.md
│   └── scripts/
│       ├── draft-article.mjs        Vertex Gemini, JSON-schema bound, 4-persona presets
│       ├── rewrite-article.mjs      revise existing article from feedback (source.hash _vN)
│       └── regenerate-title.mjs     5 alternative titles + editorial angles
├── workspace-web-manager/           HTTP-only — no scripts. Uses Payload REST + JWT.
├── workspace-seo/
│   └── SKILLS.md                    optimize-meta + competitor-gap are HTTP services
│                                     hosted by Payload (cms/src/lib/seo-agent.ts +
│                                     cms/src/lib/competitor-gap.ts) — single source of truth.
├── workspace-imager/
│   ├── SKILLS.md
│   └── scripts/
│       ├── generate-hero.mjs        Imagen 3, 16:9 hero, area + topic + persona cues
│       └── regenerate.mjs           feedback-driven re-roll (uploads new media + returns ids)
├── workspace-crawler/
│   ├── SKILLS.md
│   └── scripts/
│       ├── crawl-benchmark.mjs      single-URL or --discover mode
│       ├── trend-scan.mjs           per-site listing-page recon, area-relevance filter
│       └── gap-report.mjs           trend-scan + Payload titles → Vertex theme diff
└── workspace-scraper/
    ├── SKILLS.md
    └── scripts/
        ├── read-articles-xlsx.py    openpyxl reader
        ├── pull-xlsx-from-drive.py  downloads tracker via OAuth
        ├── read-google-doc.py       Doc body → Markdown
        ├── check-doc-access.py      per-doc share-status report
        └── process-inbox.py         end-to-end pipeline, never skips a row
```

---

## Agent skills (39 total — all 🟢 LIVE)

Per-skill status, signature, and full description visible at
`https://essentialbali.gaiada.online/admin/elliot` and in
`/var/www/essentialbali/docs/user_guide.md`.

| Agent | Skills | Backend |
|---|---|---|
| **Elliot** (`workspace-main`) | plan-wave · dispatch-article · review-gate · status-report · maintenance-pass | Anthropic Haiku 4.5 (orchestration) + Vertex Gemini fallback |
| **Crawler** | discover · analyze · trend-scan · gap-report | Node native fetch, robots.txt, 1 req/s/host, UA `EssentialBaliBot/1.0`. Per-site listing-page maps for all 4 benchmark sources. |
| **Scraper** | read-articles-xlsx · pull-xlsx-from-drive · read-google-doc · check-doc-access · process-inbox · fetch · extract-article · extract-listing · extract-jsonld · geocode | Python venv (openpyxl, requests, bs4, googleapiclient) |
| **Copywriter** | draft-article · rewrite-article · regenerate-title · persona-check | Vertex Gemini 2.5 Flash, response bound to JSON schema. 4 persona presets (maya / komang / putu / sari). Banned-phrase regex enforced in-script. |
| **Imager** | generate-hero · generate-inline · regenerate · alt-text | Vertex Imagen 3 (`imagen-3.0-generate-002`). Per-area + per-topic + per-persona prompt cues. Auto-uploads to GCS via Payload media adapter. |
| **SEO** | optimize-meta · keyword-research · schema-markup · internal-link · competitor-gap | Vertex Gemini 2.5 Flash. **Hosted as HTTP services by Payload** — single source of truth at `cms/src/lib/seo-agent.ts` and `cms/src/lib/competitor-gap.ts`. Same code path used by Articles `beforeChange` hook (in-process) and by Elliot dispatch (over HTTP via JWT). |
| **Web Manager** | submit-article · upload-media · link-hero · submit-comment · toggle-hero-ad · fetch-status · list-pending-review | Payload REST + JWT (`elliot@gaiada.com`, role `ai-agent`) |

---

## Production matrix

8 areas × 8 topics × ~20 articles ≈ **1,280 articles** target.

- **Areas:** Canggu, Kuta, Ubud, Jimbaran, Denpasar, Kintamani, Singaraja, Nusa Penida
- **Topics:** Events, News, Featured, Dine, Health & Wellness, Nightlife, Activities, People & Culture
- Each cell also has 1 hero ad slot — 64 placeholder slots, toggleable in Payload admin.

---

## Two ways content enters Payload

### A) Crawler benchmark research → draft

1. Elliot picks a (area, topic) cell with a low article count.
2. **Crawler** runs `discover` across the 4 benchmark sources (whatsnewindonesia, thehoneycombers/bali, nowbali, thebalibible).
3. For top 3 candidates, **Crawler.analyze** extracts headings + paragraphs.
4. **Copywriter** writes a fresh Essential Bali article from research (never republish).
5. **Imager** generates hero, **SEO** adds meta, **Web Manager** posts as `pending_review`.

### B) xlsx tracker → drafts

1. Operator edits `Essential Bali Proofread.xlsx` (in Google Drive — see below).
2. **Scraper.pull-xlsx-from-drive** downloads the latest into `inbox/articles/`
   (or, while a local Mac copy still exists, `bridge/sync-articles-inbox.sh`
   rsyncs from there).
3. **Scraper.read-articles-xlsx** reads sheets (Apr/May/June/...) → row JSON.
4. For each row: **Scraper.read-google-doc** pulls the Draft Link body.
5. **Copywriter** finalizes voice, **Imager**/**SEO**, **Web Manager** posts `pending_review`.

Both paths submit `status=pending_review` for human approval before publish.

---

## ★ Where to drop files for Elliot to process

> **TODO for the operator:** create a single Google Drive folder and share it
> with `ai@gaiada.com` (Editor). Elliot's OAuth user is wired to that account.

Suggested layout:

```
📁 Essential Bali — Elliot Inbox     ← share once with ai@gaiada.com (Editor)
   📁 articles-tracker/               ← the xlsx (Essential Bali Proofread)
   📁 drafts/                          ← Google Docs (writers drop here)
   📁 assets/                          ← images / PDFs / briefs
```

How it works:

- Sharing the parent folder once gives `ai@gaiada.com` access to every file
  added inside it later (no per-file shares needed).
- `workspace-scraper/scripts/pull-xlsx-from-drive.py` finds and downloads the
  tracker. `--list` enumerates every xlsx/sheet visible to the account.
- `workspace-scraper/scripts/check-doc-access.py` walks every Draft Link in
  the tracker and reports per-doc whether it can be read; it prints a list of
  URLs to share if access is missing.
- `workspace-scraper/scripts/read-google-doc.py` fetches a doc body as
  Markdown (used downstream by Copywriter).

**Status as of last check:** the tracker file (`Essential Bali Proofread`,
owner `seo@gaiada.com`) is already accessible. The 8 Apr-sheet draft Docs
are **not yet shared** — `check-doc-access.py` lists them.

---

## Mission Control (https://ess.gaiada0.online)

OpenClaw Control UI served by `openclaw-ess-gateway.service` on port `:19290` (loopback) → nginx HTTPS.

To connect from your browser:
1. Open https://ess.gaiada0.online
2. **WebSocket URL:** `wss://ess.gaiada0.online`
3. **Gateway Token:** copy from `/opt/.openclaw-ess/openclaw.json` → `gateway.auth.token`
4. **Connect** — first time triggers a pairing request; SSH in and `openclaw devices approve <id>` to allow.

Once paired, the dashboard shows live agent state, queues, and lets you DM Elliot.

---

## Service ops

```bash
# gateway service
systemctl --user status openclaw-ess-gateway
systemctl --user restart openclaw-ess-gateway
journalctl --user -u openclaw-ess-gateway --no-pager -n 50

# devices (pairing approvals)
OPENCLAW_STATE_DIR=/opt/.openclaw-ess OPENCLAW_CONFIG_PATH=/opt/.openclaw-ess/openclaw.json \
  node /home/azlan/.npm-global/lib/node_modules/openclaw/dist/index.js devices list
```

---

## Credentials

All gitignored. Cred provenance:

| File | Source | Used for |
|---|---|---|
| `credentials/gda-viceroy-vertex.json` | copy of `/var/www/gaiadaweb/secure/...` | Vertex AI / Gemini / Imagen |
| `credentials/.env.vertex` | local | Vertex project + model + location |
| `credentials/.env.payload` | local | `PAYLOAD_AGENT_EMAIL` (`elliot@gaiada.com`) + password for JWT login at `https://essentialbali.gaiada.online/api/users/login` |
| `credentials/drive_credentials.json` | copy of `/var/www/gdrive/keys/drive_credentials.json` | Google OAuth client (project `gda-viceroy`) |
| `credentials/google-user-token.json` | copy of `/var/www/gdrive/keys/drive_token_rw.json` | refreshable Drive token for `ai@gaiada.com` |

---

## Repos

| Repo | GitHub |
|---|---|
| openclaw-ess (this) | `git@github.com:Gaia-Digital-Agency/openclaw-ess.git` |
| essentialbali | `git@github.com:Gaia-Digital-Agency/essentialbali.git` |

Branch model: **`main` only** (dev branch retired once cutover stabilized).

---

## Quick checks

```bash
# Crawler — single-URL analyze
node /opt/.openclaw-ess/workspace-crawler/scripts/crawl-benchmark.mjs \
  https://thehoneycombers.com/bali/best-warungs-canggu/

# Crawler — trend-scan one cell
node /opt/.openclaw-ess/workspace-crawler/scripts/trend-scan.mjs \
  --area=canggu --topic=dine --limit=8

# Crawler + Vertex — gap-report (themes benchmarks cover that we don't)
node /opt/.openclaw-ess/workspace-crawler/scripts/gap-report.mjs \
  --area=canggu --topic=dine

# Elliot — see what plan-wave would dispatch (no side effects)
node /opt/.openclaw-ess/workspace-main/scripts/plan-wave.mjs --limit=5

# Elliot — fire 3 dispatches at 60s pacing
node /opt/.openclaw-ess/workspace-main/scripts/plan-wave.mjs --execute --limit=3

# Elliot — per-cell status (table)
node /opt/.openclaw-ess/workspace-main/scripts/status-report.mjs --table

# Elliot — review-gate one article
node /opt/.openclaw-ess/workspace-main/scripts/review-gate.mjs --id=70

# One-off article via dispatch
echo '{"area":"ubud","topic":"health-wellness","persona":"komang",
       "brief":"five quiet yoga studios in Ubud","target_words":600}' | \
  node /opt/.openclaw-ess/workspace-main/scripts/dispatch-article.mjs

# Scraper — refresh xlsx tracker from Drive + parse rows
python3 /opt/.openclaw-ess/workspace-scraper/scripts/process-inbox.py --pull

# Payload connectivity (JWT login + /me)
source /opt/.openclaw-ess/credentials/.env.payload
TOKEN=$(curl -s -X POST "$PAYLOAD_BASE_URL/api/users/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PAYLOAD_AGENT_EMAIL\",\"password\":\"$PAYLOAD_AGENT_PASSWORD\"}" \
  | jq -r .token)
curl -s "$PAYLOAD_BASE_URL/api/users/me" -H "Authorization: JWT $TOKEN" | jq '.user.role'
# → "ai-agent"
```

---

## Decisions log

- **2026-04-29** — All 39 skills are now LIVE end-to-end. Last 3 to land
  were Crawler `trend-scan`, Crawler `gap-report`, SEO `competitor-gap`.
- **2026-04-29** — SEO logic moved from a workspace-seo Node script to an
  HTTP service hosted by Payload (`/api/seo-optimize`, `/api/seo-competitor-gap`).
  Single source of truth at `cms/src/lib/seo-agent.ts` — same code is called
  in-process by the Articles `beforeChange` hook and over HTTP by Elliot's
  dispatch chain.
- **2026-04-29** — Imager `regenerate` available both as a workspace
  script and as a Payload endpoint backing the admin "🔁 Regenerate hero"
  button. Both paths share `cms/src/lib/imager-regenerate.ts`.
- **2026-04-28** — Copywriter Vertex calls now bind to a JSON schema
  (responseSchema), eliminating the unterminated-string parser glitch
  that occasionally killed dispatches.
- **2026-04-28** — `dispatch-article.mjs` now resolves `persona` slug →
  Payload persona id before submit, so `Article.persona` lands as a
  proper relationship object (was `null` before).
- **Permanently dropped: pnpm workspace migration.** Considered, rejected.
  Same reasoning as the essentialbali-side decisions log: PM2 cwd
  assumptions, Payload v3 monorepo quirks, modest payoff for this
  project's mixed-stack reality. Not revisiting.
