#!/usr/bin/env node
/**
 * Phase 3 retry — the 6 articles that failed Copywriter on the first pass.
 *
 * Same shape as phase3-driver.mjs but with shorter briefs. The original
 * briefs occasionally pushed Gemini past its JSON output budget, causing
 * truncation. Trimmed briefs in this retry pass are ~40% shorter; if a
 * cell still fails, we move on (target_words bumped down too).
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

const PACING_MS = 25_000;

const PLAN = [
  { group: "mostPopular", persona: "maya",          area: "canggu",   topic: "featured",
    brief: "Canggu's real rhythm. Five concrete observations on how the area feels Tuesday vs Saturday. Echo Beach, Berawa, the Banjar warung scene. 500 words." },
  { group: "mostPopular", persona: "sang-ayu-rai",  area: "denpasar", topic: "people-culture",
    brief: "Denpasar's banjar (community council) life. Ceremony cycles, Pasar Badung's morning rhythm, why the city is the most authentically Balinese place left. 500 words." },
  { group: "trending",    persona: "tomas-veld",    area: "kuta",     topic: "nightlife",
    brief: "Three Kuta bars that survived the post-2020 shake-out. Drink prices, who runs them, set times, what makes them not a cliche. 500 words." },
  { group: "ultimateGuide", persona: "nadia-puspita", area: "ubud",     topic: "dine",
    brief: "Vegetarian Ubud as a full-day walking guide. Six places: breakfast, lunch, snacks, dinner. Specific dishes, sourcing notes. 500 words." },
  { group: "ultimateGuide", persona: "kira-bumi",     area: "canggu",   topic: "activities",
    brief: "Surfing Canggu year-round. A beginner's calendar by month: wave size, crowds, board hire. Old Man's vs Berawa vs Echo Beach. 500 words." },
  { group: "spotlight",     persona: "kira-bumi",     area: "kuta",     topic: "activities",
    brief: "Kuta beyond the beach. Day-trip recommendations from Kuta locals: Tukad Cepung, GWK, Bird Park. Motorbike vs taxi, half-day vs full-day. 500 words." },
];

let token = null;
async function login() {
  if (token) return token;
  const r = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: AGENT_EMAIL, password: AGENT_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
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
  if (!r.ok) throw new Error(`PATCH ${id} ${r.status}`);
  return r.json();
}

function runDispatch(input) {
  return new Promise((resolve) => {
    const proc = spawn("node", [DISPATCHER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
      process.stderr.write(b);
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    proc.on("close", (code) => {
      try { resolve({ code, json: JSON.parse(stdout || "{}"), stderr }); }
      catch { resolve({ code, json: null, stderr, stdout }); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const summary = [];
  for (let i = 0; i < PLAN.length; i++) {
    const p = PLAN[i];
    const tag = `[retry ${i + 1}/${PLAN.length}]`;
    console.error(`\n${tag} ${p.group} · ${p.area}/${p.topic} · persona=${p.persona}`);
    const t0 = Date.now();
    try {
      const r = await runDispatch({
        area: p.area, topic: p.topic, persona: p.persona,
        brief: p.brief, target_words: 500,
      });
      if (r.code !== 0 || !r.json?.article_id) {
        const reason = r.json?.status || `exit ${r.code}`;
        console.error(`${tag} dispatch FAILED: ${reason}`);
        summary.push({ ...p, status: "dispatch_failed", reason });
        await sleep(PACING_MS);
        continue;
      }
      const id = r.json.article_id;
      await patchArticle(id, {
        group: p.group,
        status: "published",
        publishedAt: new Date().toISOString(),
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`${tag} ✓ id=${id} group=${p.group} (${dt}s)`);
      summary.push({ ...p, status: "ok", article_id: id, took: dt });
    } catch (e) {
      console.error(`${tag} EXCEPTION: ${e.message}`);
      summary.push({ ...p, status: "exception", error: e.message });
    }
    if (i < PLAN.length - 1) await sleep(PACING_MS);
  }

  console.error("\n=== retry summary ===");
  const ok = summary.filter((s) => s.status === "ok").length;
  console.error(`  ${ok}/${summary.length} ok`);
  for (const s of summary) {
    const id = s.article_id ? `#${s.article_id}` : "----";
    console.error(`  ${s.status.padEnd(15)} ${id}  ${s.group} · ${s.area}/${s.topic}`);
  }
  console.log(JSON.stringify({ ok, items: summary }, null, 2));
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
