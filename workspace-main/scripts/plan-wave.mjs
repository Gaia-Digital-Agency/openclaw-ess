#!/usr/bin/env node
/**
 * Elliot — plan-wave orchestrator.
 *
 * Reads the live state of the production matrix from Payload, decides
 * which (area, topic) cells need the most attention, picks a sensible
 * persona + brief per cell, and either:
 *
 *   - Prints the prioritised queue (default — no side effects)
 *   - Executes the queue by piping each entry through dispatch-article.mjs
 *     with rate limiting + retry on failure (--execute)
 *
 * Wave strategy
 *
 *   Wave 1 — full-matrix seeding: every cell gets at least 1 published
 *            article before any cell gets a 2nd. Cells with deficit = 20
 *            (nothing published) come first.
 *   Wave 2+ — sustain: prioritise cells with the largest gap to the 20-per-cell
 *            target, weighted by how stale the most recent article is.
 *
 * Usage
 *
 *   # Print plan only (default)
 *   node plan-wave.mjs
 *
 *   # Limit to top-N cells
 *   node plan-wave.mjs --limit=10
 *
 *   # Actually dispatch — RATE-LIMITED to 1/min by default
 *   node plan-wave.mjs --execute --limit=5
 *
 *   # Override pacing (seconds between dispatches)
 *   node plan-wave.mjs --execute --limit=20 --gap=90
 *
 *   # Dry-run — show every dispatch input but don't fire
 *   node plan-wave.mjs --execute --dry-run --limit=3
 *
 * Required env (or .env.payload):
 *   PAYLOAD_BASE_URL, PAYLOAD_AGENT_EMAIL, PAYLOAD_AGENT_PASSWORD
 *
 * Output (stdout): JSON
 *   {
 *     wave: 1,
 *     target_per_cell: 20,
 *     total_cells: 64,
 *     planned: number,
 *     queue: [{area, topic, persona, brief, target_words,
 *              published, deficit, rank}, ...],
 *     executed?: [{area, topic, status, article_id?, error?}, ...]
 *   }
 *
 * Exit codes
 *   0  plan or execute completed (read JSON output for details)
 *   2  no cells need work (all at target)
 *   3  payload auth / network error
 *   4  one or more dispatches failed in --execute mode
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

// ── env loaders ─────────────────────────────────────────────────────
for (const envPath of [
  "/opt/.openclaw-ess/credentials/.env.payload",
]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const PAYLOAD_BASE_URL =
  process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";
const PAYLOAD_AGENT_EMAIL =
  process.env.PAYLOAD_AGENT_EMAIL || "elliot@gaiada.com";
const PAYLOAD_AGENT_PASSWORD = process.env.PAYLOAD_AGENT_PASSWORD;

const DISPATCH_SCRIPT =
  "/opt/.openclaw-ess/workspace-main/scripts/dispatch-article.mjs";

const TARGET_PER_CELL = 20;

// ── domain config: fixed 8x8 matrix ─────────────────────────────────
const AREAS = [
  { slug: "canggu", name: "Canggu" },
  { slug: "kuta", name: "Kuta" },
  { slug: "ubud", name: "Ubud" },
  { slug: "jimbaran", name: "Jimbaran" },
  { slug: "denpasar", name: "Denpasar" },
  { slug: "kintamani", name: "Kintamani" },
  { slug: "singaraja", name: "Singaraja" },
  { slug: "nusa-penida", name: "Nusa Penida" },
];
const TOPICS = [
  { slug: "events", name: "Events", target_words: 400 },
  { slug: "news", name: "News", target_words: 300 },
  { slug: "featured", name: "Featured", target_words: 700 },
  { slug: "dine", name: "Dine", target_words: 600 },
  { slug: "health-wellness", name: "Health & Wellness", target_words: 600 },
  { slug: "nightlife", name: "Nightlife", target_words: 500 },
  { slug: "activities", name: "Activities", target_words: 600 },
  { slug: "people-culture", name: "People & Culture", target_words: 600 },
];

// Persona auto-routing per topic.
const TOPIC_PERSONA = {
  dine: "maya",
  "health-wellness": "komang",
  activities: "komang",
  "people-culture": "putu",
  featured: "putu",
  news: "putu",
  events: "sari",
  nightlife: "sari",
};

// Brief templates, rotated by cell so 64 dispatches don't all read identically.
// Each template is a function (areaName) => string.
const BRIEF_TEMPLATES = {
  dine: [
    (a) => `three honest warungs in ${a} that locals queue at, not the cafes Instagram has decided are essential`,
    (a) => `breakfast in ${a} — where the actual locals eat at 7am, before the surf-tourist rush`,
    (a) => `the cheapest legitimately good meal in ${a} right now and what makes it work`,
    (a) => `${a}'s late-night food spots — the ones still open after 11pm with food that isn't an afterthought`,
    (a) => `vegetarian/vegan options in ${a} that aren't curated for expat Instagram, just cooked well`,
  ],
  events: [
    (a) => `what's actually happening in ${a} this weekend — three events worth the trip across town`,
    (a) => `${a}'s monthly cultural calendar — the recurring events locals plan around`,
    (a) => `temple ceremonies and traditional events open to respectful visitors in ${a}`,
    (a) => `live music + small venues in ${a} this month`,
  ],
  news: [
    (a) => `recent change in ${a} that matters to people who live or visit — infrastructure, regulation, or local life`,
    (a) => `what's reshaping ${a}'s coastline / streets / market this season`,
    (a) => `local development project in ${a} that deserves more visibility than it's getting`,
  ],
  featured: [
    (a) => `the case for spending a full day in ${a} away from the obvious itinerary`,
    (a) => `${a} mapped properly — neighbourhoods, what each is for, who lives there`,
    (a) => `the side of ${a} the marketing brochures skip and locals love`,
    (a) => `a weekday in ${a} from sunrise to dinner, written by someone who lives there`,
  ],
  "health-wellness": [
    (a) => `quiet yoga studios in ${a} away from the main strip — small classes, teachers who know your name`,
    (a) => `traditional Balinese healing practices in ${a} — what they are, who practices, how to access respectfully`,
    (a) => `affordable spa days in ${a} that aren't watered-down hotel packages`,
    (a) => `running and walking routes in ${a} for people who want to move without driving 30 minutes first`,
  ],
  nightlife: [
    (a) => `${a} after dark — three places that aren't beach clubs and aren't hostel bars`,
    (a) => `live music venues in ${a} where the band is the point, not the backdrop`,
    (a) => `sunset spots in ${a} that don't require a reservation a week ahead`,
    (a) => `where to drink in ${a} on a Tuesday — the ones that make weeknights feel right`,
  ],
  activities: [
    (a) => `things to do in ${a} that don't require a tour booking or an Instagram filter`,
    (a) => `${a}'s outdoor day — surfing / hiking / diving / cycling, whichever the geography demands`,
    (a) => `kid-friendly things to do in ${a} that adults also enjoy`,
    (a) => `half-day activities in ${a} for when you have one window between meetings or before a flight`,
  ],
  "people-culture": [
    (a) => `a single Balinese ritual or daily practice in ${a}, observed without exoticisation`,
    (a) => `the artisans of ${a} — one craft tradition, one practitioner, one studio you can visit`,
    (a) => `${a}'s Banjar — what the local community council does and why it shapes daily life`,
    (a) => `the language layer in ${a} — Bahasa, Balinese, English mixing in everyday speech`,
  ],
};

function pickBrief(areaName, topicSlug, cellIndex) {
  const list = BRIEF_TEMPLATES[topicSlug];
  if (!list || list.length === 0) {
    return `a thoughtful piece on ${topicSlug.replace(/-/g, " ")} in ${areaName}`;
  }
  return list[cellIndex % list.length](areaName);
}

// ── tiny utils ──────────────────────────────────────────────────────
const log = (...a) => console.error("[plan-wave]", ...a);

let _token = null;
async function login() {
  if (_token) return _token;
  if (!PAYLOAD_AGENT_PASSWORD) throw new Error("PAYLOAD_AGENT_PASSWORD env missing");
  const res = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PAYLOAD_AGENT_EMAIL, password: PAYLOAD_AGENT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  _token = d.token;
  if (!_token) throw new Error("login: no token");
  return _token;
}

async function payloadGet(path) {
  const token = await login();
  const res = await fetch(`${PAYLOAD_BASE_URL}${path}`, {
    headers: { Authorization: `JWT ${token}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function findIdBySlug(collection, slug) {
  const d = await payloadGet(
    `/api/${collection}?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=0`,
  );
  return d?.docs?.[0]?.id || null;
}

// Count published+approved+pending_review articles per (area, topic).
// Anything in those statuses counts toward "in flight or done" — we don't
// dispatch fresh ones for cells that already have inventory.
async function countPerCell() {
  const areaIds = {};
  const topicIds = {};
  for (const a of AREAS) areaIds[a.slug] = await findIdBySlug("areas", a.slug);
  for (const t of TOPICS) topicIds[t.slug] = await findIdBySlug("topics", t.slug);

  // Pull ALL non-draft articles in one go (small dataset; 64 cells × 20 = 1280 max).
  const all = await payloadGet(
    `/api/articles?where[status][in]=published,approved,pending_review&limit=2000&depth=0`,
  );
  const counts = {};
  for (const doc of all.docs || []) {
    const aId = typeof doc.area === "object" ? doc.area?.id : doc.area;
    const tId = typeof doc.topic === "object" ? doc.topic?.id : doc.topic;
    const aSlug = Object.keys(areaIds).find((k) => areaIds[k] === aId);
    const tSlug = Object.keys(topicIds).find((k) => topicIds[k] === tId);
    if (!aSlug || !tSlug) continue;
    const key = `${aSlug}|${tSlug}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ── plan-wave main ──────────────────────────────────────────────────
function buildQueue(counts) {
  const queue = [];
  let cellIndex = 0;
  for (const a of AREAS) {
    for (const t of TOPICS) {
      const key = `${a.slug}|${t.slug}`;
      const published = counts[key] || 0;
      const deficit = Math.max(0, TARGET_PER_CELL - published);
      if (deficit === 0) continue;
      queue.push({
        area: a.slug,
        topic: t.slug,
        persona: TOPIC_PERSONA[t.slug] || "putu",
        brief: pickBrief(a.name, t.slug, cellIndex),
        target_words: t.target_words,
        published,
        deficit,
      });
      cellIndex += 1;
    }
  }
  // Wave 1 priority: cells with deficit = 20 (nothing in flight) first.
  // Then cells with smaller deficits, descending by deficit.
  queue.sort((x, y) => {
    if (x.deficit !== y.deficit) return y.deficit - x.deficit;
    // Stable secondary by area then topic alphabetically — predictable order.
    if (x.area !== y.area) return x.area.localeCompare(y.area);
    return x.topic.localeCompare(y.topic);
  });
  queue.forEach((q, i) => (q.rank = i + 1));
  return queue;
}

// ── dispatch executor ───────────────────────────────────────────────
async function runOneDispatch(entry) {
  return new Promise((resolveP) => {
    const proc = spawn("node", [DISPATCH_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.stdin.write(JSON.stringify({
      area: entry.area,
      topic: entry.topic,
      persona: entry.persona,
      brief: entry.brief,
      target_words: entry.target_words,
    }));
    proc.stdin.end();
    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          resolveP({ status: "ok", area: entry.area, topic: entry.topic,
                     article_id: parsed.article_id, hash: parsed.hash });
        } catch {
          resolveP({ status: "error", area: entry.area, topic: entry.topic,
                     error: "bad JSON from dispatch" });
        }
      } else if (code === 2) {
        resolveP({ status: "skipped", area: entry.area, topic: entry.topic,
                   reason: "hash_locked", stderr: stderr.slice(0, 300) });
      } else {
        resolveP({ status: "error", area: entry.area, topic: entry.topic,
                   exit: code, error: stderr.slice(0, 400) });
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── arg parsing ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { execute: false, dryRun: false, limit: null, gap: 60 };
  for (const a of argv) {
    if (a === "--execute") out.execute = true;
    else if (a === "--dry-run") out.dryRun = true;
    else {
      const m = a.match(/^--([^=]+)=(.*)$/);
      if (m) out[m[1].replace(/-/g, "_")] = m[2];
    }
  }
  if (out.limit) out.limit = Number(out.limit);
  if (out.gap) out.gap = Number(out.gap);
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  log(`gathering counts from ${PAYLOAD_BASE_URL}…`);

  let counts;
  try {
    counts = await countPerCell();
  } catch (e) {
    console.error(JSON.stringify({ status: "error", phase: "count", message: e.message }, null, 2));
    process.exit(3);
  }

  let queue = buildQueue(counts);
  if (queue.length === 0) {
    console.log(JSON.stringify({
      wave: 1,
      target_per_cell: TARGET_PER_CELL,
      total_cells: AREAS.length * TOPICS.length,
      planned: 0,
      queue: [],
      message: "every cell already at target",
    }, null, 2));
    process.exit(2);
  }

  if (flags.limit && flags.limit > 0) queue = queue.slice(0, flags.limit);

  // Plan-only mode
  if (!flags.execute) {
    console.log(JSON.stringify({
      wave: 1,
      target_per_cell: TARGET_PER_CELL,
      total_cells: AREAS.length * TOPICS.length,
      planned: queue.length,
      queue,
    }, null, 2));
    return;
  }

  // Execute mode — rate-limited dispatch loop.
  log(`executing ${queue.length} dispatches with ${flags.gap}s gap${flags.dryRun ? " (DRY RUN)" : ""}`);
  const executed = [];
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    log(`[${i + 1}/${queue.length}] ${entry.area}/${entry.topic} persona=${entry.persona}`);
    if (flags.dryRun) {
      executed.push({ status: "dry_run", area: entry.area, topic: entry.topic, brief: entry.brief });
    } else {
      const r = await runOneDispatch(entry);
      executed.push(r);
      log(`   → ${r.status}${r.article_id ? " article_id=" + r.article_id : ""}${r.error ? " " + r.error.slice(0, 120) : ""}`);
    }
    if (i < queue.length - 1 && !flags.dryRun) await sleep(flags.gap * 1000);
  }

  const okCount = executed.filter((x) => x.status === "ok").length;
  const errCount = executed.filter((x) => x.status === "error").length;
  console.log(JSON.stringify({
    wave: 1,
    target_per_cell: TARGET_PER_CELL,
    planned: queue.length,
    executed_count: executed.length,
    succeeded: okCount,
    failed: errCount,
    skipped: executed.filter((x) => x.status === "skipped").length,
    executed,
  }, null, 2));
  process.exit(errCount > 0 ? 4 : 0);
}

main().catch((e) => {
  console.error("[plan-wave] FATAL:", e?.message || e);
  process.exit(1);
});
