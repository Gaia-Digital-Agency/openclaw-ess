#!/usr/bin/env node
/**
 * Elliot — status-report
 *
 * Per-cell snapshot of the production matrix (8 areas × 8 topics).
 * Counts every status (published, approved, pending_review, draft,
 * rejected) per cell. Default output is JSON; --table prints a
 * human-readable grid.
 *
 * Usage
 *   node status-report.mjs                  # JSON to stdout
 *   node status-report.mjs --table          # ASCII table to stdout
 *   node status-report.mjs --status=pending_review --table
 *                                           # one status only, easier to scan
 *
 * Required env (or .env.payload):
 *   PAYLOAD_BASE_URL, PAYLOAD_AGENT_EMAIL, PAYLOAD_AGENT_PASSWORD
 */
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

for (const envPath of ["/opt/.openclaw-ess/credentials/.env.payload"]) {
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

const AREAS = ["canggu", "kuta", "ubud", "jimbaran", "denpasar", "kintamani", "singaraja", "nusa-penida"];
const TOPICS = ["events", "news", "featured", "dine", "health-wellness", "nightlife", "activities", "people-culture"];
const STATUSES = ["published", "approved", "pending_review", "draft", "rejected"];
const TARGET_PER_CELL = 20;

let _token = null;
async function login() {
  if (_token) return _token;
  const res = await fetch(`${PAYLOAD_BASE_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.PAYLOAD_AGENT_EMAIL,
      password: process.env.PAYLOAD_AGENT_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const d = await res.json();
  _token = d.token;
  return _token;
}

async function payloadGet(path) {
  const t = await login();
  const r = await fetch(`${PAYLOAD_BASE_URL}${path}`, {
    headers: { Authorization: `JWT ${t}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function findIdBySlug(collection, slug) {
  const d = await payloadGet(
    `/api/${collection}?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=0`,
  );
  return d?.docs?.[0]?.id || null;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--table") out.table = true;
    else {
      const m = a.match(/^--([^=]+)=(.*)$/);
      if (m) out[m[1].replace(/-/g, "_")] = m[2];
    }
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const areaIds = {};
  const topicIds = {};
  for (const s of AREAS) areaIds[s] = await findIdBySlug("areas", s);
  for (const s of TOPICS) topicIds[s] = await findIdBySlug("topics", s);

  // Single big pull — 1280 max if every cell at target.
  const all = await payloadGet(
    `/api/articles?limit=2000&depth=0`,
  );
  // Initialise grid
  const grid = {};
  for (const a of AREAS) {
    grid[a] = {};
    for (const t of TOPICS) {
      grid[a][t] = { published: 0, approved: 0, pending_review: 0, draft: 0, rejected: 0, total: 0 };
    }
  }

  for (const doc of all.docs || []) {
    const aId = typeof doc.area === "object" ? doc.area?.id : doc.area;
    const tId = typeof doc.topic === "object" ? doc.topic?.id : doc.topic;
    const aSlug = Object.keys(areaIds).find((k) => areaIds[k] === aId);
    const tSlug = Object.keys(topicIds).find((k) => topicIds[k] === tId);
    if (!aSlug || !tSlug) continue;
    const status = String(doc.status || "draft");
    if (!STATUSES.includes(status)) continue;
    grid[aSlug][tSlug][status] += 1;
    grid[aSlug][tSlug].total += 1;
  }

  const totals = { published: 0, approved: 0, pending_review: 0, draft: 0, rejected: 0, total: 0 };
  const cells = [];
  for (const a of AREAS) {
    for (const t of TOPICS) {
      const c = grid[a][t];
      cells.push({ area: a, topic: t, ...c, deficit: Math.max(0, TARGET_PER_CELL - c.published) });
      for (const k of Object.keys(totals)) totals[k] += c[k];
    }
  }

  if (flags.table) {
    const colKey = flags.status && STATUSES.includes(flags.status) ? flags.status : "published";
    process.stdout.write(`\nstatus-report — column: ${colKey} (target ${TARGET_PER_CELL}/cell)\n\n`);
    const headerCells = ["area \\ topic", ...TOPICS.map((t) => t.slice(0, 7))];
    const colWidth = 11;
    const fmt = (s, w = colWidth) => String(s).padEnd(w);
    process.stdout.write(headerCells.map((c, i) => fmt(c, i === 0 ? 14 : colWidth)).join(" ") + "\n");
    process.stdout.write("-".repeat(14 + (TOPICS.length * (colWidth + 1))) + "\n");
    for (const a of AREAS) {
      const row = [fmt(a, 14)];
      for (const t of TOPICS) row.push(fmt(grid[a][t][colKey], colWidth));
      process.stdout.write(row.join(" ") + "\n");
    }
    process.stdout.write(`\ntotals — published ${totals.published} · approved ${totals.approved} · pending_review ${totals.pending_review} · draft ${totals.draft} · rejected ${totals.rejected} · all ${totals.total}\n`);
    process.stdout.write(`target ${TARGET_PER_CELL}/cell × 64 cells = ${TARGET_PER_CELL * 64} ; published progress ${totals.published}/${TARGET_PER_CELL * 64} = ${((totals.published / (TARGET_PER_CELL * 64)) * 100).toFixed(1)}%\n`);
    return;
  }

  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    target_per_cell: TARGET_PER_CELL,
    total_cells: AREAS.length * TOPICS.length,
    totals,
    cells,
  }, null, 2));
}

main().catch((e) => {
  console.error("[status-report] FATAL:", e?.message || e);
  process.exit(1);
});
