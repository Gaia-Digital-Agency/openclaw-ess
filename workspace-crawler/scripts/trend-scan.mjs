#!/usr/bin/env node
/**
 * Crawler — trend-scan
 *
 * For a given area (and optional topic), discover candidate articles
 * from all 4 benchmark sites, merge, dedupe, sort by recency, and
 * emit the top N.
 *
 * Usage
 *   node trend-scan.mjs --area=canggu                     # all topics, top 20
 *   node trend-scan.mjs --area=ubud --topic=dine          # one cell, top 20
 *   node trend-scan.mjs --area=canggu --limit=10
 *   node trend-scan.mjs --area=canggu --site=honeycombers # one source only
 *
 * Output (stdout JSON):
 *   {
 *     area, topic?, generated_at,
 *     sources_tried: [{site, attempted, succeeded}],
 *     items: [{url, title, site, area, topic, date?, snippet?}]
 *   }
 *
 * Manners
 *   - 1 req/sec rate limit per site.
 *   - EssentialBaliBot/1.0 UA.
 *   - Best-effort robots.txt awareness via the existing crawl-benchmark.
 *   - Research only — never republished. Copywriter rewrites with citation.
 */
import { setTimeout as sleep } from "node:timers/promises";
import process from "node:process";

const UA = "EssentialBaliBot/1.0 (research; +https://essentialbali.gaiada.online)";
const RATE_LIMIT_MS = 1100;

// Per-site discovery URL templates. Each function returns the search URL
// for a given area (and optional topic). Best-effort — sites have wildly
// different IA, so we just pick one or two reasonable starting points.
const SOURCES = {
  honeycombers: {
    base: "https://thehoneycombers.com/bali",
    discoverUrls: (area, topic) => {
      const urls = [];
      // Honeycombers indexes by tag — area + topic both work as tags.
      urls.push(`https://thehoneycombers.com/bali/?s=${encodeURIComponent(area)}`);
      if (topic) {
        urls.push(`https://thehoneycombers.com/bali/?s=${encodeURIComponent(area + " " + topic)}`);
      }
      return urls;
    },
  },
  whatsnew: {
    base: "https://whatsnewindonesia.com",
    discoverUrls: (area, topic) => {
      const urls = [`https://whatsnewindonesia.com/?s=${encodeURIComponent(area)}`];
      if (topic) urls.push(`https://whatsnewindonesia.com/?s=${encodeURIComponent(area + " " + topic)}`);
      return urls;
    },
  },
  nowbali: {
    base: "https://www.nowbali.co.id",
    discoverUrls: (area, topic) => {
      const urls = [`https://www.nowbali.co.id/?s=${encodeURIComponent(area)}`];
      if (topic) urls.push(`https://www.nowbali.co.id/?s=${encodeURIComponent(area + " " + topic)}`);
      return urls;
    },
  },
  balibible: {
    base: "https://www.thebalibible.com",
    discoverUrls: (area, topic) => {
      const urls = [`https://www.thebalibible.com/?s=${encodeURIComponent(area)}`];
      if (topic) urls.push(`https://www.thebalibible.com/?s=${encodeURIComponent(area + " " + topic)}`);
      return urls;
    },
  },
};

// rate-limit per host
const lastFetchByHost = new Map();
async function politeFetch(url) {
  const u = new URL(url);
  const last = lastFetchByHost.get(u.host) || 0;
  const wait = Math.max(0, last + RATE_LIMIT_MS - Date.now());
  if (wait > 0) await sleep(wait);
  lastFetchByHost.set(u.host, Date.now());
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

// Parse <a href="..."> link tags from listing HTML. Looks for plausible
// article URLs (not menus, not categories) by URL shape: must contain
// at least 2 path segments, first segment not in a stoplist.
const STOP_SEGMENTS = new Set([
  "category", "tag", "author", "page", "wp-content", "wp-admin", "wp-includes",
  "feed", "search", "?s", "about", "contact", "privacy", "terms",
]);

function extractCandidateLinks(html, baseHost) {
  if (!html) return [];
  const out = new Map();
  const linkRe = /<a\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    let href = m[1].trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    let absUrl;
    try {
      absUrl = new URL(href, `https://${baseHost}`);
    } catch { continue; }
    if (absUrl.host !== baseHost) continue;
    const segs = absUrl.pathname.split("/").filter(Boolean);
    if (segs.length < 1) continue;
    if (STOP_SEGMENTS.has(segs[0])) continue;
    // Likely article slugs: multi-word kebab-case (≥2 hyphens) OR ≥3
    // path segments (date-based URLs like /2024/03/15/title-here).
    const last = segs[segs.length - 1];
    if (!last || last.length < 8) continue;
    if (/^\d{4}$/.test(last) || /^\d{4}-\d{2}$/.test(last)) continue;
    const hyphenCount = (last.match(/-/g) || []).length;
    if (hyphenCount < 2 && segs.length < 3) continue;
    // Skip area-slug-only URLs like /bali/canggu, /bali/seminyak, etc.
    if (/^(canggu|seminyak|kuta|ubud|jimbaran|denpasar|kintamani|singaraja|nusa-penida|nusa-dua|lembongan|sanur|uluwatu|legian|mengwi|tabanan)$/i.test(last)) continue;
    // Strip common URL noise (utm_*, fbclid, etc.)
    absUrl.search = "";
    const u = absUrl.toString().replace(/\/$/, "");
    // Title from inner HTML — strip tags + decode entities
    const innerText = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#?\w+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!innerText || innerText.length < 8 || innerText.length > 200) continue;
    if (out.has(u)) continue; // first occurrence wins
    out.set(u, innerText);
  }
  return [...out.entries()].map(([url, title]) => ({ url, title }));
}

// Try to extract a publication date from a single article page.
function extractDate(html) {
  if (!html) return null;
  // Schema.org JSON-LD datePublished
  const ldMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (ldMatch) return new Date(ldMatch[1]).toISOString();
  // Open Graph article:published_time
  const ogMatch = html.match(/<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) return new Date(ogMatch[1]).toISOString();
  // <time datetime="...">
  const timeMatch = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (timeMatch) return new Date(timeMatch[1]).toISOString();
  return null;
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
  if (!flags.area) {
    console.error("usage: --area=canggu [--topic=dine] [--limit=N] [--site=honeycombers|whatsnew|nowbali|balibible]");
    process.exit(1);
  }
  const sites = flags.site
    ? Object.keys(SOURCES).filter((s) => s === flags.site)
    : Object.keys(SOURCES);

  const sourcesTried = [];
  const allCandidates = new Map(); // url → {url, title, site}

  for (const siteKey of sites) {
    const cfg = SOURCES[siteKey];
    const urls = cfg.discoverUrls(flags.area, flags.topic);
    let attempted = 0;
    let succeeded = 0;
    for (const u of urls) {
      attempted += 1;
      const html = await politeFetch(u);
      if (!html) continue;
      succeeded += 1;
      const baseHost = new URL(cfg.base).host;
      for (const c of extractCandidateLinks(html, baseHost)) {
        if (!allCandidates.has(c.url)) {
          allCandidates.set(c.url, { ...c, site: siteKey });
        }
      }
    }
    sourcesTried.push({ site: siteKey, attempted, succeeded });
  }

  // Optional: enrich top candidates with publication date by fetching
  // each. Cap to limit*2 to avoid thrashing benchmarks.
  const enrichLimit = Math.min(allCandidates.size, flags.limit * 2);
  const candidates = [...allCandidates.values()].slice(0, enrichLimit);
  for (const c of candidates) {
    const html = await politeFetch(c.url);
    if (html) c.date = extractDate(html);
  }

  // Sort: with-date first (newest first), then dateless tail.
  const withDate = candidates.filter((c) => c.date).sort((a, b) => b.date.localeCompare(a.date));
  const dateless = candidates.filter((c) => !c.date);
  const items = [...withDate, ...dateless].slice(0, flags.limit);

  console.log(JSON.stringify({
    area: flags.area,
    topic: flags.topic || null,
    generated_at: new Date().toISOString(),
    sources_tried: sourcesTried,
    items_count: items.length,
    items,
  }, null, 2));
}

main().catch((e) => {
  console.error("[trend-scan] ERR:", e?.message || e);
  process.exit(1);
});
