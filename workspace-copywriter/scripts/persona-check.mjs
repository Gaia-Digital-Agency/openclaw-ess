#!/usr/bin/env node
/**
 * Copywriter — persona-check
 *
 * Score how well a piece of text matches the intended persona's voice.
 * Returns a 0–10 score, a list of issues (specific lines that miss the
 * voice) and a list of suggestions (concrete phrasings to try).
 *
 * Two input modes
 *   1. By article id (uses the article's stored persona, or override
 *      with --persona=...):
 *        node persona-check.mjs --id=70
 *        node persona-check.mjs --id=70 --persona=maya
 *   2. JSON on stdin:
 *        echo '{"text":"...","persona":"maya"}' | node persona-check.mjs
 *
 * Output (stdout JSON):
 *   {
 *     persona: "maya",
 *     score: 7,
 *     summary: "Hits the warmth and ingredient-naming, misses the first-person
 *               voice. Body skews to listicle when persona prefers narrative.",
 *     issues: [
 *       { line_excerpt: "...", problem: "..." },
 *       ...
 *     ],
 *     suggestions: [
 *       "Open with a sensory detail in first person, e.g. ...",
 *       ...
 *     ]
 *   }
 *
 * Backend: Vertex Gemini 2.5 Flash with responseSchema, low temperature
 * (0.2) for stable scoring.
 */
import { GoogleAuth } from "google-auth-library";
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

for (const envPath of [
  "/opt/.openclaw-ess/credentials/.env.vertex",
  "/opt/.openclaw-ess/credentials/.env.payload",
]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || "gda-viceroy";
const LOCATION = process.env.GCP_VERTEX_LOCATION || "asia-southeast1";
const MODEL = process.env.GCP_VERTEX_MODEL || "gemini-2.5-flash";
const PAYLOAD_BASE_URL =
  process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";

const PERSONAS = {
  maya: {
    name: "Maya — local foodie",
    voice: [
      "Warm, sensory, present-tense. Names ingredients specifically (sambal matah, kemangi, gula merah).",
      "First-person occasionally — 'I always go for the ayam betutu' — but not in every paragraph.",
      "Strong opinions politely held. Not afraid to say a place is overrated.",
      "Notes who's eating at the table next to her. The line out the door. The open-air kitchen.",
      "Avoids: capital-W Wellness language, generic 'Bali vibes', listicle-by-numbers structure.",
    ],
  },
  komang: {
    name: "Komang — activities + wellness guide",
    voice: [
      "Practical, calm, safety-aware. Names trails, dive sites, surf breaks, instructors precisely.",
      "Doesn't gloss over difficulty. 'This climb is class 4 in two sections.' 'Watch the rip on the south side.'",
      "Uses imperial AND metric. 'A 60-minute drive — about 35 km on the bypass.'",
      "Explains why a thing is worth doing without overselling it.",
      "Avoids: spa-aspirational voice, wellness-pamphlet jargon, hype.",
    ],
  },
  putu: {
    name: "Putu — cultural insider",
    voice: [
      "Anthropology background. Italicises Balinese / Indonesian terms on first use, defines them in-line.",
      "Avoids exoticisation. Treats traditional practice with the seriousness it has for practitioners.",
      "Will explain Banjar, canang sari, ngaben without making them mystical.",
      "Cites sources — names of pemangku, gurus, banjar leaders — when they consent to being named.",
      "Avoids: 'mystical Bali', 'Eat Pray Love' tropes, treating ritual as content.",
    ],
  },
  sari: {
    name: "Sari — nightlife + events reporter",
    voice: [
      "Energetic, on-the-pulse, short paragraphs. Names DJs, venues, dates precisely.",
      "Treats nightlife as journalism — who showed up, what played, when it ended.",
      "Specific: 'BAKED played a 2-hour disco set, peaked at 1:30am, La Brisa was packed but not crushed.'",
      "Knows the difference between Friday-at-La-Brisa and Sunday-at-Single-Fin.",
      "Avoids: 'epic vibes', 'must-experience', generic list of nightclubs.",
    ],
  },
};

function buildPrompt(text, personaSlug) {
  const p = PERSONAS[personaSlug];
  if (!p) {
    throw new Error(`unknown persona: ${personaSlug} (must be one of: ${Object.keys(PERSONAS).join(", ")})`);
  }
  return [
    "You are an editor at Essential Bali. Score how well the following text matches the intended persona's voice.",
    "",
    `Persona: ${p.name}`,
    "Voice guidelines:",
    ...p.voice.map((v) => `- ${v}`),
    "",
    "Text under review:",
    "<<<TEXT>>>",
    String(text).slice(0, 8000),
    "<<<END>>>",
    "",
    "Scoring:",
    "  9–10  unmistakably this persona; would publish as is.",
    "  7–8   broadly the persona, with one or two specific drift moments.",
    "  4–6   half there — recognisable persona elements but mostly generic.",
    "  0–3   not the persona; reads as house style or AI default.",
    "",
    "Hard length limits (the response must fit in our token budget):",
    "  - summary: ≤ 200 characters total. One concise sentence.",
    "  - each issue: ≤ 180 chars. Format: \"<excerpt 60-100 chars> — <what's wrong>\"",
    "  - each suggestion: ≤ 180 chars.",
    "  - 3–5 issues, 3–5 suggestions. Don't pad.",
    "",
    "ALL string values must use double quotes only. ANY internal double quote",
    "inside a value must be escaped as \\\". NEVER include a literal newline",
    "inside a string value.",
  ].join("\n");
}

async function callGemini(prompt) {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const c = await auth.getClient();
  const tokenResp = await c.getAccessToken();
  const token = tokenResp.token;
  if (!token) throw new Error("Failed to obtain GCP access token");

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        // Earlier 2000 was getting truncated mid-summary. 4000 gives
        // ample headroom for the schema-bound output.
        maxOutputTokens: 4000,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            score: { type: "INTEGER" },
            summary: { type: "STRING" },
            // Flat string arrays — Vertex is far more reliable on these
            // than nested OBJECT items.
            issues: { type: "ARRAY", items: { type: "STRING" } },
            suggestions: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["score", "summary"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Vertex ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  const txt = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  if (!txt) throw new Error("Empty Vertex response");
  // Defensive parse — Vertex sometimes emits raw quotes inside string
  // values, breaking strict JSON.parse. Try the strict path first, then
  // fall back to a tolerant path that strips code fences + escapes
  // unescaped inner quotes inside the most common offending field.
  try {
    return JSON.parse(txt);
  } catch (e1) {
    let cleaned = txt.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      // Aggressive repair — the most common Vertex glitch is literal
      // newlines / unescaped inner quotes inside string values. Walk
      // the text character-by-character: when inside a string, escape
      // any literal control characters (newline, carriage return, tab)
      // and bare quotes that aren't followed by JSON-valid syntax.
      const repaired = repairJsonStrings(cleaned);
      try {
        return JSON.parse(repaired);
      } catch (e3) {
        console.error("[persona-check] Vertex returned unparseable JSON, salvaging:", e3.message);
        console.error("[persona-check] raw (first 600):", txt.slice(0, 600));
        return {
          score: 5,
          summary: "Vertex returned unparseable JSON. Re-run if needed.",
          issues: [],
          suggestions: [],
          _raw: txt.slice(0, 500),
        };
      }
    }
  }
}

// Walk the JSON and escape control characters inside string values.
// Handles the common Vertex glitch where the model emits literal
// newlines or quote characters within strings.
function repairJsonStrings(s) {
  let out = "";
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      // Detect "unescaped quote inside a string" — heuristic: if we're
      // inside a string AND the next non-whitespace char isn't , } ] or :
      // then this is probably a stray quote that should be escaped.
      if (inStr) {
        const after = s.slice(i + 1).match(/^\s*([,}\]:])/);
        if (!after) {
          out += '\\"';
          continue;
        }
      }
      out += c;
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
    }
    out += c;
  }
  return out;
}

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
  return {
    text: lexicalToText(a.body),
    persona: typeof a.persona === "object" ? a.persona?.slug : null,
    article_id: a.id,
    title: a.title,
  };
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
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
  let text, persona, articleId, title;
  if (flags.id) {
    const a = await fetchArticleById(flags.id);
    text = a.text;
    articleId = a.article_id;
    title = a.title;
    persona = flags.persona || a.persona;
  } else {
    const j = await readStdin();
    if (!j || !j.text || !j.persona) {
      console.error("usage: --id=N (with optional --persona=X) OR pipe JSON {text, persona}");
      process.exit(1);
    }
    text = j.text;
    persona = j.persona;
  }
  if (!persona) {
    console.error("persona missing — pass --persona=maya/komang/putu/sari");
    process.exit(1);
  }
  if (!PERSONAS[persona]) {
    console.error(`unknown persona ${persona}`);
    process.exit(1);
  }

  const out = await callGemini(buildPrompt(text, persona));
  out.score = Math.max(0, Math.min(10, Number(out.score || 0)));

  // issues / suggestions are flat string arrays now; cap at 6 / 5 to stay tight.
  const issues = Array.isArray(out.issues) ? out.issues.slice(0, 6) : [];
  const suggestions = Array.isArray(out.suggestions) ? out.suggestions.slice(0, 5) : [];

  console.log(JSON.stringify({
    article_id: articleId || null,
    title: title || null,
    persona,
    persona_label: PERSONAS[persona].name,
    score: out.score,
    verdict:
      out.score >= 9 ? "publish-ready" :
      out.score >= 7 ? "minor-edits" :
      out.score >= 4 ? "needs-rewrite" :
      "not the persona",
    summary: out.summary || "",
    issues,
    suggestions,
  }, null, 2));
}

main().catch((e) => {
  console.error("[persona-check] ERR:", e?.message || e);
  process.exit(1);
});
