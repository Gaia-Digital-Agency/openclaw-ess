#!/usr/bin/env node
/**
 * Phase 3 driver — generate the 20 homepage articles.
 *
 * For each plan item:
 *   1. Spawn dispatch-article.mjs (full crawler→copywriter→imager→seo→submit pipeline)
 *   2. After successful dispatch, PATCH the article with:
 *        - group: "<one of 5>"
 *        - status: "published"
 *   3. Sleep PACING_MS between articles to be polite to Imagen API
 *      (we saw 429s in earlier today's parallel work)
 *
 * Failure handling: per-article try/catch, log + continue. Failed
 * articles stay in pending_review (not published) so the human can
 * retry / fix later via /admin/homepage-curation.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PAYLOAD = readFileSync("/opt/.openclaw-ess/credentials/.env.payload", "utf8");
const ENV = {};
for (const line of PAYLOAD.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) ENV[m[1]] = m[2];
}
const PAYLOAD_BASE_URL = ENV.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";
const AGENT_EMAIL = ENV.PAYLOAD_AGENT_EMAIL;
const AGENT_PASSWORD = ENV.PAYLOAD_AGENT_PASSWORD;

const DISPATCHER = "/opt/.openclaw-ess/workspace-main/scripts/dispatch-article.mjs";

const PACING_MS = 20_000; // 20s between articles

// 20 articles · 4 per group · personas round-robin across 8.
// Briefs are intentionally specific so the Copywriter writes real
// fact-density content, not vague filler.
const PLAN = [
  // ── mostPopular ──────────────────────────────────────────────────
  { group: "mostPopular", persona: "maya",          area: "canggu",      topic: "featured",
    brief: "Canggu's real rhythm, told from the perspective of a Canggu local who knows the difference between the touristy parts and the working neighbourhoods. Five concrete observations about how the area actually feels on a Tuesday afternoon vs Saturday night. Mention specific spots like Echo Beach, Berawa, the Babi Guling place near the Banjar." },
  { group: "mostPopular", persona: "nadia-puspita", area: "ubud",        topic: "health-wellness",
    brief: "Ubud's healing triangle: the overlap between traditional Balinese healing (balian, jamu, ceremony) and the modern wellness retreat scene. Honest about which retreats are real and which are spa packaging. Name a few legit teachers and what makes them different." },
  { group: "mostPopular", persona: "kira-bumi",     area: "nusa-penida", topic: "activities",
    brief: "Nusa Penida by boat: the snorkeling and dive routes that are worth the 45-minute crossing from Sanur. Manta Bay, Crystal Bay, Gamat Bay — what you actually see at each, when to go, current strength, what to bring." },
  { group: "mostPopular", persona: "sang-ayu-rai",  area: "denpasar",    topic: "people-culture",
    brief: "Denpasar's banjar lives. The capital city is more than government offices — it's where Balinese community structure (banjar adat) survives in its densest form. Explain banjar, ceremony cycles, the Pasar Badung morning rhythm." },

  // ── trending ─────────────────────────────────────────────────────
  { group: "trending",    persona: "tomas-veld",    area: "kuta",        topic: "nightlife",
    brief: "Three Kuta bars that outlasted the Bintang-singlet hype cycle: who runs them, what they actually serve, and why they're still standing in 2026. Specific drink prices, set times, names of resident DJs." },
  { group: "trending",    persona: "maya",          area: "canggu",      topic: "dine",
    brief: "Five warungs in Canggu where Balinese and Javanese workers actually eat lunch — not the tourist-curated 'authentic' lists. Pricing under 30k IDR, opening hours, what the regulars order. Mention Warung Bu Mi, Warung Sopa, three more." },
  { group: "trending",    persona: "tomas-veld",    area: "jimbaran",    topic: "dine",
    brief: "Jimbaran beach seafood at sundown: a practical map of the warung clusters at Muaya and Kedonganan. How they price, which ones are family-run vs syndicate, when the catch arrives, the Balinese sambal that distinguishes them." },
  { group: "trending",    persona: "kira-bumi",     area: "ubud",        topic: "activities",
    brief: "A half-day walking loop from central Ubud: Campuhan ridge → Tjampuhan temple → Sayan rice paddies → back via the Wos river bridge. Distance, gradient, where to refill water, what to expect at each stop." },

  // ── ultimateGuide ────────────────────────────────────────────────
  { group: "ultimateGuide", persona: "nadia-puspita", area: "ubud",        topic: "dine",
    brief: "The vegetarian eats of Ubud, curated as a full-day walking guide. Six places spanning breakfast, lunch, snacks, dinner — vegan and ovo-lacto. Explain WHY each one is good (specific dishes, sourcing, technique), not just that it exists." },
  { group: "ultimateGuide", persona: "kira-bumi",     area: "canggu",      topic: "activities",
    brief: "Surfing Canggu year-round: a beginner's calendar by month. Wave size, crowds, school recommendations, board hire economics, the dry-season vs wet-season dynamics. Compare Old Mans, Berawa, Echo Beach." },
  { group: "ultimateGuide", persona: "kira-bumi",     area: "kintamani",   topic: "activities",
    brief: "Mount Batur sunrise hike: a practical booking guide. Real costs (300-450k IDR for proper guides, why the cheap ones are wrong), what to wear at altitude, what's at the summit, the tea-and-egg ritual, when not to do this hike." },
  { group: "ultimateGuide", persona: "sang-ayu-rai",  area: "singaraja",   topic: "featured",
    brief: "Singaraja's slow reveal: why North Bali's old Dutch capital matters more than the tourist circuit suggests. The colonial architecture, the Lovina dolphin-watching scene's complicated reputation, Banjar Tega's hot springs, the working harbour." },

  // ── overseas (here = 'regional spotlight beyond the main Bali tourist core') ──
  { group: "overseas",    persona: "kira-bumi",     area: "nusa-penida", topic: "featured",
    brief: "Nusa Penida positioned as Bali's wild sister island — bigger than people expect, less developed, more dramatic landscape. The east coast vs west coast vs central plateau. Manta Point, Kelingking, the temple at Goa Giri Putri." },
  { group: "overseas",    persona: "sang-ayu-rai",  area: "jimbaran",    topic: "featured",
    brief: "Jimbaran's crescent: the bay as a self-contained Bali microcosm — fishing village, luxury resort enclave, seafood tourism strip, traditional Balinese settlement, all within 4km. How they coexist." },
  { group: "overseas",    persona: "kira-bumi",     area: "kintamani",   topic: "featured",
    brief: "Kintamani's caldera floor: what's actually down there beyond the sunrise photos. The hot springs at Toya Bungkah, Trunyan's funerary tradition (where bodies aren't buried), the Lake Batur fishing community." },
  { group: "overseas",    persona: "sang-ayu-rai",  area: "singaraja",   topic: "news",
    brief: "Singaraja port redevelopment: the practical changes coming to North Bali's main harbour, the local concerns about what gets gentrified, what visitors might want to see before construction reshapes the waterfront." },

  // ── spotlight ────────────────────────────────────────────────────
  { group: "spotlight",   persona: "maya",          area: "denpasar",    topic: "dine",
    brief: "Denpasar day markets, where Balinese actually buy breakfast: Pasar Badung, Pasar Kumbasari, Pasar Sanglah. What time they peak, what's seasonal vs year-round, how to navigate as a foreigner without being annoying, sample dishes (nasi campur 15k, jaja Bali 5k)." },
  { group: "spotlight",   persona: "tomas-veld",    area: "canggu",      topic: "nightlife",
    brief: "Canggu's sunset shift: how the same five spots feel different at 5pm vs 7pm vs 10pm. Single Fin, La Brisa, Old Man's, plus two warungs that lean into the late shift. Drink price ranges, transition moments, what the locals do." },
  { group: "spotlight",   persona: "nadia-puspita", area: "ubud",        topic: "news",
    brief: "Ubud's new wellness studios: a 2026 review of which yoga and breathwork studios opened, which closed, who's gone serious vs who's selling lifestyle. Names, teachers, drop-in prices, what the actual practice is like (not the marketing)." },
  { group: "spotlight",   persona: "kira-bumi",     area: "kuta",        topic: "activities",
    brief: "Kuta beyond the beach: day-trip recommendations from locals who live in Kuta but don't go to the beach. Tukad Cepung waterfall, Garuda Wisnu Kencana, the Bali Bird Park, how to do them by motorbike vs taxi, half-day vs full-day budgets." },
];

// Validation pass
console.error(`[phase3] plan size: ${PLAN.length} articles`);
const groupCounts = PLAN.reduce((acc, p) => ({ ...acc, [p.group]: (acc[p.group] || 0) + 1 }), {});
console.error(`[phase3] per-group counts:`, groupCounts);
const personaCounts = PLAN.reduce((acc, p) => ({ ...acc, [p.persona]: (acc[p.persona] || 0) + 1 }), {});
console.error(`[phase3] per-persona counts:`, personaCounts);

let token = null;
async function login() {
  if (token) return token;
  const r = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: AGENT_EMAIL, password: AGENT_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  token = j.token;
  return token;
}

async function patchArticle(id, data) {
  const t = await login();
  const r = await fetch(`${PAYLOAD_BASE_URL}/api/articles/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Authorization: `JWT ${t}` },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`PATCH ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function runDispatch(input) {
  return new Promise((resolve) => {
    const proc = spawn("node", [DISPATCHER], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      // Forward dispatch logs to our stderr live so we can watch progress.
      process.stderr.write(s);
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    proc.on("close", (code) => {
      try {
        const json = JSON.parse(stdout || "{}");
        resolve({ code, json, stderr });
      } catch {
        resolve({ code, json: null, stderr, stdout });
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const summary = [];
  for (let i = 0; i < PLAN.length; i++) {
    const p = PLAN[i];
    const tag = `[${i + 1}/${PLAN.length}]`;
    console.error(`\n${tag} ${p.group} · ${p.area}/${p.topic} · persona=${p.persona}`);
    const t0 = Date.now();
    try {
      const dispatchResult = await runDispatch({
        area: p.area,
        topic: p.topic,
        persona: p.persona,
        brief: p.brief,
        target_words: 600,
      });
      if (dispatchResult.code !== 0 || !dispatchResult.json?.article_id) {
        const reason = dispatchResult.json?.status || `exit ${dispatchResult.code}`;
        console.error(`${tag} dispatch FAILED: ${reason}`);
        summary.push({ ...p, status: "dispatch_failed", reason });
        await sleep(PACING_MS);
        continue;
      }
      const articleId = dispatchResult.json.article_id;

      // Patch group + status=published
      try {
        const patched = await patchArticle(articleId, {
          group: p.group,
          status: "published",
          publishedAt: new Date().toISOString(),
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.error(`${tag} ✓ id=${articleId} group=${p.group} published (${dt}s)`);
        summary.push({ ...p, status: "ok", article_id: articleId, took: dt });
      } catch (e) {
        console.error(`${tag} dispatch ok but PATCH failed: ${e.message}`);
        summary.push({ ...p, status: "patch_failed", article_id: articleId, error: e.message });
      }
    } catch (e) {
      console.error(`${tag} EXCEPTION: ${e.message}`);
      summary.push({ ...p, status: "exception", error: e.message });
    }

    if (i < PLAN.length - 1) {
      console.error(`${tag} sleeping ${PACING_MS / 1000}s before next…`);
      await sleep(PACING_MS);
    }
  }

  console.error("\n\n=== Phase 3 final summary ===");
  const ok = summary.filter((s) => s.status === "ok").length;
  const failed = summary.length - ok;
  console.error(`  ${ok} ok / ${failed} failed`);
  for (const s of summary) {
    const id = s.article_id ? `#${s.article_id}` : "----";
    console.error(`  ${s.status.padEnd(15)} ${id}  ${s.group} · ${s.area}/${s.topic}`);
  }

  // Output JSON to stdout for downstream consumers / git commit reference
  console.log(JSON.stringify({ ok, failed, items: summary }, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
