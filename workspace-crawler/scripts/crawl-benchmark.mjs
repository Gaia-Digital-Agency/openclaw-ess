#!/usr/bin/env node
/**
 * Crawler — fetch a benchmark page and extract structured content.
 *
 * Usage:
 *   node crawl-benchmark.mjs <url>
 *   node crawl-benchmark.mjs --discover --site=thehoneycombers.com/bali --area=canggu --topic=dine
 *
 * Honors robots.txt (best-effort), 1 req/sec rate limit, EssentialBaliBot UA.
 *
 * Output: JSON to stdout — {url, site, title, headings, paragraphs[], hero, links[]}
 *
 * Sources: whatsnewindonesia.com · thehoneycombers.com/bali · nowbali.co.id · thebalibible.com
 *
 * Crawler does NOT republish. Treats fetched content as research only.
 * Copywriter rewrites in Essential Bali voice via separate agent.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parse as parseUrl } from "node:url";

const UA = "EssentialBaliBot/1.0 (research; +https://essentialbali.gaiada.online)";
const RATE_LIMIT_MS = 1000;
const SOURCES = {
  whatsnew: "https://whatsnewindonesia.com",
  honeycombers: "https://thehoneycombers.com/bali",
  nowbali: "https://www.nowbali.co.id",
  balibible: "https://www.thebalibible.com",
};

const robotsCache = new Map();

async function checkRobots(url) {
  const u = parseUrl(url);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  if (!robotsCache.has(u.host)) {
    try {
      const r = await fetch(robotsUrl, { headers: { "User-Agent": UA } });
      robotsCache.set(u.host, r.ok ? await r.text() : "");
    } catch {
      robotsCache.set(u.host, "");
    }
  }
  const robots = robotsCache.get(u.host);
  // Simplistic check — full RFC compliance is the responsibility of the
  // serious scraper. We at least look for an explicit Disallow on our path.
  const lines = robots.split("\n");
  let applies = false;
  for (const line of lines) {
    const t = line.trim().toLowerCase();
    if (t.startsWith("user-agent:")) {
      applies = t.includes("*") || t.includes("essentialbalibot");
    } else if (applies && t.startsWith("disallow:")) {
      const path = line.split(":")[1].trim();
      if (path && u.pathname.startsWith(path)) return false;
    }
  }
  return true;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extract(html, url) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1];
  const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1];

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const h3s = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => stripTags(m[1])).filter(Boolean);

  // Try to find article body — common containers in WP/blog templates.
  const bodyMatch =
    html.match(/<article[\s\S]*?<\/article>/i) ||
    html.match(/<main[\s\S]*?<\/main>/i) ||
    html.match(/<div[^>]+class=["'][^"']*entry-content[^"']*["'][\s\S]*?<\/div>/i);

  const bodyHtml = bodyMatch ? bodyMatch[0] : "";
  const paragraphs = [...bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((p) => p.length > 40);

  const wordCount = paragraphs.reduce((s, p) => s + p.split(/\s+/).length, 0);

  // Internal links — domain-local
  const linkMatches = [...bodyHtml.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const links = [...new Set(linkMatches)]
    .filter((l) => l.startsWith("http") || l.startsWith("/"))
    .slice(0, 30);

  return {
    url,
    site: parseUrl(url).host,
    title: ogTitleMatch?.[1] || titleMatch?.[1] || "",
    description: description || "",
    hero: ogImage || "",
    headings: { h1: h1s, h2: h2s, h3: h3s },
    paragraphs: paragraphs.slice(0, 60),
    wordCount,
    links,
    fetchedAt: new Date().toISOString(),
  };
}

let lastFetch = 0;
async function fetchAt(url) {
  const wait = Math.max(0, RATE_LIMIT_MS - (Date.now() - lastFetch));
  if (wait) await sleep(wait);
  lastFetch = Date.now();

  const allowed = await checkRobots(url);
  if (!allowed) {
    throw new Error(`robots.txt disallows ${url}`);
  }
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.5" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

async function discover(siteHostPath, area, topic) {
  // Simple approach: hit the site's search/landing for the area term.
  // Each benchmark has a different structure; refine per source as needed.
  const candidates = {
    "thehoneycombers.com/bali": `https://thehoneycombers.com/bali/?s=${encodeURIComponent(area + " " + topic)}`,
    "whatsnewindonesia.com": `https://whatsnewindonesia.com/?s=${encodeURIComponent(area + " " + topic)}`,
    "nowbali.co.id": `https://www.nowbali.co.id/?s=${encodeURIComponent(area + " " + topic)}`,
    "thebalibible.com": `https://www.thebalibible.com/?s=${encodeURIComponent(area + " " + topic)}`,
  };
  const searchUrl = candidates[siteHostPath];
  if (!searchUrl) throw new Error(`unknown site: ${siteHostPath}`);
  const html = await fetchAt(searchUrl);
  // Pull article-link anchors from search result page
  const anchors = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi)];
  const u = parseUrl(searchUrl);
  const same = anchors
    .map((m) => ({ href: m[1], text: stripTags(m[2]) }))
    .filter((a) => {
      try {
        const au = new URL(a.href, searchUrl);
        return au.host === u.host && au.pathname.length > 8 && au.pathname !== u.pathname && !au.pathname.includes("/page/");
      } catch {
        return false;
      }
    })
    .filter((a) => a.text.length > 10)
    .slice(0, 10);
  return same;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(
    args
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.replace(/^--/, "").split("=");
        return [k, v ?? true];
      }),
  );
  const positional = args.filter((a) => !a.startsWith("--"));

  if (flags.discover) {
    const site = flags.site || "thehoneycombers.com/bali";
    const area = flags.area || "canggu";
    const topic = flags.topic || "dine";
    const list = await discover(site, area, topic);
    console.log(JSON.stringify({ site, area, topic, candidates: list }, null, 2));
    return;
  }

  const url = positional[0];
  if (!url) {
    console.error("Usage: crawl-benchmark.mjs <url> | --discover --site=... --area=... --topic=...");
    process.exit(1);
  }
  const html = await fetchAt(url);
  const data = extract(html, url);
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: String(e?.message || e) }));
  process.exit(1);
});
