#!/usr/bin/env node
/**
 * Crawler — gap-report
 *
 * For one (area, topic) cell, compare what the 4 benchmark sites
 * cover vs what we have published. Emits the missing themes — angles
 * benchmarks have written about that we haven't.
 *
 * Usage
 *   node gap-report.mjs --area=canggu --topic=dine
 *   node gap-report.mjs --area=ubud   --topic=health-wellness --limit=10
 *
 * Output (stdout JSON):
 *   {
 *     area, topic, generated_at,
 *     our_count: N,             // our published article count for this cell
 *     benchmark_count: M,       // benchmark candidate articles found
 *     missing_themes: [
 *       { theme, example_titles: [...], priority: "high"|"medium"|"low" },
 *       ...
 *     ],
 *     overlap_themes: [...],    // we ALREADY cover
 *   }
 *
 * How it works
 *   1. Run trend-scan internally for the cell → list of benchmark titles.
 *   2. Query Payload for our published article titles in the cell.
 *   3. Send both lists to Vertex Gemini with a structured-output prompt:
 *      "What themes do benchmarks cover that we don't?"
 *   4. Gemini returns missing_themes + overlap_themes; we cap and dedupe.
 *
 * Backend: Vertex Gemini 2.5 Flash with responseSchema (flat string arrays
 * for reliability — same lesson learned from persona-check).
 */
import { spawn } from "node:child_process";
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

const TREND_SCAN = "/opt/.openclaw-ess/workspace-crawler/scripts/trend-scan.mjs";

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

async function fetchOurTitles(area, topic) {
  const t = await login();
  // Look up area + topic IDs first.
  const a = await fetch(`${PAYLOAD_BASE_URL}/api/areas?where[slug][equals]=${area}&limit=1&depth=0`, {
    headers: { Authorization: `JWT ${t}` },
  });
  const top = await fetch(`${PAYLOAD_BASE_URL}/api/topics?where[slug][equals]=${topic}&limit=1&depth=0`, {
    headers: { Authorization: `JWT ${t}` },
  });
  const aId = (await a.json()).docs?.[0]?.id;
  const tId = (await top.json()).docs?.[0]?.id;
  if (!aId || !tId) return [];
  const r = await fetch(
    `${PAYLOAD_BASE_URL}/api/articles?where[area][equals]=${aId}&where[topic][equals]=${tId}&where[status][in]=published,approved,pending_review&limit=100&depth=0`,
    { headers: { Authorization: `JWT ${t}` } },
  );
  const d = await r.json();
  return (d.docs || []).map((x) => x.title).filter(Boolean);
}

async function runTrendScan(area, topic, limit) {
  return new Promise((resolveP, rejectP) => {
    const args = [TREND_SCAN, `--area=${area}`, `--topic=${topic}`, `--limit=${limit}`];
    const proc = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`trend-scan exit ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try { resolveP(JSON.parse(stdout)); }
      catch (e) { rejectP(new Error(`trend-scan bad JSON: ${e.message}`)); }
    });
  });
}

function buildPrompt({ area, topic, ourTitles, benchmarkTitles }) {
  return [
    `You are an editor at Essential Bali (a Bali lifestyle publication). We are auditing topical coverage gaps for the cell:`,
    `  area = ${area}`,
    `  topic = ${topic}`,
    "",
    `Our currently published titles in this cell (${ourTitles.length}):`,
    ourTitles.length === 0 ? "(none yet — every theme is a gap)" : ourTitles.map((t) => `- ${t}`).join("\n"),
    "",
    `Benchmark titles from competing Bali publications for the same area + topic (${benchmarkTitles.length}):`,
    benchmarkTitles.map((t) => `- ${t}`).join("\n") || "(none found)",
    "",
    "Your job: find THEMES (not individual articles) that benchmarks cover but we don't.",
    "Themes are like 'sunset bars on the beach', 'late-night warungs', 'expat-run vegan cafes', 'hidden temples open to visitors'.",
    "They are NOT specific titles or place names.",
    "",
    "Output format — flat string arrays only.",
    "missing_themes: 5–10 strings, each in the EXACT shape:",
    "  \"<theme up to 60 chars> | <priority high|medium|low> | <one real example title up to 100 chars>\"",
    "  (use the literal pipe character `|` as separator — no other delimiters)",
    "Order most relevant first.",
    "",
    "overlap_themes: 3–5 short strings (≤ 80 chars each) — themes both we and benchmarks cover.",
    "",
    "Priority rule: 3+ benchmark articles back the theme = high; 2 = medium; 1 = low.",
    "",
    "NO line breaks inside any string. Escape any internal double quotes as \\\".",
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
        temperature: 0.3,
        // Bumped — the nested missing_themes array kept truncating
        // mid-string at 4k. 8k gives ample headroom.
        maxOutputTokens: 8000,
        responseMimeType: "application/json",
        // Flat schema — `missing_themes` is now an array of strings
        // each in the form "<theme> | <priority> | <one example title>".
        // We split client-side. Lesson learned from persona-check —
        // Vertex is far more reliable on flat string arrays than nested
        // OBJECT items.
        responseSchema: {
          type: "OBJECT",
          properties: {
            missing_themes: { type: "ARRAY", items: { type: "STRING" } },
            overlap_themes: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["missing_themes"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Vertex ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  const txt = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  if (!txt) throw new Error("Empty Vertex response");
  try {
    return JSON.parse(txt);
  } catch (e) {
    // Defensive — same approach as persona-check.
    const cleaned = txt.replace(/^```(?:json)?\s*|\s*```$/g, "").replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(cleaned); }
    catch (e2) {
      console.error("[gap-report] unparseable Vertex response:", e2.message);
      console.error("[gap-report] raw (600):", txt.slice(0, 600));
      return { missing_themes: [], overlap_themes: [] };
    }
  }
}

function parseArgs(argv) {
  const out = { limit: 20 };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) {
      const k = m[1].replace(/-/g, "_");
      out[k] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
    }
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.area || !flags.topic) {
    console.error("usage: --area=<slug> --topic=<slug> [--limit=N]");
    process.exit(1);
  }

  console.error(`[gap-report] running trend-scan for ${flags.area}/${flags.topic}…`);
  const trend = await runTrendScan(flags.area, flags.topic, flags.limit);
  const benchmarkTitles = (trend.items || []).map((x) => x.title).filter(Boolean);

  console.error(`[gap-report] querying Payload for our published titles…`);
  const ourTitles = await fetchOurTitles(flags.area, flags.topic);

  if (benchmarkTitles.length === 0 && ourTitles.length === 0) {
    console.log(JSON.stringify({
      area: flags.area, topic: flags.topic,
      generated_at: new Date().toISOString(),
      our_count: 0, benchmark_count: 0,
      missing_themes: [], overlap_themes: [],
      message: "no data on either side — try a different area/topic or check crawler robots.txt",
    }, null, 2));
    return;
  }

  console.error(`[gap-report] asking Vertex for theme diff (ours=${ourTitles.length}, benchmarks=${benchmarkTitles.length})…`);
  const out = await callGemini(buildPrompt({
    area: flags.area, topic: flags.topic, ourTitles, benchmarkTitles,
  }));

  // missing_themes is now a flat string array in shape "theme | priority | example".
  // Split each entry into structured fields. Defensive against malformed entries.
  const missing = (out.missing_themes || []).slice(0, 10).map((raw) => {
    const parts = String(raw).split("|").map((s) => s.trim());
    const [theme = "", rawPriority = "medium", example = ""] = parts;
    const priority = ["high", "medium", "low"].includes(rawPriority.toLowerCase())
      ? rawPriority.toLowerCase()
      : "medium";
    return {
      theme: theme.slice(0, 100),
      example_titles: example ? [example.slice(0, 140)] : [],
      priority,
    };
  }).filter((m) => m.theme.length > 3);
  const overlap = (out.overlap_themes || []).slice(0, 5).map((s) => String(s).slice(0, 100));

  console.log(JSON.stringify({
    area: flags.area,
    topic: flags.topic,
    generated_at: new Date().toISOString(),
    our_count: ourTitles.length,
    benchmark_count: benchmarkTitles.length,
    missing_themes: missing,
    overlap_themes: overlap,
  }, null, 2));
}

main().catch((e) => {
  console.error("[gap-report] ERR:", e?.message || e);
  process.exit(1);
});
