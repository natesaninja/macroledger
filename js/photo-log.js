/**
 * Photo meal logging — compress image, call free limited vision API, return review drafts.
 * Prefer a shared Cloudflare Worker proxy (multi-user). Optional personal Gemini key in Settings.
 */

/** Default shared proxy (Cloudflare Worker). Override in Goals if needed. */
export const DEFAULT_PHOTO_PROXY_URL =
  "https://macroledger-photo-estimate.macroledger-2103.workers.dev";

/** Per-device free daily cap (client-side; Worker also enforces per IP). */
export const CLIENT_DAILY_LIMIT = 5;

const USAGE_KEY = "ml-photo-usage-v1";

const ESTIMATE_PROMPT = `You are a nutrition estimator. Look at this food photo only.
Identify each distinct food item visible. Estimate portion size from plate, utensils, hands, or packaging if visible.
Return JSON only (no markdown) with this exact shape:
{
  "items": [
    {
      "name": "short food name",
      "portion": "estimated amount e.g. 1 cup or 6 oz",
      "calories": 0,
      "protein": 0,
      "carbs": 0,
      "fat": 0,
      "fiber": 0,
      "confidence": 0.0
    }
  ],
  "notes": "optional short note"
}
Rules:
- calories/protein/carbs/fat/fiber are numbers for the full portion shown (not per 100g).
- confidence is 0-1 (lower if blurry, mixed, or hard to portion).
- Include every major item on the plate/bowl. Skip empty plates and pure drinks unless clearly caloric.
- Do not ask questions. Best estimate only. If no food, return {"items":[],"notes":"No food detected"}.`;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getPhotoUsage() {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return { date: todayKey(), count: 0 };
    const o = JSON.parse(raw);
    if (o.date !== todayKey()) return { date: todayKey(), count: 0 };
    return { date: o.date, count: Number(o.count) || 0 };
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function bumpPhotoUsage() {
  const u = getPhotoUsage();
  const next = { date: todayKey(), count: u.count + 1 };
  localStorage.setItem(USAGE_KEY, JSON.stringify(next));
  return next;
}

export function photoScansRemaining(limit = CLIENT_DAILY_LIMIT) {
  const u = getPhotoUsage();
  return Math.max(0, limit - u.count);
}

/** True when a proxy URL or personal Gemini key is available. */
export function isPhotoLogConfigured(settings = {}, defaultProxy = DEFAULT_PHOTO_PROXY_URL) {
  const proxy = String(settings?.photo_proxy_url || defaultProxy || "").trim();
  const key = String(settings?.photo_gemini_key || "").trim();
  return Boolean(proxy || key);
}

/**
 * Resize + JPEG compress for faster free-tier uploads.
 * @param {Blob|File} file
 * @param {{ maxEdge?: number, quality?: number }} opts
 * @returns {Promise<{ blob: Blob, mimeType: string, dataUrl: string, base64: string }>}
 */
export async function compressFoodImage(file, opts = {}) {
  const maxEdge = opts.maxEdge ?? 1280;
  const quality = opts.quality ?? 0.72;
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not compress photo"))),
      "image/jpeg",
      quality
    );
  });

  const dataUrl = await blobToDataUrl(blob);
  const base64 = dataUrl.split(",")[1] || "";
  return { blob, mimeType: "image/jpeg", dataUrl, base64 };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function normalizeItems(payload) {
  let data = payload;
  if (typeof data === "string") {
    const cleaned = data.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    data = JSON.parse(cleaned);
  }
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  return items
    .map((it) => ({
      name: String(it.name || it.food_name || "Food").trim() || "Food",
      portion: String(it.portion || it.serving_size || "1 serving").trim() || "1 serving",
      calories: round1(it.calories),
      protein: round1(it.protein),
      carbs: round1(it.carbs ?? it.carbohydrates),
      fat: round1(it.fat),
      fiber: round1(it.fiber),
      confidence: Math.min(1, Math.max(0.15, Number(it.confidence) || 0.55)),
    }))
    .filter((it) => it.calories > 0 || it.protein > 0 || it.carbs > 0 || it.fat > 0 || it.name);
}

function itemsToDrafts(items, meal) {
  return items.map((it) => ({
    food_id: null,
    food_name: it.name,
    serving_size: it.portion,
    servings: 1,
    calories: it.calories,
    protein: it.protein,
    carbs: it.carbs,
    fat: it.fat,
    fiber: it.fiber,
    meal,
    confidence: it.confidence,
    source: "photo",
    user_verified: false,
    needs_review: it.confidence < 0.8,
    note: it.confidence < 0.8 ? "Photo estimate — confirm" : "Photo estimate",
  }));
}

/**
 * @param {File|Blob} file
 * @param {string} meal
 * @param {{ proxyUrl?: string, geminiKey?: string, dailyLimit?: number }} config
 */
export async function estimateMealFromPhoto(file, meal = "lunch", config = {}) {
  if (!file) throw new PhotoLogError("No photo selected", "no_file");
  if (!navigator.onLine) {
    throw new PhotoLogError(
      "Photo macros need internet. Use barcode, search, or voice while offline.",
      "offline"
    );
  }

  const limit = config.dailyLimit ?? CLIENT_DAILY_LIMIT;
  const remaining = photoScansRemaining(limit);
  if (remaining <= 0) {
    throw new PhotoLogError(
      `Free photo scans used up for today (${limit}/day). Try again tomorrow — search & barcode still work.`,
      "client_limit"
    );
  }

  const proxyUrl = (config.proxyUrl || DEFAULT_PHOTO_PROXY_URL || "").trim().replace(/\/$/, "");
  const geminiKey = (config.geminiKey || "").trim();
  if (!proxyUrl && !geminiKey) {
    throw new PhotoLogError(
      "Photo meal isn’t available right now. Try barcode or voice instead.",
      "not_configured"
    );
  }

  const compressed = await compressFoodImage(file);
  let payload;

  if (proxyUrl) {
    payload = await callProxy(proxyUrl, compressed);
  } else {
    payload = await callGeminiDirect(geminiKey, compressed);
  }

  const items = normalizeItems(payload);
  if (!items.length) {
    throw new PhotoLogError(
      payload?.notes || "No food detected in the photo. Try a clearer top-down shot.",
      "empty"
    );
  }

  bumpPhotoUsage();
  return {
    drafts: itemsToDrafts(items, meal),
    remaining: photoScansRemaining(limit),
    notes: payload?.notes || "",
  };
}

async function callProxy(proxyUrl, compressed) {
  const endpoint = proxyUrl.endsWith("/estimate") ? proxyUrl : `${proxyUrl}/estimate`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      imageBase64: compressed.base64,
      mimeType: compressed.mimeType,
    }),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 429) {
    throw new PhotoLogError(
      body?.error ||
        "Free photo limit reached (shared or per-user). Try again tomorrow — other logging still works.",
      "rate_limit"
    );
  }
  if (!res.ok) {
    throw new PhotoLogError(
      body?.error || `Photo estimate failed (${res.status}). Try again later.`,
      "api_error"
    );
  }
  return body;
}

async function callGeminiDirect(apiKey, compressed) {
  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: ESTIMATE_PROMPT },
            {
              inline_data: {
                mime_type: compressed.mimeType,
                data: compressed.base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      (res.status === 429
        ? "Gemini free limit hit. Try again later."
        : `Gemini error (${res.status})`);
    throw new PhotoLogError(msg, res.status === 429 ? "rate_limit" : "api_error");
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new PhotoLogError("Empty response from Gemini", "api_error");
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
  } catch {
    throw new PhotoLogError("Could not parse AI response", "parse_error");
  }
}

export class PhotoLogError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "PhotoLogError";
    this.code = code;
  }
}

/** Exported for Worker reuse / tests */
export { ESTIMATE_PROMPT };
