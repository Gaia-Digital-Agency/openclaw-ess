#!/usr/bin/env node
/**
 * Imager — generate-hero (Vertex Imagen 3).
 *
 * Usage:
 *   echo '{"area":"canggu","topic":"dine","title":"Best warungs in Canggu",
 *          "summary":"...","out_dir":"/tmp"}' \
 *     | node generate-hero.mjs
 *
 *   node generate-hero.mjs --area=canggu --topic=dine \
 *     --title="Best warungs in Canggu" --summary="..." --out_dir=/tmp
 *
 * Modes:
 *   default — generates 1 hero image (16:9, 1920×1080).
 *   --inline=N — generates N inline supporting images (1:1, 1024×1024).
 *
 * Input fields:
 *   area, topic     required (slugs) — used to anchor visual style
 *   title           required — primary subject of the image
 *   summary?        1-2 sentence article summary, sharpens the prompt
 *   persona?        slug — voice can hint at composition (foodie → close-up food)
 *   out_dir?        local directory to write the PNGs (default /tmp)
 *   filename_base?  defaults to slug-of-title
 *   negative?       extra negative-prompt fragment
 *
 * Output (stdout JSON):
 *   {
 *     prompt, negative_prompt, files: [{path, mime, alt_text, width, height}],
 *     model, area, topic
 *   }
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS service-account → Vertex AI Imagen 3.
 *
 * Standards (from workspace-imager/SKILLS.md):
 *   - Photographic, editorial, never stock-cliché.
 *   - Honor Balinese culture: traditional dress, temple architecture, geography respectful.
 *   - No close-up faces unless explicitly requested (avoid likeness/IP issues).
 *   - Always include the area name in the prompt for visual specificity.
 */
import { GoogleAuth } from "google-auth-library";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import process from "node:process";

const envPath = "/opt/.openclaw-ess/credentials/.env.vertex";
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || "gda-viceroy";
const LOCATION = process.env.GCP_VERTEX_LOCATION || "asia-southeast1";
const IMAGE_MODEL = process.env.GCP_VERTEX_IMAGE_MODEL || "imagen-3.0-generate-002";

// Per-area visual cues — keeps Imagen anchored to the right slice of Bali.
const AREA_CUES = {
  canggu: "Canggu, Bali — black volcanic-sand beach, surfboards, expat cafes, rice paddies meeting coast",
  kuta: "Kuta, Bali — wide pale beach, sunset crowds, beach umbrellas, busy boardwalk",
  ubud: "Ubud, Bali — terraced rice fields, jungle canopy, traditional carved wood, river gorges",
  jimbaran: "Jimbaran, Bali — fishing boats on bay, seafood grills on the sand, evening warm light",
  denpasar: "Denpasar, Bali — urban capital, night markets, traditional pasar, motorbike streets",
  kintamani: "Kintamani, Bali — Mount Batur volcano, crater lake, cool highland mist, lava-rock fields",
  singaraja: "Singaraja, North Bali — quiet northern coast, dolphin boats at Lovina, Dutch colonial buildings",
  "nusa-penida": "Nusa Penida, Bali — dramatic limestone cliffs, turquoise sea, Kelingking T-Rex viewpoint",
};

const TOPIC_CUES = {
  events: "lively scene of people gathered, banners or stage subtly visible, festival atmosphere",
  news: "documentary-style street photography, candid local life, no posed subjects",
  featured: "wide editorial establishing shot, cinematic, golden-hour light",
  dine: "close-up Indonesian food on woven tray or wooden table, steam, warm tungsten light, shallow depth of field",
  "health-wellness": "calm spa or yoga scene, soft natural light, plants, traditional Balinese textiles",
  nightlife: "dusk-to-evening venue, string lights, glassware on bar, warm atmospheric haze",
  activities: "person mid-activity (surfing, hiking, diving) in motion, dynamic angle, natural daylight",
  "people-culture": "respectful portrait of traditional ceremony or craft, ceremonial dress, no faces in tight close-up",
};

const NEGATIVE = [
  "watermarks", "text overlays", "logos", "blurry", "low quality",
  "stock-photo cliché", "ai-generated face artifacts", "extra fingers",
  "western tourists in close-up", "religious imagery used disrespectfully",
];

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

function buildPrompt({ area, topic, title, summary, persona }) {
  const areaCue = AREA_CUES[area] || `${area}, Bali`;
  const topicCue = TOPIC_CUES[topic] || "";
  const personaHint =
    persona === "maya" ? "foodie editorial, close-up food and hands" :
    persona === "komang" ? "outdoor activity editorial, natural environment" :
    persona === "putu" ? "cultural anthropology, respectful documentary tone" :
    persona === "sari" ? "after-dark editorial, motion and atmosphere" :
    "Bali lifestyle editorial";

  return [
    `${title}.`,
    summary ? `${summary}.` : "",
    `Setting: ${areaCue}.`,
    topicCue ? `Composition: ${topicCue}.` : "",
    `Style: ${personaHint}, photographic, magazine-quality, natural light, no text, no logos.`,
  ]
    .filter(Boolean)
    .join(" ");
}

async function callImagen({ prompt, negative, count, aspectRatio }) {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp.token;
  if (!token) throw new Error("Failed to obtain GCP access token");

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${IMAGE_MODEL}:predict`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: count,
        aspectRatio,
        negativePrompt: negative,
        addWatermark: false,
        safetyFilterLevel: "block_some",
        personGeneration: "allow_adult",
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vertex Imagen failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const preds = data.predictions || [];
  if (!preds.length) throw new Error("Imagen returned 0 predictions");
  return preds.map((p) => ({
    b64: p.bytesBase64Encoded,
    mime: p.mimeType || "image/png",
  }));
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function readStdinIfPresent() {
  if (process.stdin.isTTY) return null;
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim() ? JSON.parse(s) : null;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stdinJson = await readStdinIfPresent();
  const input = { ...flags, ...(stdinJson || {}) };

  if (!input.area || !input.topic || !input.title) {
    console.error("missing required: area, topic, title");
    process.exit(1);
  }

  const inlineN = input.inline ? Math.min(Number(input.inline) || 0, 4) : 0;
  const aspectRatio = inlineN > 0 ? "1:1" : "16:9";
  const count = inlineN > 0 ? inlineN : 1;

  const prompt = buildPrompt(input);
  const negative = [NEGATIVE.join(", "), input.negative].filter(Boolean).join(", ");

  const out_dir = input.out_dir || "/tmp";
  if (!existsSync(out_dir)) mkdirSync(out_dir, { recursive: true });
  const base = input.filename_base || slugify(input.title);

  const images = await callImagen({ prompt, negative, count, aspectRatio });

  const files = images.map((img, i) => {
    const fname =
      count === 1 ? `${base}-hero.png` : `${base}-inline-${i + 1}.png`;
    const path = resolve(join(out_dir, fname));
    const buf = Buffer.from(img.b64, "base64");
    writeFileSync(path, buf);
    // Read true dimensions from PNG IHDR (bytes 16..23 are width+height big-endian).
    let w = 0, h = 0;
    if (buf.length > 24 && buf.slice(1, 4).toString() === "PNG") {
      w = buf.readUInt32BE(16);
      h = buf.readUInt32BE(20);
    }
    return {
      path,
      mime: img.mime,
      width: w,
      height: h,
      alt_text: `${input.title} — ${input.area} ${input.topic} editorial photograph`,
    };
  });

  console.log(JSON.stringify({
    area: input.area,
    topic: input.topic,
    title: input.title,
    persona: input.persona || null,
    model: IMAGE_MODEL,
    aspect_ratio: aspectRatio,
    prompt,
    negative_prompt: negative,
    files,
  }, null, 2));
}

main().catch((e) => {
  console.error("ERR:", e?.message || e);
  process.exit(1);
});
