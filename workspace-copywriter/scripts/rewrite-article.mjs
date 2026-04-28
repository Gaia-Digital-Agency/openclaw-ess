#!/usr/bin/env node
/**
 * Copywriter — rewrite-article
 *
 * Take an existing article + an instruction, produce a fresh draft.
 * The new draft has the SAME source.hash as the original (so it
 * replaces, not duplicates) plus a `_v2`, `_v3`, ... suffix tag in
 * source.hash to track revision history.
 *
 * Two modes
 *
 *   1. By article id (queries Payload, in-place revision):
 *        node rewrite-article.mjs --id=70 --instruction="punchier intro, drop the recipe history paragraph"
 *
 *   2. JSON on stdin (caller-supplied article + instruction):
 *        echo '{"area":"canggu","topic":"dine","persona":"maya",
 *               "title":"Canggu warungs","body_markdown":"...",
 *               "source":{"hash":"4b87ccebb5175d5f"},
 *               "instruction":"punchier intro"}' \
 *          | node rewrite-article.mjs
 *
 * Output: same shape as draft-article.mjs, plus a `revised_from`
 * field referencing the source article id (when --id mode used) and
 * a `revision` integer (2, 3, 4, ...).
 *
 * Caller (Elliot orchestrator or human) decides what to do with it:
 *   - PATCH the existing article with the new fields (in-place revision)
 *   - Or POST a fresh article and let the human compare
 *
 * Backend: spawns the existing draft-article.mjs with an augmented brief.
 * Single source of truth — copywriter quality gates and persona presets
 * stay in draft-article.mjs.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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
const DRAFT_SCRIPT =
  "/opt/.openclaw-ess/workspace-copywriter/scripts/draft-article.mjs";

async function fetchArticleById(id) {
  if (!process.env.PAYLOAD_AGENT_PASSWORD) {
    throw new Error("PAYLOAD_AGENT_PASSWORD env missing");
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
  const r = await fetch(`${PAYLOAD_BASE_URL}/api/articles/${id}?depth=2`, {
    headers: { Authorization: `JWT ${t}` },
  });
  if (!r.ok) throw new Error(`article ${id} → ${r.status}`);
  const a = await r.json();
  // Lexical → text for prompt context.
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
    id: a.id,
    title: a.title,
    sub_title: a.subTitle,
    body_markdown: lexicalToText(a.body).slice(0, 8000),
    area: typeof a.area === "object" ? a.area?.slug : null,
    topic: typeof a.topic === "object" ? a.topic?.slug : null,
    persona: typeof a.persona === "object" ? a.persona?.slug : "putu",
    source: a.source || {},
  };
}

function nextRevisionHash(originalHash) {
  // hash is sha256-truncated already; we tag it _v2, _v3, ...
  // If already has _vN, bump.
  const m = String(originalHash || "").match(/^(.+?)_v(\d+)$/);
  if (m) return { hash: `${m[1]}_v${Number(m[2]) + 1}`, revision: Number(m[2]) + 1 };
  return { hash: `${originalHash}_v2`, revision: 2 };
}

async function runDraft(input) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn("node", [DRAFT_SCRIPT], {
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
        rejectP(new Error(`draft-article exit ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      try {
        resolveP(JSON.parse(stdout));
      } catch (e) {
        rejectP(new Error(`bad JSON from draft-article: ${e.message}`));
      }
    });
  });
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
  let instruction;

  if (flags.id) {
    original = await fetchArticleById(flags.id);
    instruction = flags.instruction || stdinJson?.instruction || "";
  } else if (stdinJson) {
    original = stdinJson;
    instruction = stdinJson.instruction || flags.instruction || "";
  } else {
    console.error("missing input — pass --id=N --instruction=\"...\" or pipe JSON");
    process.exit(1);
  }

  if (!instruction) {
    console.error("missing instruction (--instruction or in stdin JSON)");
    process.exit(1);
  }
  if (!original.title || !original.area || !original.topic) {
    console.error("original article missing area / topic / title");
    process.exit(1);
  }

  // Augmented brief — original framing + the editorial instruction.
  const augmentedBrief = [
    `Rewrite (don't merely edit) this article. Same area/topic/persona, but address this feedback:`,
    `>>> ${instruction}`,
    "",
    `Original title: ${original.title}`,
    original.sub_title ? `Original sub-title: ${original.sub_title}` : "",
    "",
    `Original body excerpt:`,
    String(original.body_markdown || "").slice(0, 3000),
  ]
    .filter(Boolean)
    .join("\n");

  const draft = await runDraft({
    area: original.area,
    topic: original.topic,
    persona: original.persona || "putu",
    brief: augmentedBrief,
    target_words: 600,
  });

  // Rebrand source.hash with revision tag so this draft is recognised
  // as a revision of the original (callers can choose to PATCH or POST).
  const origHash = (original.source && original.source.hash) || draft.sources?.[0]?.url || "unknown";
  const { hash: newHash, revision } = nextRevisionHash(origHash);

  console.log(JSON.stringify({
    ...draft,
    revised_from_id: original.id || null,
    revision,
    source: {
      url: (original.source && original.source.url) || null,
      site: (original.source && original.source.site) || null,
      hash: newHash,
    },
    instruction,
  }, null, 2));
}

main().catch((e) => {
  console.error("[rewrite-article] ERR:", e?.message || e);
  process.exit(1);
});
