#!/usr/bin/env node
/**
 * Copywriter — draft-article.
 *
 * Usage:
 *   echo '{"area":"canggu","topic":"dine","brief":"...","persona":"maya"}' \
 *     | node draft-article.mjs
 *
 *   node draft-article.mjs --area=canggu --topic=dine \
 *     --persona=maya --brief="best warungs in Canggu"
 *
 * Input (JSON on stdin OR --flags):
 *   area:        slug (canggu | kuta | ubud | jimbaran | denpasar |
 *                kintamani | singaraja | nusa-penida)
 *   topic:       slug (events | news | featured | dine | health-wellness |
 *                nightlife | activities | people-culture)
 *   persona:     slug (maya | komang | putu | sari) — picks voice
 *   brief:       short prose seed for the article
 *   research?:   array of {url, title, paragraphs[]} from crawler
 *   target_words?: target word count (default 700; News=300; Events=400)
 *
 * Output (stdout JSON):
 *   { title, slug, sub_title, body_markdown, meta_title, meta_description,
 *     persona, area, topic, word_count, sources, banned_phrases_found }
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS service-account → Vertex AI Gemini.
 * Reads /opt/.openclaw-ess/credentials/.env.vertex if present.
 *
 * Quality gates the Copywriter applies before returning:
 *   - banned_phrases scan (delve, tapestry, hidden gem, …)
 *   - word_count >= target_words * 0.8
 *   - meta_title <= 60 chars
 *   - meta_description <= 160 chars
 */
import { GoogleAuth } from "google-auth-library";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env loader (.env.vertex optional) ──────────────────────────────
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

const PERSONAS = {
  maya: { name: "Maya", style: "Local foodie. Warm, sensory. Names ingredients specifically. Strong opinions politely held. First-person occasionally." },
  komang: { name: "Komang", style: "Activities and wellness guide. Practical, calm, safety-aware. Names trails, dive sites, instructors precisely." },
  putu: { name: "Putu", style: "Cultural insider. Anthropology background. Italicises Balinese terms on first use. Avoids exoticisation." },
  sari: { name: "Sari", style: "Nightlife and events reporter. Energetic, on-the-pulse. Short paragraphs. Names DJs, venues, dates precisely." },
};

const BANNED = /\b(delve|tapestry|hidden gem|bustling|in the realm of|navigate the landscape|unveil|embark on a journey|testament to|a myriad of|it goes without saying|game-changer)\b/gi;

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

function buildPrompt({ area, topic, persona, brief, research, target_words }) {
  const p = PERSONAS[persona] || PERSONAS.maya;
  const target = target_words || (topic === "news" ? 300 : topic === "events" ? 400 : 700);
  const research_block = (research || [])
    .slice(0, 5)
    .map(
      (r, i) =>
        `Source ${i + 1}: ${r.title || r.url}\n${(r.paragraphs || []).slice(0, 5).join("\n")}\n`,
    )
    .join("\n");

  return [
    "You are a writer for Essential Bali, a Bali lifestyle publication.",
    `Voice: ${p.name} — ${p.style}`,
    `Area: ${area}.  Topic: ${topic}.  Target word count: ${target}.`,
    "",
    "Hard rules:",
    "- DO NOT use any of: delve, tapestry, hidden gem, bustling, in the realm of, " +
      "navigate the landscape, unveil, embark on a journey, testament to, a myriad of, " +
      "it goes without saying, game-changer.",
    "- Italicise Balinese / Indonesian words on first use.",
    "- Short paragraphs. Active voice. Concrete sensory detail.",
    "- Never invent place names, prices, or dates. If a research source has them, cite. Otherwise say it generically.",
    "- Be honest — if a place has trade-offs, name them.",
    "",
    `Brief: ${brief}`,
    "",
    research_block ? `Research (rewrite, never republish):\n${research_block}` : "",
    "",
    "Return STRICT JSON only — no preamble, no code fences:",
    "{",
    '  "title":            string (~60 chars max for SEO),',
    '  "sub_title":        string (one sentence, ~120 chars),',
    '  "body_markdown":    string (markdown body, around target word count),',
    '  "meta_title":       string (≤ 60 chars),',
    '  "meta_description": string (≤ 160 chars),',
    '  "keywords":         string[] (3-7 search keywords),',
    '  "sources":          {url:string, site:string}[] (cite every research source used)',
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callGemini(prompt, temperature = 0.5) {
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
      generationConfig: {
        temperature,
        maxOutputTokens: 8000,
        responseMimeType: "application/json",
        // Schema forces Vertex to return well-formed JSON with these exact
        // fields. Eliminates the unterminated-string failures we saw when
        // long body_markdown strings contained unescaped quotes.
        responseSchema: {
          type: "OBJECT",
          properties: {
            title:            { type: "STRING" },
            sub_title:        { type: "STRING" },
            body_markdown:    { type: "STRING" },
            meta_title:       { type: "STRING" },
            meta_description: { type: "STRING" },
            keywords:         { type: "ARRAY", items: { type: "STRING" } },
            sources: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  url:  { type: "STRING" },
                  site: { type: "STRING" },
                },
              },
            },
          },
          required: ["title", "body_markdown", "meta_title", "meta_description"],
        },
      },
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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stdinJson = await readStdinIfPresent();
  const input = { ...flags, ...(stdinJson || {}) };

  if (!input.area || !input.topic || !input.persona || !input.brief) {
    console.error("missing required: area, topic, persona, brief");
    process.exit(1);
  }

  const prompt = buildPrompt({
    area: input.area,
    topic: input.topic,
    persona: input.persona,
    brief: input.brief,
    research: input.research || [],
    target_words: input.target_words ? Number(input.target_words) : null,
  });

  // Vertex/Gemini intermittently emits unterminated JSON strings even with
  // responseSchema set — typically a malformed Unicode escape inside
  // body_markdown that breaks at position ~600. Retry up to 3x; the next
  // attempt usually returns clean JSON because temperature=0.5 sampling
  // takes a different path. Saw this fail the first F7 user dispatch
  // ("dispatch failed: copywriter exit 1: Unterminated string in JSON").
  // Repair an "Unterminated string in JSON at position N" failure by
  // truncating to N, closing the open string, and closing any open
  // brackets. Produces a valid (if shorter) JSON object — body_markdown
  // gets clipped mid-sentence, which the editor can fix in admin.
  // Better than failing the dispatch outright.
  function tryRepair(raw) {
    try {
      JSON.parse(raw);
      return null;
    } catch (e) {
      const msg = e?.message || "";
      const m = msg.match(/position\s+(\d+)/i);
      if (!m) return null;
      const pos = Number(m[1]);
      if (!Number.isFinite(pos) || pos < 50) return null;
      let truncated = raw.slice(0, pos);
      // Drop a trailing partial escape so we don't leave \u00 hanging.
      truncated = truncated.replace(/\\u?[0-9a-fA-F]{0,3}$/, "");
      truncated = truncated.replace(/\\$/, "");
      // Close the open string with a quote.
      let candidate = truncated + '"';
      // Count unclosed { and [ — assume they need closing in reverse.
      const opens = [];
      let inStr = false;
      let esc = false;
      for (let i = 0; i < candidate.length; i++) {
        const c = candidate[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") opens.push("}");
        else if (c === "[") opens.push("]");
        else if (c === "}" || c === "]") opens.pop();
      }
      while (opens.length) candidate += opens.pop();
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }

  // Vary temperature across attempts so a deterministically-bad sampling
  // path on attempt 1 doesn't repeat on attempt 2. 0.5 is the default
  // (matches what we used pre-retry); 0.2 is more conservative; 0.8 is
  // more exploratory. At least one of the three usually clears.
  const TEMPS = [0.5, 0.2, 0.8];
  let parsed;
  for (let attempt = 1; attempt <= TEMPS.length; attempt++) {
    const temp = TEMPS[attempt - 1];
    let raw;
    try {
      raw = await callGemini(prompt, temp);
    } catch (e) {
      console.error(
        `[copywriter] attempt ${attempt}/${TEMPS.length} temp=${temp} vertex error: ${e?.message || e}`,
      );
      if (attempt < TEMPS.length) continue;
      throw e;
    }
    // Direct parse.
    try {
      parsed = JSON.parse(raw);
      if (attempt > 1) console.error(`[copywriter] OK on attempt ${attempt} temp=${temp}`);
      break;
    } catch {}
    // Fence-strip parse.
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
      if (attempt > 1) console.error(`[copywriter] OK on attempt ${attempt} temp=${temp} (fence-strip)`);
      break;
    } catch {}
    // JSON-repair parse — only on the LAST attempt; we'd rather get a
    // fresh roll than ship a half-truncated body if we still have retries.
    if (attempt === TEMPS.length) {
      const repaired = tryRepair(raw);
      if (repaired) {
        parsed = repaired;
        console.error(
          `[copywriter] OK on attempt ${attempt} temp=${temp} via JSON-repair (body truncated)`,
        );
        break;
      }
    }
    // Bare failure — log and either retry or give up.
    let parseErr;
    try { JSON.parse(raw); } catch (e) { parseErr = e; }
    console.error(
      `[copywriter] attempt ${attempt}/${TEMPS.length} temp=${temp} JSON.parse failed: ${(parseErr?.message || parseErr || "").toString().slice(0, 160)}; raw[0..200]=${raw.slice(0, 200).replace(/\n/g, " ")}`,
    );
    if (attempt === TEMPS.length) {
      throw new Error(
        `copywriter: ${TEMPS.length}x JSON.parse failures (incl. repair fallback), last: ${parseErr?.message || parseErr}`,
      );
    }
  }

  const body = parsed.body_markdown || "";
  const word_count = body.split(/\s+/).filter(Boolean).length;
  const banned_hits = [...body.matchAll(BANNED)].map((m) => m[0].toLowerCase());

  const out = {
    title: parsed.title,
    slug: slugify(parsed.title || ""),
    sub_title: parsed.sub_title || "",
    body_markdown: body,
    meta_title: (parsed.meta_title || parsed.title || "").slice(0, 60),
    meta_description: (parsed.meta_description || "").slice(0, 160),
    keywords: parsed.keywords || [],
    persona: input.persona,
    area: input.area,
    topic: input.topic,
    word_count,
    sources: parsed.sources || [],
    banned_phrases_found: [...new Set(banned_hits)],
  };

  if (out.banned_phrases_found.length) {
    console.error(
      `⚠ banned phrases detected (${out.banned_phrases_found.join(", ")}) — Elliot should reject and re-prompt`,
    );
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("ERR:", e?.message || e);
  process.exit(1);
});
