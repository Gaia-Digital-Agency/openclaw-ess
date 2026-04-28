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

**Talk to Elliot from inside the CMS** — `/admin/elliot` (sidebar: Channels → Talk to Elliot). Same chat is also available from any public page via the floating bubble (bottom-right).

---

## Repo layout

```
.openclaw-ess/
├── README.md                  ← you are here
├── openclaw.json              instance config (gitignored)
├── .gitignore
├── bridge/
│   └── sync-articles-inbox.sh    rsync local xlsx → /opt/.openclaw-ess/inbox/articles/
├── credentials/                  (gitignored — secrets)
│   ├── gda-viceroy-vertex.json   service account, Vertex AI access
│   ├── .env.vertex               GCP project + model env
│   ├── .env.payload              PAYLOAD_AGENT_EMAIL/PASSWORD for JWT login
│   ├── drive_credentials.json    OAuth client (from /var/www/gdrive)
│   └── google-user-token.json    user OAuth token (ai@gaiada.com)
├── inbox/
│   └── articles/                 xlsx tracker drops (synced from local)
├── plugins/
├── workspace-main/               Elliot
│   ├── IDENTITY.md / SOUL.md / SKILLS.md / AGENTS.md / …
│   ├── SKILL-CRAWL-BENCHMARK.md  multi-agent: research → article draft
│   └── SKILL-READ-INBOX.md       multi-agent: xlsx → article drafts
├── workspace-copywriter/
├── workspace-web-manager/
├── workspace-seo/
├── workspace-imager/
├── workspace-crawler/
│   ├── SKILLS.md
│   └── scripts/crawl-benchmark.mjs    Node fetch + extract + robots.txt + 1 req/s
└── workspace-scraper/
    ├── SKILLS.md
    └── scripts/
        ├── read-articles-xlsx.py      Python openpyxl reader
        └── read-google-doc.py         Python Docs API reader (user OAuth)
```

---

## Agent skills (current)

| Agent | Skill | Implementation |
|---|---|---|
| **Elliot** (`workspace-main`) | orchestrate · plan · review-gate · status-report | Haiku via Vertex Gemini fallback |
| **Crawler** | discover · analyze · trend-scan · gap-report | `scripts/crawl-benchmark.mjs` (Node, native fetch, no deps). Honors robots.txt. 1 req/sec/host. UA `EssentialBaliBot/1.0`. |
| **Scraper** | fetch · extract-article · read-inbox-xlsx · read-google-doc · geocode | `scripts/read-articles-xlsx.py` (openpyxl) and `scripts/read-google-doc.py` (Google Docs API via user OAuth, fallback service account) |
| **Copywriter** | draft-article · rewrite-article · regenerate-title · persona-check | Gemini with persona prompts |
| **Imager** | generate-hero · generate-inline · regenerate · alt-text | Imagen 3 |
| **SEO** | keyword-research · optimize-meta · schema-markup · internal-link · competitor-gap | Gemini |
| **Web Manager** | submit-article · upload-media · link-hero · submit-comment · toggle-hero-ad · fetch-status · list-pending-review | Payload REST + JWT (`/api/*`) |

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

1. Operator edits `Essential Bali Proofread.xlsx` locally.
2. Runs `bridge/sync-articles-inbox.sh` to rsync to gda-ai01.
3. **Scraper.read-articles-xlsx** reads sheets (Apr/May/June/...) → row JSON.
4. For each row: optional **Scraper.read-google-doc** to pull Draft Link body.
5. **Copywriter** finalizes voice, **Imager**/**SEO**, **Web Manager** posts `pending_review`.

Both paths submit `status=pending_review` for human approval before publish.

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
# Crawler discovery
node /opt/.openclaw-ess/workspace-crawler/scripts/crawl-benchmark.mjs \
  --discover --site=thehoneycombers.com/bali --area=canggu --topic=dine

# xlsx reader (latest in inbox)
python3 /opt/.openclaw-ess/workspace-scraper/scripts/read-articles-xlsx.py | jq '.count'

# Google Doc fetch (must be shared with ai@gaiada.com)
python3 /opt/.openclaw-ess/workspace-scraper/scripts/read-google-doc.py \
  "https://docs.google.com/document/d/<DOC_ID>/edit" | head -20

# Payload connectivity (JWT login + /me from gda-ai01)
source /opt/.openclaw-ess/credentials/.env.payload
TOKEN=$(curl -s -X POST "$PAYLOAD_BASE_URL/api/users/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PAYLOAD_AGENT_EMAIL\",\"password\":\"$PAYLOAD_AGENT_PASSWORD\"}" \
  | jq -r .token)
curl -s "$PAYLOAD_BASE_URL/api/users/me" -H "Authorization: JWT $TOKEN" | jq '.user.role'
# → "ai-agent"
```
