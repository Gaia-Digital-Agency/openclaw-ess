#!/usr/bin/env node
/**
 * Phase 1 — campaign benchmark sweep.
 * Discovers article-candidate URLs + titles from 4 Bali sites
 * across 5 representative (area, category) cells. Output is JSON
 * at /opt/.openclaw-ess/workspace-crawler/output/campaign-benchmark-2026-04-29.json
 *
 * Used by Copywriter as anti-template (avoid copying, internalize tone).
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";

const CRAWLER = "/opt/.openclaw-ess/workspace-crawler/scripts/crawl-benchmark.mjs";

// Representative cells — span different topics so Copywriter sees a
// variety of headline + lead styles.
const CELLS = [
  { area: "canggu",       topic: "dine" },
  { area: "ubud",         topic: "health-wellness" },
  { area: "kuta",         topic: "nightlife" },
  { area: "denpasar",     topic: "people-culture" },
  { area: "nusa-penida",  topic: "activities" },
];

const SITES = [
  "thehoneycombers.com/bali",
  "nowbali.co.id",
];

function runDiscover({ site, area, topic }) {
  return new Promise((resolve) => {
    const args = [CRAWLER, `--discover`, `--site=${site}`, `--area=${area}`, `--topic=${topic}`];
    const proc = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ site, area, topic, error: stderr.slice(0, 300) || `exit ${code}` });
        return;
      }
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (e) {
        resolve({ site, area, topic, error: `bad JSON: ${e.message}` });
      }
    });
  });
}

async function main() {
  console.error(`[benchmark] ${CELLS.length} cells × ${SITES.length} sites = ${CELLS.length * SITES.length} discoveries`);
  const startedAt = new Date().toISOString();
  const results = [];
  for (const cell of CELLS) {
    for (const site of SITES) {
      console.error(`  ${site} · ${cell.area} · ${cell.topic} ...`);
      const r = await runDiscover({ site, ...cell });
      results.push(r);
    }
  }
  const dataset = {
    generatedAt: startedAt,
    completedAt: new Date().toISOString(),
    cellCount: CELLS.length,
    siteCount: SITES.length,
    cells: results,
    notes: [
      "Used by Copywriter as ANTI-TEMPLATE. Read tone, do not copy phrasing.",
      "Each cell entry has either { site, area, topic, candidates: [{href,text}] } or { ..., error }.",
      "Ignored cells with errors are normal — sites may rate-limit, robots-block, or have search disabled.",
    ],
  };
  const outDir = "/opt/.openclaw-ess/workspace-crawler/output";
  await mkdir(outDir, { recursive: true });
  const outPath = `${outDir}/campaign-benchmark-2026-04-29.json`;
  await writeFile(outPath, JSON.stringify(dataset, null, 2));
  const okCount = results.filter((r) => !r.error && r.candidates?.length).length;
  console.error(`[benchmark] done · ${okCount}/${results.length} cells with candidates · wrote ${outPath}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
