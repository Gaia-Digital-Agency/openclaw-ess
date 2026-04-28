#!/usr/bin/env node
/**
 * Copywriter — regenerate-title
 *
 * Produces 5 alternative titles for an existing article. Used when a
 * draft's title doesn't sing — human picks the best one (or asks
 * Elliot to rewrite from a different angle).
 *
 * Input modes
 *   1. By article id (queries Payload):
 *        node regenerate-title.mjs --id=70
 *   2. JSON on stdin:
 *        echo '{"title":"...","sub_title":"...","body_markdown":"...",
 *               "area":"canggu","topic":"dine","persona":"maya"}' \
 *          | node regenerate-title.mjs
 *
 * Output (stdout JSON):
 *   {
 *     source_title: "...",
 *     alternatives: [
 *       { title: "...", angle: "..." },
 *       ...
 *     ]
 *   }
 *
 * Backend: Vertex Gemini 2.5 Flash with responseSchema, temperature 0.7.
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
const envP = "/opt/.openclaw-ess/credentials/.env.payload";
if (existsSync(envP)) {
  for (const line of readFileSync(envP, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || "gda-viceroy";
const LOCATION = process.env.GCP_VERTEX_LOCATION || "asia-southeast1";
const MODEL = process.env.GCP_VERTEX_MODEL || "gemini-2.5-flash";
const PAYLOAD_BASE_URL =
  process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";

async function fetchArticleById(id) {
  if (!process.env.PAYLOAD_AGENT_PASSWORD) {
    throw new Error("PAYLOAD_AGENT_PASSWORD env missing — needed for --id mode");
  }
  const login = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.PAYLOAD_AGENT_EMAIL,
      password: process.env.PAYLOAD_AGENT_PASSWORD,
    }),
  });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const t = (await login.json()).token;
  const res = await fetch(`${PAYLOAD_BASE_URL}/api/articles/${id}?depth=2`, {
    headers: { Authorization: `JWT ${t}` },
  });
  if (!res.ok) throw new Error(`article ${id} → ${res.status}`);
  const a = await res.json();
  // Lexical body → plain text approximation for prompt context.
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
    title: a.title,
    sub_title: a.subTitle,
    body_markdown: lexicalToText(a.body).slice(0, 4000),
    area: typeof a.area === "object" ? a.area?.slug : null,
    topic: typeof a.topic === "object" ? a.topic?.slug : null,
    persona: typeof a.persona === "object" ? a.persona?.slug : null,
  };
}

function buildPrompt({ title, sub_title, body_markdown, area, topic, persona }) {
  return [
    `You are an editor for Essential Bali. The current title for an article in ${area || "?"}/${topic || "?"} is:`,
    "",
    `> ${title}`,
    sub_title ? `> ${sub_title}` : "",
    "",
    `Body excerpt (first ~4000 chars):`,
    body_markdown.slice(0, 4000),
    "",
    `Persona voice: ${persona || "house"}.`,
    "",
    "Produce 5 alternative titles. For each, include a one-line ANGLE that explains how it pitches the article differently from the current title (e.g. 'lead with the queue', 'lead with the place', 'lead with the dish', 'numbered list', 'question hook').",
    "",
    "Hard rules:",
    "- Each title ≤ 60 characters (so it doesn't truncate in Google search results).",
    "- DO NOT use: delve, tapestry, hidden gem, bustling, in the realm of, navigate the landscape, unveil, embark on a journey, testament to, a myriad of, it goes without saying, game-changer.",
    "- Don't repeat the current title verbatim.",
    "- Mix tones — at least one numbered list, at least one question.",
    "",
    "Return STRICT JSON only.",
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
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1500,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            alternatives: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  angle: { type: "STRING" },
                },
                required: ["title", "angle"],
              },
            },
          },
          required: ["alternatives"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Vertex ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  const txt = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  if (!txt) throw new Error("Empty Vertex response");
  return JSON.parse(txt);
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
  let input;
  if (flags.id) {
    input = await fetchArticleById(flags.id);
  } else {
    input = await readStdin();
    if (!input) {
      console.error("missing input — pass --id=N or pipe JSON");
      process.exit(1);
    }
  }
  if (!input.title) {
    console.error("input missing title");
    process.exit(1);
  }
  // Cap each candidate at 60 chars defensively.
  const out = await callGemini(buildPrompt(input));
  const alts = (out.alternatives || []).map((x) => ({
    title: String(x.title || "").slice(0, 60),
    angle: String(x.angle || ""),
  })).slice(0, 5);

  console.log(JSON.stringify({
    source_title: input.title,
    area: input.area || null,
    topic: input.topic || null,
    persona: input.persona || null,
    alternatives: alts,
  }, null, 2));
}

main().catch((e) => {
  console.error("[regenerate-title] ERR:", e?.message || e);
  process.exit(1);
});
