#!/usr/bin/env node
/**
 * Elliot — review-gate
 *
 * Pre-flight checks for an article before it gets POSTed to Payload
 * as pending_review. Pulls the inline checks out of dispatch-article
 * into a standalone, callable skill that returns
 *   { ok: bool, issues: [{level, code, message}, ...] }
 *
 * Levels:
 *   "error"   — blocker, MUST fail the gate
 *   "warning" — note to operator, gate still passes
 *
 * Hard rules (errors):
 *   - empty title / body / area / topic
 *   - missing hero media id (errors UNLESS --allow-no-hero passed)
 *   - word_count < topic floor
 *       (Featured 400, Articles 400, Dine/Activities/H&W/Nightlife/People&Culture 400,
 *        Events 200, News 200)
 *   - banned phrase in title or body
 *   - SEO meta_title or meta_description empty
 *   - duplicate source.hash already in published / approved / pending_review
 *   - meta_title > 60 chars
 *   - meta_description > 160 chars
 *
 * Soft rules (warnings):
 *   - body word_count > 1500 (likely too long for News/Events)
 *   - sources array empty (no crawler citation)
 *   - keywords array empty
 *
 * Two input modes
 *   1. By article id (queries Payload):
 *        node review-gate.mjs --id=70
 *   2. JSON on stdin:
 *        cat draft.json | node review-gate.mjs
 *
 * Exit codes
 *   0 — passed (ok=true)
 *   2 — failed (ok=false; see issues array)
 *   3 — usage / network error
 */
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

for (const envPath of ["/opt/.openclaw-ess/credentials/.env.payload"]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PAYLOAD_BASE_URL =
  process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";

const BANNED = /\b(delve|tapestry|hidden gem|bustling|in the realm of|navigate the landscape|unveil|embark on a journey|testament to|a myriad of|it goes without saying|game-changer)\b/gi;

const WORD_FLOOR = {
  events: 200,
  news: 200,
  featured: 400,
  dine: 400,
  "health-wellness": 400,
  nightlife: 400,
  activities: 400,
  "people-culture": 400,
};

let _token = null;
async function login() {
  if (_token) return _token;
  const r = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.PAYLOAD_AGENT_EMAIL,
      password: process.env.PAYLOAD_AGENT_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  _token = (await r.json()).token;
  return _token;
}

async function fetchArticleById(id) {
  const t = await login();
  const r = await fetch(`${PAYLOAD_BASE_URL}/api/articles/${id}?depth=2`, {
    headers: { Authorization: `JWT ${t}` },
  });
  if (!r.ok) throw new Error(`article ${id} → ${r.status}`);
  const a = await r.json();
  // Lexical → text approximation for word counting.
  const lexicalToText = (n) => {
    if (!n) return "";
    if (typeof n === "string") return n;
    if (Array.isArray(n)) return n.map(lexicalToText).join(" ");
    if (typeof n === "object") {
      const own = typeof n.text === "string" ? n.text : "";
      const kids = Array.isArray(n.children) ? n.children.map(lexicalToText).join(" ") : "";
      return [own, kids, n.root ? lexicalToText(n.root) : ""].filter(Boolean).join(" ");
    }
    return "";
  };
  const bodyText = lexicalToText(a.body);
  return {
    id: a.id,
    title: a.title || "",
    sub_title: a.subTitle || "",
    body_markdown: bodyText,
    word_count: bodyText.split(/\s+/).filter(Boolean).length,
    area: typeof a.area === "object" ? a.area?.slug : null,
    topic: typeof a.topic === "object" ? a.topic?.slug : null,
    hero: typeof a.hero === "object" ? a.hero?.id : a.hero || null,
    meta_title: a.seo?.metaTitle || "",
    meta_description: a.seo?.metaDescription || "",
    keywords: a.seo?.keywords || [],
    sources: a.source && a.source.url ? [{ url: a.source.url, site: a.source.site }] : [],
    source_hash: a.source?.hash || null,
    status: a.status,
  };
}

async function isHashLocked(hash, ownId) {
  if (!hash) return false;
  const t = await login();
  // Look for non-rejected articles with this hash, excluding self.
  const url =
    `${PAYLOAD_BASE_URL}/api/articles?` +
    `where[source.hash][equals]=${encodeURIComponent(hash)}&` +
    `where[status][in]=published,approved,pending_review&` +
    `limit=5&depth=0`;
  const r = await fetch(url, { headers: { Authorization: `JWT ${t}` } });
  if (!r.ok) return false;
  const d = await r.json();
  return (d.docs || []).some((doc) => String(doc.id) !== String(ownId));
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--allow-no-hero") out.allowNoHero = true;
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1].replace(/-/g, "_")] = m[2];
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  let s = "";
  for await (const c of process.stdin) s += c;
  return s.trim() ? JSON.parse(s) : null;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  let article;
  if (flags.id) {
    article = await fetchArticleById(flags.id);
  } else {
    article = await readStdin();
    if (!article) {
      console.error("missing input — pass --id=N or pipe JSON");
      process.exit(3);
    }
    // If JSON has body_markdown but no word_count, compute it.
    if (!article.word_count && article.body_markdown) {
      article.word_count = String(article.body_markdown).split(/\s+/).filter(Boolean).length;
    }
  }

  const issues = [];
  const err = (code, message) => issues.push({ level: "error", code, message });
  const warn = (code, message) => issues.push({ level: "warning", code, message });

  // Hard rules
  if (!article.title || !String(article.title).trim()) err("empty_title", "title is empty");
  if (!article.body_markdown || !String(article.body_markdown).trim())
    err("empty_body", "body is empty");
  if (!article.area) err("missing_area", "area not set");
  if (!article.topic) err("missing_topic", "topic not set");

  if (!article.hero && !flags.allowNoHero)
    err("missing_hero", "no hero media linked");

  const floor = WORD_FLOOR[article.topic] ?? 400;
  if (article.word_count != null && article.word_count < floor)
    err("word_count_low", `word_count ${article.word_count} < floor ${floor} for topic ${article.topic}`);

  const titleHits = String(article.title || "").match(BANNED);
  if (titleHits) err("banned_in_title", `banned phrases in title: ${[...new Set(titleHits.map((s) => s.toLowerCase()))].join(", ")}`);
  const bodyHits = String(article.body_markdown || "").match(BANNED);
  if (bodyHits) err("banned_in_body", `banned phrases in body: ${[...new Set(bodyHits.map((s) => s.toLowerCase()))].join(", ")}`);

  if (!article.meta_title || !String(article.meta_title).trim())
    err("seo_meta_title_empty", "seo.metaTitle is empty");
  if (!article.meta_description || !String(article.meta_description).trim())
    err("seo_meta_description_empty", "seo.metaDescription is empty");

  if (article.meta_title && String(article.meta_title).length > 60)
    err("seo_meta_title_too_long", `meta_title is ${String(article.meta_title).length} chars (>60)`);
  if (article.meta_description && String(article.meta_description).length > 160)
    err("seo_meta_description_too_long", `meta_description is ${String(article.meta_description).length} chars (>160)`);

  // Duplicate hash
  if (article.source_hash) {
    const dup = await isHashLocked(article.source_hash, article.id);
    if (dup) err("hash_locked", `another non-rejected article already holds source.hash=${article.source_hash}`);
  }

  // Soft rules
  if (article.word_count != null && article.word_count > 1500)
    warn("word_count_high", `word_count ${article.word_count} > 1500 (likely too long)`);
  if (!article.sources || article.sources.length === 0)
    warn("no_sources", "no crawler-cited source");
  if (!article.keywords || article.keywords.length === 0)
    warn("no_keywords", "seo.keywords is empty");

  const errCount = issues.filter((i) => i.level === "error").length;
  const ok = errCount === 0;

  console.log(JSON.stringify({
    ok,
    article_id: article.id || null,
    title: article.title || null,
    area: article.area || null,
    topic: article.topic || null,
    word_count: article.word_count ?? null,
    error_count: errCount,
    warning_count: issues.length - errCount,
    issues,
  }, null, 2));
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("[review-gate] ERR:", e?.message || e);
  process.exit(3);
});
