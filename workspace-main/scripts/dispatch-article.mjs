#!/usr/bin/env node
/**
 * Elliot — dispatch-article orchestrator (Path B).
 *
 * End-to-end pipeline for one (area, topic) draft:
 *
 *   crawler (optional)  →  copywriter  →  imager  →  seo  →  web-manager
 *                                                            │
 *                                                            ▼
 *                                              POST /api/articles
 *                                              status: pending_review
 *
 * Path B = "delete + re-dispatch" semantics. We treat existing rows
 * with status ∈ {pending_review, approved, published} as a hash-lock —
 * they block fresh drafts for the same (area, topic, source.hash).
 * Rows with status = rejected OR rows the user has deleted are NOT
 * a block — the next dispatch produces a clean new draft.
 *
 * Usage:
 *   node dispatch-article.mjs --area=canggu --topic=dine \
 *     --persona=maya --brief="three honest warungs in Canggu"
 *
 *   echo '{"area":"canggu","topic":"dine","persona":"maya",
 *          "brief":"three honest warungs in Canggu",
 *          "skip_imager":false, "target_words":600,
 *          "research_url":"https://thehoneycombers.com/bali/..."}' \
 *     | node dispatch-article.mjs
 *
 * Required env (or .env.payload):
 *   PAYLOAD_BASE_URL          (e.g. https://essentialbali.gaiada.online)
 *   PAYLOAD_AI_EMAIL          (e.g. ai-agent@gaiada.com)
 *   PAYLOAD_AI_PASSWORD       (matching the user account password)
 *
 * Outputs to stdout:
 *   { status, article_id, article_url, copywriter, seo, imager,
 *     skipped, hash, area, topic }
 *
 * Exit codes:
 *   0  success — article in pending_review
 *   2  hash-locked (skipped intentionally)
 *   3  agent step failed (copywriter / imager / seo)
 *   4  web-manager push failed
 *   5  bad input
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env loaders ─────────────────────────────────────────────────────
for (const envPath of [
  "/opt/.openclaw-ess/credentials/.env.vertex",
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
  process.env.PAYLOAD_AGENT_EMAIL ||
  process.env.PAYLOAD_AI_EMAIL ||
  "elliot@gaiada.com";
const PAYLOAD_AGENT_PASSWORD =
  process.env.PAYLOAD_AGENT_PASSWORD ||
  process.env.PAYLOAD_AI_PASSWORD ||
  process.env.PAYLOAD_AI_API_KEY;

const COPYWRITER = "/opt/.openclaw-ess/workspace-copywriter/scripts/draft-article.mjs";
// SEO agent now lives as an HTTP service at Payload (/api/seo-optimize),
// authoritative single source of truth (used by Articles.beforeChange too).
const SEO_AGENT_URL = `${process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online"}/api/seo-optimize`;
const IMAGER = "/opt/.openclaw-ess/workspace-imager/scripts/generate-hero.mjs";

// ── tiny utils ──────────────────────────────────────────────────────
const log = (...a) => console.error("[dispatch]", ...a);

function hashOf(area, topic, brief, researchUrl) {
  const h = createHash("sha256");
  h.update(`${area}|${topic}|${brief || ""}|${researchUrl || ""}`);
  return h.digest("hex").slice(0, 16);
}

async function runJsonAgent(scriptPath, input, label) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`${label} exit ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      try {
        resolveP(JSON.parse(stdout));
      } catch (e) {
        rejectP(new Error(`${label} bad JSON: ${e.message}\n${stdout.slice(0, 400)}`));
      }
    });
  });
}

// ── Payload client ──────────────────────────────────────────────────
let _token = null;
async function login() {
  if (_token) return _token;
  if (!PAYLOAD_AGENT_PASSWORD) {
    throw new Error("PAYLOAD_AGENT_PASSWORD env missing");
  }
  const res = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PAYLOAD_AGENT_EMAIL, password: PAYLOAD_AGENT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  _token = data.token;
  if (!_token) throw new Error("login: no token in response");
  return _token;
}

async function payloadFetch(path, init = {}) {
  const token = await login();
  const headers = { ...(init.headers || {}), Authorization: `JWT ${token}` };
  return fetch(`${PAYLOAD_BASE_URL}${path}`, { ...init, headers });
}

async function findTaxonomyIdBySlug(collection, slug) {
  const res = await payloadFetch(
    `/api/${collection}?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=0`,
  );
  if (!res.ok) throw new Error(`${collection} lookup ${res.status}`);
  const d = await res.json();
  return d?.docs?.[0]?.id || null;
}

async function checkExisting(area, topic, sourceHash) {
  // Path B: only block when an existing row holds the hash AND is in a
  // protected status. Rejected/deleted rows do not block.
  const url =
    `/api/articles?` +
    `where[source.hash][equals]=${encodeURIComponent(sourceHash)}&` +
    `where[status][in]=pending_review,approved,published&` +
    `limit=1&depth=0`;
  const res = await payloadFetch(url);
  if (!res.ok) throw new Error(`existing-check ${res.status}`);
  const d = await res.json();
  return d?.docs?.[0] || null;
}

async function uploadHero(filepath, alt, meta = {}) {
  // meta = { area, topic, linkedArticle? } — used by the N3 canonical-
  // filename hook on the Media collection. We always set source=imager
  // + kind=hero here. linkedArticle is optional because dispatch creates
  // the article AFTER the hero upload; in that case the slug falls back
  // to the alt text (which contains the title), still producing a clean
  // canonical name like imager_hero_<area>_<topic>_<title-slug>-<nano>.webp.
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(filepath);
  const FormDataNode = (await import("formdata-node")).FormData;
  const { Blob } = await import("node:buffer");
  const form = new FormDataNode();
  form.set("file", new Blob([buf], { type: "image/png" }), filepath.split("/").pop());
  const payload = {
    alt: alt || "Hero image",
    source: "imager",
    kind: "hero",
    ...(meta.area ? { area: meta.area } : {}),
    ...(meta.topic ? { topic: meta.topic } : {}),
    ...(meta.linkedArticle ? { linkedArticle: meta.linkedArticle } : {}),
  };
  form.set("_payload", JSON.stringify(payload));
  const res = await payloadFetch("/api/media", { method: "POST", body: form });
  if (!res.ok) throw new Error(`media upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d?.doc?.id || d?.id;
}

function markdownToLexical(md) {
  // Minimal Lexical document: paragraphs split by blank line. Good enough
  // for a first pass — the human reviewer can format-polish in the editor.
  const blocks = String(md || "").split(/\n\n+/).filter(Boolean);
  return {
    root: {
      type: "root",
      version: 1,
      direction: "ltr",
      format: "",
      indent: 0,
      children: blocks.map((b) => ({
        type: "paragraph",
        version: 1,
        direction: "ltr",
        format: "",
        indent: 0,
        children: [{ type: "text", version: 1, format: 0, text: b }],
      })),
    },
  };
}

async function submitArticle({
  area, topic, areaId, topicId, personaId, copy, seo, heroId, sourceUrl, sourceHash,
}) {
  const body = markdownToLexical(copy.body_markdown);
  const payload = {
    title: copy.title,
    slug: copy.slug,
    subTitle: copy.sub_title || undefined,
    area: areaId,
    topic: topicId,
    ...(personaId ? { persona: personaId } : {}),
    status: "pending_review",
    body,
    hero: heroId || undefined,
    seo: {
      metaTitle: (seo?.meta_title || copy.meta_title || "").slice(0, 60),
      metaDescription: (seo?.meta_description || copy.meta_description || "").slice(0, 160),
      keywords:
        (seo && [seo.primary_keyword, ...(seo.long_tail_keywords || [])].filter(Boolean)) ||
        copy.keywords || [],
    },
    source: {
      url: sourceUrl || (copy.sources?.[0]?.url ?? null),
      site: copy.sources?.[0]?.site || null,
      hash: sourceHash,
    },
  };
  const res = await payloadFetch("/api/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`submit-article ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  return d?.doc || d;
}

// ── arg parsing ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
async function readStdinIfPresent() {
  if (process.stdin.isTTY) return null;
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim() ? JSON.parse(s) : null;
}

// ── orchestrator ────────────────────────────────────────────────────
async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stdinJson = await readStdinIfPresent();
  const input = { ...flags, ...(stdinJson || {}) };

  const required = ["area", "topic", "persona", "brief"];
  for (const k of required) {
    if (!input[k]) {
      console.error(`[dispatch] missing required: ${k}`);
      process.exit(5);
    }
  }
  const area = String(input.area);
  const topic = String(input.topic);
  const persona = String(input.persona);
  const brief = String(input.brief);
  const researchUrl = input.research_url || null;
  const skipImager = !!input.skip_imager;
  const targetWords = input.target_words ? Number(input.target_words) : null;

  const sourceHash = hashOf(area, topic, brief, researchUrl);
  log(`hash ${sourceHash} ${area}/${topic} persona=${persona}`);

  // 1. Hash lock check
  const existing = await checkExisting(area, topic, sourceHash);
  if (existing) {
    log(`hash-locked by article id=${existing.id} status=${existing.status} — skipping`);
    console.log(JSON.stringify({
      status: "skipped_hash_locked",
      hash: sourceHash,
      area, topic,
      existing_id: existing.id,
      existing_status: existing.status,
    }, null, 2));
    process.exit(2);
  }

  // 2. Resolve area/topic ids
  const [areaId, topicId, personaId] = await Promise.all([
    findTaxonomyIdBySlug("areas", area),
    findTaxonomyIdBySlug("topics", topic),
    findTaxonomyIdBySlug("personas", persona),
  ]);
  if (!areaId || !topicId) {
    console.error(`[dispatch] taxonomy lookup failed area=${areaId} topic=${topicId}`);
    process.exit(3);
  }
  if (!personaId) {
    log(`persona slug "${persona}" not found in /api/personas — submitting with persona=null`);
  }

  // 3. Copywriter
  log("copywriter…");
  let copy;
  try {
    copy = await runJsonAgent(
      COPYWRITER,
      { area, topic, persona, brief, ...(targetWords ? { target_words: targetWords } : {}) },
      "copywriter",
    );
  } catch (e) {
    console.error(`[dispatch] copywriter failed: ${e.message}`);
    process.exit(3);
  }
  if ((copy.banned_phrases_found || []).length) {
    log(`copywriter banned-phrases: ${copy.banned_phrases_found.join(", ")} — manual review needed`);
  }

  // 4. SEO — HTTP call to Payload (canonical impl in cms/src/lib/seo-agent.ts)
  log("seo…");
  let seo = null;
  try {
    const token = await login();
    const res = await fetch(SEO_AGENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `JWT ${token}` },
      body: JSON.stringify({
        area, topic,
        title: copy.title,
        subTitle: copy.sub_title,
        bodyText: copy.body_markdown,
        existingMetaTitle: copy.meta_title,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = await res.json();
    // Map back to the shape downstream code expects.
    seo = {
      primary_keyword: out.primary_keyword,
      long_tail_keywords: out.long_tail_keywords || [],
      meta_title: out.meta_title,
      meta_description: out.meta_description,
      internal_link_anchors: out.internal_link_anchors || [],
    };
  } catch (e) {
    log(`seo failed (non-fatal): ${e.message}`);
  }

  // 5. Imager (optional)
  let heroId = null;
  if (!skipImager) {
    log("imager…");
    try {
      const im = await runJsonAgent(
        IMAGER,
        {
          area, topic, persona,
          title: copy.title,
          summary: copy.sub_title || copy.title,
          out_dir: "/tmp/dispatch-hero",
        },
        "imager",
      );
      const heroPath = im?.files?.[0]?.path;
      const heroAlt = im?.files?.[0]?.alt_text || copy.title;
      if (heroPath) {
        log(`imager → uploading ${heroPath} to /api/media`);
        // Article doesn't exist yet (created by submitArticle a few lines
        // below). Pass area/topic so the canonical filename includes them;
        // the hero's linkedArticle gets PATCHed by Web Manager after the
        // article is submitted (TODO if exposed; for now alt-derived slug
        // already includes the title, so the name is human-readable).
        heroId = await uploadHero(heroPath, heroAlt, { area, topic });
        log(`hero media id=${heroId}`);
      }
    } catch (e) {
      log(`imager failed (non-fatal): ${e.message}`);
    }
  }

  // 6. Web Manager: submit
  log("submit-article…");
  let article;
  try {
    article = await submitArticle({
      area, topic, areaId, topicId, personaId,
      copy, seo, heroId,
      sourceUrl: researchUrl,
      sourceHash,
    });
  } catch (e) {
    console.error(`[dispatch] submit failed: ${e.message}`);
    process.exit(4);
  }

  console.log(JSON.stringify({
    status: "pending_review",
    article_id: article.id,
    article_url: `${PAYLOAD_BASE_URL}/admin/collections/articles/${article.id}`,
    public_path: `/${area}/${topic}/${copy.slug}`,
    hash: sourceHash,
    word_count: copy.word_count,
    banned_phrases_found: copy.banned_phrases_found || [],
    copywriter: { title: copy.title, persona, words: copy.word_count },
    seo: seo ? { primary_keyword: seo.primary_keyword, meta_title: seo.meta_title } : null,
    imager: { hero_media_id: heroId, skipped: skipImager },
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error("[dispatch] FATAL:", e?.message || e);
  process.exit(1);
});
