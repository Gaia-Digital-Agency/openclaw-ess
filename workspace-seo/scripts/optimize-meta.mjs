#!/usr/bin/env node
/**
 * SEO — optimize-meta + keyword-research.
 *
 * Usage:
 *   echo '{"area":"canggu","topic":"dine","title":"Best warungs in Canggu","body_markdown":"..."}' \
 *     | node optimize-meta.mjs
 *
 *   node optimize-meta.mjs --area=canggu --topic=dine \
 *     --title="Best warungs in Canggu" --body_markdown="..."
 *
 * Modes:
 *   default — optimise meta_title, meta_description, suggest internal-link
 *             anchors, return JSON-LD Article schema.
 *   --keywords-only — skip meta, just return primary + 5 long-tail keywords
 *             with rough monthly-volume tiers (low/med/high).
 *
 * Input fields:
 *   area, topic           required (slugs)
 *   title                 required for meta optimisation
 *   body_markdown?        helps the model pick the right primary keyword
 *   sub_title?            optional context
 *   existing_meta_title?  if present, model is asked to improve it
 *   sources?              array of {url, site} that informed the article
 *
 * Output (stdout JSON):
 *   {
 *     primary_keyword, long_tail_keywords[],
 *     meta_title, meta_description,
 *     internal_link_anchors[],
 *     jsonld: { "@context", "@type": "Article", ... }
 *   }
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS service-account → Vertex AI Gemini.
 */
import { GoogleAuth } from "google-auth-library";
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

const envPath = "/opt/.openclaw-ess/credentials/.env.vertex";
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || "gda-viceroy";
const LOCATION = process.env.GCP_VERTEX_LOCATION || "asia-southeast1";
const MODEL = process.env.GCP_VERTEX_MODEL || "gemini-2.5-flash";
const SITE = process.env.SITE_BASE_URL || "https://essentialbali.gaiada.online";

function buildPrompt(input, keywordsOnly) {
  const { area, topic, title, body_markdown, sub_title, existing_meta_title, sources } = input;
  const bodyExcerpt = (body_markdown || "").slice(0, 4000);
  const sourceList = (sources || [])
    .slice(0, 5)
    .map((s) => `- ${s.site || s.url}`)
    .join("\n");

  if (keywordsOnly) {
    return [
      "You are an SEO specialist for Essential Bali (a Bali lifestyle publication).",
      `Area: ${area}.  Topic: ${topic}.  Article title: ${title || "(untitled)"}.`,
      bodyExcerpt ? `Article body excerpt:\n${bodyExcerpt}\n` : "",
      "",
      "Return STRICT JSON only — no preamble, no code fences:",
      "{",
      '  "primary_keyword":   string  (the main search target),',
      '  "long_tail_keywords": string[]  (5 long-tail variants Balinese travellers actually type),',
      '  "intent":            "informational" | "commercial" | "transactional" | "navigational",',
      '  "volume_tier":       "low" | "medium" | "high"  (rough estimate)',
      "}",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "You are an SEO specialist for Essential Bali — a Bali lifestyle publication.",
    `Area: ${area}.  Topic: ${topic}.`,
    `Title: ${title}`,
    sub_title ? `Sub-title: ${sub_title}` : "",
    existing_meta_title ? `Existing meta_title: ${existing_meta_title}` : "",
    bodyExcerpt ? `Article body excerpt:\n${bodyExcerpt}\n` : "",
    sourceList ? `Sources cited:\n${sourceList}` : "",
    "",
    "Hard rules:",
    "- meta_title MUST be ≤ 60 characters, include primary keyword, read as a real headline.",
    "- meta_description MUST be ≤ 160 characters, include primary keyword once, end with a soft CTA.",
    "- internal_link_anchors are 3–5 short noun phrases (2–4 words each) suitable as anchor text",
    "  to nearby articles. Do NOT include URLs.",
    "- jsonld: emit Schema.org Article — fields: headline, description, articleSection (the topic),",
    `  about (the area), publisher.name "Essential Bali", inLanguage "en-ID".`,
    "- DO NOT use: delve, tapestry, hidden gem, bustling, in the realm of, navigate the landscape,",
    "  unveil, embark on a journey, testament to, a myriad of, it goes without saying, game-changer.",
    "",
    "Return STRICT JSON only — no preamble, no code fences:",
    "{",
    '  "primary_keyword":      string,',
    '  "long_tail_keywords":   string[]   (3-5),',
    '  "meta_title":           string  (≤ 60 chars),',
    '  "meta_description":     string  (≤ 160 chars),',
    '  "internal_link_anchors": string[] (3-5),',
    '  "jsonld":               object  (Schema.org Article)',
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callGemini(prompt) {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp.token;
  if (!token) throw new Error("Failed to obtain GCP access token");

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2000, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vertex AI failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const txt = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  if (!txt) throw new Error("Empty answer from Vertex");
  return txt;
}

function parseArgs(argv) {
  const out = { keywordsOnly: false };
  for (const a of argv) {
    if (a === "--keywords-only") out.keywordsOnly = true;
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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stdinJson = await readStdinIfPresent();
  const input = { ...flags, ...(stdinJson || {}) };
  const keywordsOnly = !!flags.keywordsOnly;

  if (!input.area || !input.topic) {
    console.error("missing required: area, topic");
    process.exit(1);
  }
  if (!keywordsOnly && !input.title) {
    console.error("missing required: title (or pass --keywords-only)");
    process.exit(1);
  }

  const prompt = buildPrompt(input, keywordsOnly);
  const raw = await callGemini(prompt);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  }

  // Hard caps + post-checks (defence in depth).
  if (parsed.meta_title) parsed.meta_title = String(parsed.meta_title).slice(0, 60);
  if (parsed.meta_description) parsed.meta_description = String(parsed.meta_description).slice(0, 160);

  // Decorate jsonld with canonical URL hint when slug + area + topic are derivable.
  if (parsed.jsonld && typeof parsed.jsonld === "object" && input.slug) {
    parsed.jsonld.url = `${SITE}/${input.area}/${input.topic}/${input.slug}`;
  }

  console.log(JSON.stringify({
    area: input.area,
    topic: input.topic,
    title: input.title || null,
    ...parsed,
  }, null, 2));
}

main().catch((e) => {
  console.error("ERR:", e?.message || e);
  process.exit(1);
});
