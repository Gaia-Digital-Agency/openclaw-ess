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

// Brief templates per topic. Each template is a function (areaName) => string.
//
// Picker key changed (2026-04-29): the brief index is now `published`
// (how many articles already exist in the cell), not `cellIndex`. This
// way each successive plan-wave run for the same cell advances to a new
// brief — without this change, the brief string and therefore source.hash
// repeated, and dispatch-article hit `skipped_hash_locked` after the
// first article in any cell.
//
// 20 templates per topic × 8 areas = 160 unique briefs per topic = 1280
// total brief strings, matching the 20-per-cell × 64-cell target.
const BRIEF_TEMPLATES = {
  dine: [
    (a) => `three honest warungs in ${a} that locals queue at, not the cafes Instagram has decided are essential`,
    (a) => `breakfast in ${a} — where the actual locals eat at 7am, before the surf-tourist rush`,
    (a) => `the cheapest legitimately good meal in ${a} right now and what makes it work`,
    (a) => `${a}'s late-night food spots — the ones still open after 11pm with food that isn't an afterthought`,
    (a) => `vegetarian/vegan options in ${a} that aren't curated for expat Instagram, just cooked well`,
    (a) => `coffee in ${a} that isn't a $7 oat-milk experience — three roasters worth your morning`,
    (a) => `${a}'s seafood — what's local, what's caught yesterday, where you can taste the difference`,
    (a) => `desserts and traditional sweets in ${a} — Balinese kitchens, not the industrial gelato chains`,
    (a) => `lunch in ${a} for under 50k IDR — five places that take care over the price tag`,
    (a) => `the warung your driver eats at in ${a} — quietly excellent, no English menu, that's the point`,
    (a) => `${a}'s rice dishes — nasi campur, nasi goreng done with respect to the technique`,
    (a) => `food markets in ${a} — when to go, what to buy, how to navigate without the guidebook`,
    (a) => `${a}'s sambal scene — the chilli pastes that define a kitchen, where to find the great ones`,
    (a) => `street food in ${a} done well — the carts, the warungs, the night-market stalls`,
    (a) => `${a}'s cafés that work as actual workspaces — wifi, power, food worth lingering for`,
    (a) => `dining alone in ${a} — where solo travellers can sit at a counter and feel welcomed`,
    (a) => `babi guling in ${a} — the suckling-pig spots that still cook it the right way`,
    (a) => `${a}'s neighbourhood standbys — places that have been there twenty years and still pack out at lunch`,
    (a) => `weekend brunch in ${a} that isn't an Instagram set — three honest stacks of food`,
    (a) => `food souvenirs from ${a} — what to take home that survives the flight`,
  ],
  events: [
    (a) => `what's actually happening in ${a} this weekend — three events worth the trip across town`,
    (a) => `${a}'s monthly cultural calendar — the recurring events locals plan around`,
    (a) => `temple ceremonies and traditional events open to respectful visitors in ${a}`,
    (a) => `live music + small venues in ${a} this month`,
    (a) => `art openings in ${a} — galleries, pop-ups, studios opening to the public this season`,
    (a) => `food festivals in ${a} — when, what to expect, who shows up`,
    (a) => `${a}'s sports calendar — surf comps, runs, cycling events, regular meetups`,
    (a) => `workshops + classes in ${a} this month — language, cooking, craft, dance`,
    (a) => `screenings + film events in ${a} — small cinemas, expat film clubs, pop-up showings`,
    (a) => `markets in ${a} this weekend — farmer's, craft, vintage, who runs them`,
    (a) => `comedy + spoken-word in ${a} — the small rooms hosting live talent`,
    (a) => `yoga + wellness events in ${a} — workshops, retreats, drop-in masterclasses`,
    (a) => `${a}'s Galungan / Kuningan / Nyepi week — what locals do, what visitors should know`,
    (a) => `${a}'s expat meetups — language exchanges, business networks, community evenings`,
    (a) => `children + family events in ${a} — what's on for kids this month`,
    (a) => `charity + community fundraisers in ${a} — who's doing the work, how to show up`,
    (a) => `dance + traditional performance schedules in ${a} — kecak, legong, where to watch this week`,
    (a) => `surf events in ${a} — comps, screenings, brand activations on the beach`,
    (a) => `literary + book events in ${a} — readings, signings, writer-in-residence sessions`,
    (a) => `wellness retreats opening enrolment in ${a} — short-format intensive weeks`,
  ],
  news: [
    (a) => `recent change in ${a} that matters to people who live or visit — infrastructure, regulation, or local life`,
    (a) => `what's reshaping ${a}'s coastline / streets / market this season`,
    (a) => `local development project in ${a} that deserves more visibility than it's getting`,
    (a) => `zoning or planning shift in ${a} — what's coming, who decided, what it means for residents`,
    (a) => `road closures + construction in ${a} this month — what to plan around`,
    (a) => `tourism statistics for ${a} — what the numbers say about who's coming this season`,
    (a) => `environmental story in ${a} — water, waste, coastline, who's working on it`,
    (a) => `business openings + closures in ${a} that signal a wider shift`,
    (a) => `${a}'s village council news — banjar decisions affecting daily life`,
    (a) => `health and safety advisories for ${a} — current and recent`,
    (a) => `transport changes in ${a} — buses, ferries, ride-share regulation, ojek dynamics`,
    (a) => `${a}'s schools + education news — new programmes, teacher news, parent concerns`,
    (a) => `arts council + cultural funding news in ${a}`,
    (a) => `visa + immigration policy update affecting expats in ${a}`,
    (a) => `Bali-wide news with a ${a}-specific angle this week`,
    (a) => `property + rental market shifts in ${a} — what's moving, what's stuck`,
    (a) => `${a}'s utilities — water, power, waste, internet, what's changed`,
    (a) => `weather + seasonal advisory for ${a} this period`,
    (a) => `cultural-preservation effort in ${a} — what's at risk, who's responding`,
    (a) => `${a}'s expat-business news — openings, closures, regulatory changes worth tracking`,
  ],
  featured: [
    (a) => `the case for spending a full day in ${a} away from the obvious itinerary`,
    (a) => `${a} mapped properly — neighbourhoods, what each is for, who lives there`,
    (a) => `the side of ${a} the marketing brochures skip and locals love`,
    (a) => `a weekday in ${a} from sunrise to dinner, written by someone who lives there`,
    (a) => `${a} at sunrise — what the place looks like before the tour buses arrive`,
    (a) => `the case for a slow week in ${a} — three nights minimum, why anything less misses the point`,
    (a) => `${a} for locals — the places residents go that aren't on tourist routes`,
    (a) => `${a} on a budget — a real two-day plan that doesn't mean fast food`,
    (a) => `${a} for first-timers — the genuinely essential, no Instagram filler`,
    (a) => `${a}'s seasons — when to go, what's different, what locals love about each`,
    (a) => `${a}'s working day — what the rhythm looks like for residents Monday to Friday`,
    (a) => `${a}'s weekend — how locals actually spend Saturday and Sunday`,
    (a) => `${a} after dark, told without nightclub clichés`,
    (a) => `${a}'s small businesses worth supporting — who runs them, why it matters`,
    (a) => `${a} for the second visit — what to do when you've ticked the obvious boxes`,
    (a) => `${a}'s public spaces — parks, beaches, markets that anchor daily life`,
    (a) => `${a} in the rainy season — why it's underrated`,
    (a) => `${a}'s commute — how locals get around, what visitors get wrong`,
    (a) => `${a}'s old school + new school — heritage spots vs the new wave, both honoured`,
    (a) => `${a} with kids — what works, what doesn't, what locals do with theirs`,
  ],
  "health-wellness": [
    (a) => `quiet yoga studios in ${a} away from the main strip — small classes, teachers who know your name`,
    (a) => `traditional Balinese healing practices in ${a} — what they are, who practices, how to access respectfully`,
    (a) => `affordable spa days in ${a} that aren't watered-down hotel packages`,
    (a) => `running and walking routes in ${a} for people who want to move without driving 30 minutes first`,
    (a) => `meditation retreats in ${a} that are working, not selling — three options`,
    (a) => `martial arts in ${a} — silat, capoeira, jiu-jitsu, where to train as a beginner`,
    (a) => `${a}'s pilates + barre studios — small, well-instructed, not chain`,
    (a) => `sound healing in ${a} — what it actually is, where to try, what to expect`,
    (a) => `ayurvedic + traditional medicine practitioners in ${a} who have actual lineage`,
    (a) => `cycling routes in ${a} — road, gravel, mountain, scenic and safe`,
    (a) => `cold plunge + sauna in ${a} — the recovery setups worth the visit`,
    (a) => `nutrition + wellness food in ${a} — chefs cooking for performance not just aesthetics`,
    (a) => `${a}'s women-only fitness + wellness spaces`,
    (a) => `men's health + fitness in ${a} — the small gyms with serious community`,
    (a) => `swimming in ${a} — pools, beaches, what's safe, where lap-swim is possible`,
    (a) => `mental health support in ${a} — therapists, peer groups, retreats with actual licensing`,
    (a) => `recovery + rehab in ${a} — physiotherapy, sports therapy, where to go after injury`,
    (a) => `wellness events open to drop-ins in ${a} this month`,
    (a) => `${a}'s breathwork scene — practitioners worth booking`,
    (a) => `addiction recovery + sober community in ${a} — meetings, retreats, supportive networks`,
  ],
  nightlife: [
    (a) => `${a} after dark — three places that aren't beach clubs and aren't hostel bars`,
    (a) => `live music venues in ${a} where the band is the point, not the backdrop`,
    (a) => `sunset spots in ${a} that don't require a reservation a week ahead`,
    (a) => `where to drink in ${a} on a Tuesday — the ones that make weeknights feel right`,
    (a) => `cocktail bars in ${a} taking the craft seriously — three with bartenders worth the trip`,
    (a) => `${a}'s neighbourhood pubs — local feel, no DJ, no entry charge`,
    (a) => `dancing in ${a} — where to actually move, not be photographed`,
    (a) => `${a}'s late-night spots — open past 2am, food still on`,
    (a) => `natural wine + small-list bars in ${a} — for the slow drinkers`,
    (a) => `rooftop venues in ${a} that don't charge resort prices`,
    (a) => `${a}'s underground + alternative scene — punk, hardcore, electronic underground`,
    (a) => `${a} for couples — date-night bars that aren't trying too hard`,
    (a) => `solo drinking in ${a} — counters where you can sit alone and not be hustled`,
    (a) => `${a}'s LGBTQ+-friendly nightlife — venues, nights, organisers worth knowing`,
    (a) => `${a}'s comedy clubs + variety nights`,
    (a) => `early-evening drinks in ${a} — happy hour without the ironic neon`,
    (a) => `craft beer in ${a} — brewers, taprooms, bottle shops worth visiting`,
    (a) => `open-mic + jam sessions in ${a} — where amateurs are welcome`,
    (a) => `${a}'s lounge-music + jazz venues`,
    (a) => `${a}'s end-of-night food — what to eat at 3am that won't ruin you`,
  ],
  activities: [
    (a) => `things to do in ${a} that don't require a tour booking or an Instagram filter`,
    (a) => `${a}'s outdoor day — surfing / hiking / diving / cycling, whichever the geography demands`,
    (a) => `kid-friendly things to do in ${a} that adults also enjoy`,
    (a) => `half-day activities in ${a} for when you have one window between meetings or before a flight`,
    (a) => `surf spots in ${a} for each level — beginner to intermediate to advanced`,
    (a) => `snorkel + dive sites in ${a} — where the water's clean, marine life intact`,
    (a) => `hiking + walking routes in ${a} — half-day to full-day, scenic to challenging`,
    (a) => `cycling routes in ${a} — coastal, rural, urban, what bike for each`,
    (a) => `cooking classes in ${a} that teach actual technique, not staged photo-ops`,
    (a) => `craft workshops in ${a} — batik, jewelry, woodwork, ceramics`,
    (a) => `language exchanges + cultural workshops in ${a} for visitors who want depth`,
    (a) => `photography spots in ${a} that aren't already saturated on social media`,
    (a) => `${a}'s waterfalls + natural pools — accessible, respectful, what to know before going`,
    (a) => `boat trips + island hops from ${a} — what's worth booking, what to skip`,
    (a) => `paragliding + adventure activities in ${a} — operators with real safety records`,
    (a) => `${a}'s temples open to visitors — etiquette, timing, what to wear`,
    (a) => `street art + walking tours in ${a} — self-guided routes`,
    (a) => `${a}'s farms + agro-tourism — coffee, cacao, rice, what's working`,
    (a) => `yoga + movement classes in ${a} for drop-ins`,
    (a) => `${a}'s rainy-day activities — what to do when the surf's blown out`,
  ],
  "people-culture": [
    (a) => `a single Balinese ritual or daily practice in ${a}, observed without exoticisation`,
    (a) => `the artisans of ${a} — one craft tradition, one practitioner, one studio you can visit`,
    (a) => `${a}'s Banjar — what the local community council does and why it shapes daily life`,
    (a) => `the language layer in ${a} — Bahasa, Balinese, English mixing in everyday speech`,
    (a) => `profile of one resident in ${a} — work, family, daily rhythm, what they wish visitors understood`,
    (a) => `${a}'s temple festivals — the calendar, the meaning, how to attend respectfully`,
    (a) => `traditional dance + music in ${a} — practitioners, where they teach, where they perform`,
    (a) => `${a}'s women — leaders, artists, business owners shaping the community`,
    (a) => `${a}'s elders — what they remember, what's changed, what's being lost`,
    (a) => `children growing up in ${a} — what their day looks like, what's expected`,
    (a) => `${a}'s diaspora returnees — Balinese who left and came back, what brought them`,
    (a) => `${a}'s expat community — who's putting down roots, who's transient, what they contribute`,
    (a) => `food traditions in ${a} — what's cooked at home, who teaches whom`,
    (a) => `${a}'s craftsmen — wood carvers, silversmiths, weavers, painters in working studios`,
    (a) => `${a}'s farmers — who's still on the land, what they grow, who buys`,
    (a) => `religious life in ${a} beyond the headline temples — neighbourhood shrines, daily offerings`,
    (a) => `${a}'s teachers — the educators shaping local kids, what they need`,
    (a) => `${a}'s healers — traditional and modern, who consults whom, when`,
    (a) => `births, weddings, cremations in ${a} — the rites and what they involve`,
    (a) => `${a}'s sense of place — a single landmark or street and what it means to those who live near it`,
  ],
};

function pickBrief(areaName, topicSlug, briefIndex) {
  const list = BRIEF_TEMPLATES[topicSlug];
  if (!list || list.length === 0) {
    return `a thoughtful piece on ${topicSlug.replace(/-/g, " ")} in ${areaName}`;
  }
  return list[briefIndex % list.length](areaName);
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
//
// Brief selection note:
//   The queue carries ONE entry per deficit-cell. The brief picked uses
//   the cell's existing `published` count as the index into the topic's
//   template list. So:
//     run 1 (cell at 0)  → templates[0]
//     run 2 (cell at 1)  → templates[1]
//     ...
//     run 20 (cell at 19) → templates[19]
//   With 20 templates per topic, 20 sequential runs fully populate every
//   cell with no source.hash collisions. If you re-run beyond 20 the
//   index wraps and dispatch-article will hash-lock the dupes (expected).
function buildQueue(counts) {
  const queue = [];
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
        brief: pickBrief(a.name, t.slug, published),
        target_words: t.target_words,
        published,
        deficit,
      });
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
