/**
 * MacroLedger photo → macros proxy (Cloudflare Worker)
 *
 * Default: Cloudflare Workers AI (no user keys — ready for non-tech users)
 * Optional: GEMINI_API_KEY secret as fallback
 *
 * Deploy:
 *   cd worker/photo-estimate
 *   npx wrangler deploy
 */

const DEFAULT_WORKERS_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_PER_IP = 5;
const DEFAULT_GLOBAL = 400;

const PROMPT = `You are a nutrition estimator. Look at this food photo only.
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

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function getCount(cache, keyUrl) {
  const hit = await cache.match(keyUrl);
  if (!hit) return 0;
  const n = parseInt(await hit.text(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function setCount(cache, keyUrl, n) {
  await cache.put(
    keyUrl,
    new Response(String(n), {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "max-age=93600",
      },
    })
  );
}

async function checkAndBumpLimits(env, request) {
  const cache = caches.default;
  const day = todayUTC();
  const perIp = parseInt(env.PER_IP_DAILY || String(DEFAULT_PER_IP), 10) || DEFAULT_PER_IP;
  const globalCap = parseInt(env.GLOBAL_DAILY || String(DEFAULT_GLOBAL), 10) || DEFAULT_GLOBAL;
  const ip = clientIp(request);

  const ipKey = new Request(`https://ml-photo-limit.internal/ip/${day}/${ip}`);
  const globalKey = new Request(`https://ml-photo-limit.internal/global/${day}`);

  const [ipCount, globalCount] = await Promise.all([
    getCount(cache, ipKey),
    getCount(cache, globalKey),
  ]);

  if (ipCount >= perIp) {
    return {
      ok: false,
      status: 429,
      body: {
        error: `You've used today's free photo scans (${perIp}). Try again tomorrow — barcode and voice still work.`,
        code: "ip_limit",
        remaining: 0,
      },
    };
  }
  if (globalCount >= globalCap) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "Free photo scans are paused until tomorrow. You can still use barcode, search, or voice.",
        code: "global_limit",
        remaining: 0,
      },
    };
  }

  await Promise.all([
    setCount(cache, ipKey, ipCount + 1),
    setCount(cache, globalKey, globalCount + 1),
  ]);

  return {
    ok: true,
    remaining: Math.max(0, perIp - ipCount - 1),
    globalRemaining: Math.max(0, globalCap - globalCount - 1),
  };
}

function parseNutritionJson(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("parse");
  }
}

function base64ToUint8Array(b64) {
  const pure = String(b64).replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
  const bin = atob(pure);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Cloudflare Workers AI vision — no external API key for users.
 */
async function callWorkersAI(env, imageBase64) {
  if (!env.AI) {
    return { ok: false, status: 500, body: { error: "Photo AI not available right now.", code: "config" } };
  }
  const model = env.WORKERS_AI_MODEL || DEFAULT_WORKERS_MODEL;
  const image = Array.from(base64ToUint8Array(imageBase64));

  try {
    const result = await env.AI.run(model, {
      image,
      prompt: PROMPT,
      max_tokens: 1200,
      temperature: 0.2,
    });

    const text =
      (typeof result === "string" && result) ||
      result?.response ||
      result?.description ||
      result?.result ||
      (Array.isArray(result?.description) ? result.description.join(" ") : "") ||
      "";

    if (!text) {
      return {
        ok: false,
        status: 502,
        body: { error: "Could not read that photo. Try better light or a closer shot.", code: "empty" },
      };
    }

    try {
      const parsed = parseNutritionJson(text);
      return { ok: true, parsed, via: "workers_ai" };
    } catch {
      // Some vision models return prose — wrap as a single uncertain item
      return {
        ok: true,
        parsed: {
          items: [
            {
              name: String(text).slice(0, 80) || "Meal from photo",
              portion: "1 serving",
              calories: 0,
              protein: 0,
              carbs: 0,
              fat: 0,
              fiber: 0,
              confidence: 0.3,
            },
          ],
          notes: "Estimate was incomplete — please edit numbers before saving.",
        },
        via: "workers_ai_prose",
      };
    }
  } catch (e) {
    const msg = e?.message || String(e);
    return {
      ok: false,
      status: 502,
      body: {
        error: "Photo estimate is busy. Try again in a minute, or use barcode / voice.",
        code: "workers_ai_error",
        detail: msg.slice(0, 120),
      },
    };
  }
}

async function callGemini(env, imageBase64, mimeType) {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    return { ok: false, status: 500, body: { error: "Photo AI not configured.", code: "config" } };
  }
  const model = env.GEMINI_MODEL || env.MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: PROMPT },
            {
              inline_data: {
                mime_type: mimeType || "image/jpeg",
                data: String(imageBase64).replace(/^data:image\/[a-zA-Z+]+;base64,/, ""),
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
    return {
      ok: false,
      status: res.status === 429 ? 429 : 502,
      body: {
        error:
          res.status === 429
            ? "Free photo limit hit for now. Try later — barcode and voice still work."
            : "Photo estimate failed. Try again, or use barcode / voice.",
        code: res.status === 429 ? "gemini_limit" : "gemini_error",
      },
    };
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    return { ok: false, status: 502, body: { error: "Could not read that photo. Try again.", code: "empty" } };
  }

  try {
    return { ok: true, parsed: parseNutritionJson(text), via: "gemini" };
  } catch {
    return {
      ok: false,
      status: 502,
      body: { error: "Could not understand the estimate. Try another photo.", code: "parse" },
    };
  }
}

async function estimate(env, imageBase64, mimeType) {
  // Prefer Workers AI (zero setup for app users)
  if (env.AI) {
    const w = await callWorkersAI(env, imageBase64);
    if (w.ok) return w;
    // Fall through to Gemini if configured
    if (env.GEMINI_API_KEY) {
      const g = await callGemini(env, imageBase64, mimeType);
      if (g.ok) return g;
      return w; // prefer first error if both fail
    }
    return w;
  }
  if (env.GEMINI_API_KEY) return callGemini(env, imageBase64, mimeType);
  return {
    ok: false,
    status: 500,
    body: { error: "Photo meal is not available yet. Please try barcode or voice.", code: "config" },
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json(
        {
          ok: true,
          service: "macroledger-photo-estimate",
          free: true,
          ready: Boolean(env.AI || env.GEMINI_API_KEY),
          engine: env.AI ? "workers_ai" : env.GEMINI_API_KEY ? "gemini" : "none",
          per_ip_daily: parseInt(env.PER_IP_DAILY || String(DEFAULT_PER_IP), 10),
          global_daily: parseInt(env.GLOBAL_DAILY || String(DEFAULT_GLOBAL), 10),
        },
        200,
        origin
      );
    }

    if (request.method !== "POST" || !url.pathname.endsWith("/estimate")) {
      return json({ error: "Not found" }, 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Something went wrong. Try again." }, 400, origin);
    }

    const imageBase64 = body.imageBase64 || body.base64 || "";
    const mimeType = body.mimeType || body.mime_type || "image/jpeg";
    if (!imageBase64 || imageBase64.length < 100) {
      return json({ error: "No photo received. Try taking the picture again." }, 400, origin);
    }
    if (imageBase64.length > 5_500_000) {
      return json({ error: "Photo is too large. Step back a bit and try again." }, 413, origin);
    }

    const limits = await checkAndBumpLimits(env, request);
    if (!limits.ok) return json(limits.body, limits.status, origin);

    const result = await estimate(env, imageBase64, mimeType);
    if (!result.ok) return json(result.body, result.status, origin);

    const items = Array.isArray(result.parsed?.items) ? result.parsed.items : [];
    return json(
      {
        items,
        notes: result.parsed?.notes || "",
        remaining: limits.remaining,
        free: true,
        via: result.via || "unknown",
      },
      200,
      origin
    );
  },
};
