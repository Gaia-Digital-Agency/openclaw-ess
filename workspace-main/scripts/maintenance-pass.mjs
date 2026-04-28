#!/usr/bin/env node
/**
 * Elliot — maintenance-pass
 *
 * Find and triage stale articles:
 *   - Events past their endAt date → status=draft (so they fall out of
 *     the public site + sitemap, but are kept for audit).
 *   - News older than --news-days (default 30) AND status=published →
 *     marked stale (added to a queue file for later refresh).
 *   - Featured / Articles older than --feature-days (default 180) AND
 *     status=published → marked stale for refresh.
 *
 * By default this is DRY-RUN — prints the list of articles that WOULD
 * be touched. Pass --apply to actually PATCH Payload.
 *
 * Output (JSON):
 *   {
 *     scanned: number,
 *     events_expired:   [{id, title, area, topic, endAt}, ...],
 *     news_stale:       [{id, title, publishedAt, age_days}, ...],
 *     features_stale:   [{id, title, publishedAt, age_days}, ...],
 *     applied: bool,
 *     patches: [{id, action, status_before, status_after}, ...]
 *   }
 *
 * Usage
 *   node maintenance-pass.mjs                      # dry run, defaults
 *   node maintenance-pass.mjs --news-days=45 --feature-days=365
 *   node maintenance-pass.mjs --apply              # actually patch Payload
 *
 * Required env: PAYLOAD_BASE_URL, PAYLOAD_AGENT_EMAIL, PAYLOAD_AGENT_PASSWORD
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

async function payloadGet(path) {
  const t = await login();
  const r = await fetch(`${PAYLOAD_BASE_URL}${path}`, {
    headers: { Authorization: `JWT ${t}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function payloadPatch(path, body) {
  const t = await login();
  const r = await fetch(`${PAYLOAD_BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `JWT ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function parseArgs(argv) {
  const out = { apply: false, news_days: 30, feature_days: 180 };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) {
      const k = m[1].replace(/-/g, "_");
      out[k] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
    }
  }
  return out;
}

const ageDays = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
};

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  // Pull all published + approved + pending_review articles in one go.
  const all = await payloadGet(
    `/api/articles?where[status][in]=published,approved,pending_review&limit=2000&depth=1`,
  );
  const docs = all.docs || [];

  const events_expired = [];
  const news_stale = [];
  const features_stale = [];

  const NOW = Date.now();
  for (const a of docs) {
    const topicSlug = typeof a.topic === "object" ? a.topic?.slug : null;
    const areaSlug = typeof a.area === "object" ? a.area?.slug : null;

    // Events: expire when an explicit endAt has passed.
    // We don't have an Articles.endAt field by default; use publishedAt
    // as floor and add a topic-specific freshness window.
    if (topicSlug === "events" && a.status === "published") {
      // Best heuristic: events older than 14 days are stale by default.
      const age = ageDays(a.publishedAt);
      if (age != null && age > 14) {
        events_expired.push({
          id: a.id,
          title: a.title,
          area: areaSlug,
          topic: topicSlug,
          publishedAt: a.publishedAt,
          age_days: age,
        });
      }
    }

    if (topicSlug === "news" && a.status === "published") {
      const age = ageDays(a.publishedAt);
      if (age != null && age > flags.news_days) {
        news_stale.push({
          id: a.id,
          title: a.title,
          area: areaSlug,
          publishedAt: a.publishedAt,
          age_days: age,
        });
      }
    }

    // Featured / Articles / Dine / etc. — older than feature_days.
    if (
      a.status === "published" &&
      topicSlug !== "events" &&
      topicSlug !== "news"
    ) {
      const age = ageDays(a.publishedAt);
      if (age != null && age > flags.feature_days) {
        features_stale.push({
          id: a.id,
          title: a.title,
          area: areaSlug,
          topic: topicSlug,
          publishedAt: a.publishedAt,
          age_days: age,
        });
      }
    }
  }

  const patches = [];
  if (flags.apply) {
    // Expired events → status=draft (drops them from public + sitemap).
    for (const e of events_expired) {
      try {
        await payloadPatch(`/api/articles/${e.id}`, { status: "draft" });
        patches.push({ id: e.id, action: "expire-event", status_before: "published", status_after: "draft" });
      } catch (err) {
        patches.push({ id: e.id, action: "expire-event", error: err.message });
      }
    }
    // Stale news / features — we DO NOT auto-flip them. They're left
    // published; we just emit them in the report so plan-wave (or you)
    // can dispatch refresh drafts at the same hash later.
  }

  console.log(JSON.stringify({
    scanned: docs.length,
    news_days: flags.news_days,
    feature_days: flags.feature_days,
    events_expired,
    news_stale,
    features_stale,
    applied: flags.apply,
    patches,
    next_step: flags.apply
      ? "events flipped to draft. News/features stale list is informational — feed to plan-wave to dispatch refresh drafts."
      : "DRY RUN — pass --apply to actually flip expired events to draft.",
  }, null, 2));
}

main().catch((e) => {
  console.error("[maintenance-pass] ERR:", e?.message || e);
  process.exit(1);
});
