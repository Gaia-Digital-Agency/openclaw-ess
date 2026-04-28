#!/usr/bin/env node
/**
 * Imager — regenerate
 *
 * Wrapper around generate-hero with feedback-augmented prompt + negative
 * prompt. Used when the human reviewer doesn't like the generated hero
 * ("too generic", "more sunset", "no people", etc.) and wants Elliot
 * to try again without re-running the whole article pipeline.
 *
 * Two input modes
 *   1. By article id (queries Payload for area/topic/title/persona):
 *        node regenerate.mjs --id=70 --feedback="more sunset, less generic"
 *   2. JSON on stdin:
 *        echo '{"area":"...","topic":"...","title":"...","summary":"...",
 *               "persona":"...","feedback":"more atmosphere"}' \
 *          | node regenerate.mjs
 *
 * Behaviour
 *   1. Spawn generate-hero.mjs with augmented summary + extra --negative.
 *   2. Upload the resulting PNG to /api/media (so it's in GCS + Payload).
 *   3. Return both the new mediaId AND the old hero mediaId so the
 *      orchestrator (or human) can PATCH article.hero. We do NOT
 *      auto-delete the old media — that's an explicit human action.
 *
 * Output (stdout JSON):
 *   {
 *     article_id: number | null,
 *     old_hero_media_id: number | null,
 *     new_hero_media_id: number,
 *     new_hero_url: string,    // direct GCS URL
 *     prompt: string,
 *     negative_prompt: string,
 *     feedback: string
 *   }
 *
 * To swap, the caller does:
 *   PATCH /api/articles/{article_id}  { "hero": new_hero_media_id }
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";

for (const envPath of [
  "/opt/.openclaw-ess/credentials/.env.payload",
  "/opt/.openclaw-ess/credentials/.env.vertex",
]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PAYLOAD_BASE_URL =
  process.env.PAYLOAD_BASE_URL || "https://essentialbali.gaiada.online";
const HERO_SCRIPT =
  "/opt/.openclaw-ess/workspace-imager/scripts/generate-hero.mjs";

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
  return {
    id: a.id,
    title: a.title,
    sub_title: a.subTitle,
    area: typeof a.area === "object" ? a.area?.slug : null,
    topic: typeof a.topic === "object" ? a.topic?.slug : null,
    persona: typeof a.persona === "object" ? a.persona?.slug : null,
    old_hero_media_id: typeof a.hero === "object" ? a.hero?.id : a.hero || null,
  };
}

async function runHeroGenerator(input) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn("node", [HERO_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`generate-hero exit ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      try { resolveP(JSON.parse(stdout)); }
      catch (e) { rejectP(new Error(`bad JSON: ${e.message}`)); }
    });
  });
}

async function uploadHero(filepath, alt) {
  const t = await login();
  const buf = await readFile(filepath);
  const FormDataNode = (await import("formdata-node")).FormData;
  const { Blob } = await import("node:buffer");
  const form = new FormDataNode();
  form.set("file", new Blob([buf], { type: "image/png" }), filepath.split("/").pop());
  form.set("_payload", JSON.stringify({ alt: alt || "Regenerated hero", generatedBy: "imager" }));
  const res = await fetch(`${PAYLOAD_BASE_URL}/api/media`, {
    method: "POST",
    headers: { Authorization: `JWT ${t}` },
    body: form,
  });
  if (!res.ok) throw new Error(`media upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d?.doc || d;
}

// Translate a feedback hint into extra negative-prompt fragments.
// "more sunset" → no edits to negative; instead augment summary.
// "no people" / "no faces" → add to negative.
// "less generic" → add 'stock-photo cliché, generic photography'.
function feedbackToNegative(feedback) {
  const f = String(feedback || "").toLowerCase();
  const extras = [];
  if (/no people|no faces|no person|no humans/.test(f)) extras.push("people, faces, humans");
  if (/less generic|not stock|not cliché|not cliche/.test(f)) extras.push("stock-photo cliché, generic photography, posed model");
  if (/no signs|no text|no sign/.test(f)) extras.push("text, signage, lettering, captions");
  if (/no logo/.test(f)) extras.push("logos, brand marks");
  if (/sharper|crisp/.test(f)) extras.push("blurry, soft focus");
  if (/no white background|no studio/.test(f)) extras.push("white background, studio shot, isolated subject");
  return extras.join(", ");
}

function feedbackToSummaryAdditions(feedback) {
  // Free-form narrative addition. Just append the operator's note so
  // Imagen sees it. Keep it short.
  return String(feedback || "").trim().slice(0, 240);
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
  const stdinJson = await readStdin();
  let original;
  let feedback;
  if (flags.id) {
    original = await fetchArticleById(flags.id);
    feedback = flags.feedback || stdinJson?.feedback || "";
  } else if (stdinJson) {
    original = stdinJson;
    feedback = stdinJson.feedback || flags.feedback || "";
  } else {
    console.error("missing input — pass --id=N --feedback=\"...\" or pipe JSON");
    process.exit(1);
  }
  if (!original.title || !original.area || !original.topic) {
    console.error("input missing area / topic / title");
    process.exit(1);
  }
  if (!feedback) {
    console.error("missing feedback (--feedback=\"...\")");
    process.exit(1);
  }

  const augmentedSummary = [
    original.summary || original.sub_title || original.title,
    "Operator feedback: " + feedbackToSummaryAdditions(feedback),
  ].filter(Boolean).join(". ");

  const extraNegative = feedbackToNegative(feedback);

  const heroOut = await runHeroGenerator({
    area: original.area,
    topic: original.topic,
    persona: original.persona || undefined,
    title: original.title,
    summary: augmentedSummary,
    out_dir: "/tmp/imager-regen",
    ...(extraNegative ? { negative: extraNegative } : {}),
  });

  const file = heroOut?.files?.[0];
  if (!file?.path) {
    console.error("generate-hero did not produce a file");
    process.exit(1);
  }
  const mediaDoc = await uploadHero(file.path, file.alt_text || original.title);

  console.log(JSON.stringify({
    article_id: original.id || null,
    old_hero_media_id: original.old_hero_media_id || null,
    new_hero_media_id: mediaDoc.id,
    new_hero_url: mediaDoc.url,
    new_hero_filename: mediaDoc.filename,
    prompt: heroOut.prompt,
    negative_prompt: heroOut.negative_prompt,
    feedback,
    next_step:
      original.id
        ? `PATCH ${PAYLOAD_BASE_URL}/api/articles/${original.id} { "hero": ${mediaDoc.id} }`
        : "(no article id — caller must wire the new media)",
  }, null, 2));
}

main().catch((e) => {
  console.error("[imager-regenerate] ERR:", e?.message || e);
  process.exit(1);
});
