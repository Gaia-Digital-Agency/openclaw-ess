#!/usr/bin/env node
/**
 * Elliot — content-area-check
 *
 * Semantic gate for area + topic anchoring. Given an article body and
 * the declared (area, topic), asks Vertex Gemini to classify the body
 * and predict which (area, topic) it actually reads as. If the
 * prediction does not match the declaration, the gate fails.
 *
 * Use: invoked by review-gate.mjs after the structural checks pass.
 * Closes the gap that the BRIEF and the Copywriter prompt only
 * SUGGEST area + topic — they can't enforce the LLM didn't drift.
 *
 *
 * Two input modes:
 *   1. Pipe JSON on stdin:
 *        echo '{"area":"canggu","topic":"dine","body_markdown":"..."}' \
 *          | node content-area-check.mjs
 *   2. By article id (queries Payload):
 *        node content-area-check.mjs --id=70
 *
 * Output (stdout JSON):
 *   {
 *     ok: bool,
 *     declared:  { area, topic },
 *     predicted: { area, topic },
 *     area_match: bool,
 *     topic_match: bool,
 *     confidence: 0..1,
 *     why: "short justification from the model"
 *   }
 *
 * Exit codes:
 *   0  match
 *   2  mismatch (caller should reject)
 *   3  usage / network / Vertex error
 *
 * Required env (or .env.vertex):
 *   GCP_VERTEX_PROJECT_ID, GCP_VERTEX_LOCATION, GCP_VERTEX_MODEL,
 *   GOOGLE_APPLICATION_CREDENTIALS
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

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_VERTEX_LOCATION || "us-central1";
const MODEL = process.env.GCP_VERTEX_MODEL || "gemini-2.5-flash";
const PAYLOAD_BASE_URL =
  process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";

const AREAS = [
  "canggu", "kuta", "ubud", "jimbaran",
  "denpasar", "kintamani", "singaraja", "nusa-penida",
];
const TOPICS = [
  "events", "news", "featured", "dine",
  "health-wellness", "nightlife", "activities", "people-culture",
];

function buildPrompt({ body, declared_area, declared_topic }) {
  return [
    "You are an editorial fact-checker for Essential Bali, a guide site",
    "that organises content into 8 fixed AREAS and 8 fixed TOPICS.",
    "",
    "AREAS (only these): " + AREAS.join(", "),
    "TOPICS (only these): " + TOPICS.join(", "),
    "",
    "Given the article body below, classify which AREA and which TOPIC",
    "it actually reads as. Answer based on what the body talks about,",
    "not what it claims to be tagged as. If the body mentions multiple",
    "areas or topics, pick the dominant one (the one the body is most",
    "centrally about).",
    "",
    "Be strict:",
    "  - If the body mostly talks about restaurants, pick area where",
    "    the restaurants are. Topic = dine.",
    "  - If the body talks about a yoga retreat in Ubud, area=ubud,",
    "    topic=health-wellness.",
    "  - If the body is genuinely cross-area or cross-topic such that",
    "    neither dominates, set confidence below 0.5 and explain.",
    "",
    "Return JSON exactly matching the schema. Confidence is 0..1.",
    "'why' is one short sentence (≤ 200 chars) explaining the call.",
    "",
    "DECLARED area: " + declared_area,
    "DECLARED topic: " + declared_topic,
    "",
    "BODY:",
    "---",
    String(body || "").slice(0, 8000),
    "---",
  ].join("\n");
}

async function callGemini(prompt) {
  if (!PROJECT_ID) throw new Error("GCP_VERTEX_PROJECT_ID not set");
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
        temperature: 0.0,
        maxOutputTokens: 800,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            predicted_area: { type: "STRING", enum: AREAS },
            predicted_topic: { type: "STRING", enum: TOPICS },
            confidence: { type: "NUMBER" },
            why: { type: "STRING" },
          },
          required: ["predicted_area", "predicted_topic", "confidence", "why"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Vertex ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  const txt = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  if (!txt) throw new Error("Empty Vertex response");
  try {
    return JSON.parse(txt);
  } catch (e) {
    const cleaned = txt.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return JSON.parse(cleaned);
  }
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

async function fetchArticle(id) {
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
    body: lexicalToText(a.body),
    area: typeof a.area === "object" ? a.area?.slug : null,
    topic: typeof a.topic === "object" ? a.topic?.slug : null,
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  let s = "";
  for await (const c of process.stdin) s += c;
  return s.trim() ? JSON.parse(s) : null;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1].replace(/-/g, "_")] = m[2];
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  let input;
  if (flags.id) {
    input = await fetchArticle(flags.id);
    input.body_markdown = input.body;
    input.declared_area = input.area;
    input.declared_topic = input.topic;
  } else {
    input = await readStdin();
    if (!input) {
      console.error("missing input — pass --id=N or pipe JSON {area, topic, body_markdown}");
      process.exit(3);
    }
    input.declared_area = input.declared_area || input.area;
    input.declared_topic = input.declared_topic || input.topic;
    input.body_markdown = input.body_markdown || input.body;
  }
  if (!input.declared_area || !input.declared_topic || !input.body_markdown) {
    console.error("input must include {area|declared_area, topic|declared_topic, body_markdown|body}");
    process.exit(3);
  }
  if (!AREAS.includes(input.declared_area)) {
    console.error(`unknown declared area: ${input.declared_area}. Allowed: ${AREAS.join(", ")}`);
    process.exit(3);
  }
  if (!TOPICS.includes(input.declared_topic)) {
    console.error(`unknown declared topic: ${input.declared_topic}. Allowed: ${TOPICS.join(", ")}`);
    process.exit(3);
  }

  const prompt = buildPrompt({
    body: input.body_markdown,
    declared_area: input.declared_area,
    declared_topic: input.declared_topic,
  });
  const ai = await callGemini(prompt);
  const area_match = ai.predicted_area === input.declared_area;
  const topic_match = ai.predicted_topic === input.declared_topic;
  const ok = area_match && topic_match;

  const out = {
    ok,
    declared: { area: input.declared_area, topic: input.declared_topic },
    predicted: { area: ai.predicted_area, topic: ai.predicted_topic },
    area_match,
    topic_match,
    confidence: typeof ai.confidence === "number" ? ai.confidence : null,
    why: String(ai.why || "").slice(0, 200),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("[content-area-check] ERR:", e?.message || e);
  process.exit(3);
});
