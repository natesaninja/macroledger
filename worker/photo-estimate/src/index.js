/**
 * MacroLedger free photo → macros proxy (Cloudflare Worker)
 *
 * Secrets: GEMINI_API_KEY
 * Optional vars: MODEL, PER_IP_DAILY, GLOBAL_DAILY
 *
 * Deploy:
 *   cd worker/photo-estimate
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler deploy
 */

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
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

/** Cache API rate counters (no KV writes required). */
async function getCount(cache, keyUrl) {
  const hit = await cache.match(keyUrl);
  if (!hit) return 0;
  const n = parseInt(await hit.text(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function setCount(cache, keyUrl, n) {
  // ~26h TTL so counters reset next calendar day roughly
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
        error: `Free limit for this device: ${perIp} photo scans/day. Try again tomorrow.`,
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
        error: "Shared free photo scans are used up for today. Try again tomorrow.",
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

function parseGeminiJson(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

async function callGemini(env, imageBase64, mimeType) {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    return { ok: false, status: 500, body: { error: "Server missing GEMINI_API_KEY", code: "config" } };
  }
  const model = env.MODEL || DEFAULT_MODEL;
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
                data: imageBase64,
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
    const msg = data?.error?.message || `Gemini error ${res.status}`;
    return {
      ok: false,
      status: res.status === 429 ? 429 : 502,
      body: {
        error: res.status === 429 ? "AI free quota hit. Try again later today." : msg,
        code: res.status === 429 ? "gemini_limit" : "gemini_error",
      },
    };
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    return { ok: false, status: 502, body: { error: "Empty AI response", code: "empty" } };
  }

  try {
    const parsed = parseGeminiJson(text);
    return { ok: true, parsed };
  } catch {
    return {
      ok: false,
      status: 502,
      body: { error: "Could not parse AI JSON", code: "parse", raw: text.slice(0, 400) },
    };
  }
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
          per_ip_daily: parseInt(env.PER_IP_DAILY || String(DEFAULT_PER_IP), 10),
          global_daily: parseInt(env.GLOBAL_DAILY || String(DEFAULT_GLOBAL), 10),
        },
        200,
        origin
      );
    }

    if (request.method !== "POST" || !url.pathname.endsWith("/estimate")) {
      return json({ error: "POST /estimate with { imageBase64, mimeType }" }, 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, origin);
    }

    const imageBase64 = body.imageBase64 || body.base64 || "";
    const mimeType = body.mimeType || body.mime_type || "image/jpeg";
    if (!imageBase64 || imageBase64.length < 100) {
      return json({ error: "imageBase64 required" }, 400, origin);
    }
    // ~4MB base64 guard
    if (imageBase64.length > 5_500_000) {
      return json({ error: "Image too large. Compress and retry." }, 413, origin);
    }

    const limits = await checkAndBumpLimits(env, request);
    if (!limits.ok) return json(limits.body, limits.status, origin);

    const gem = await callGemini(env, imageBase64, mimeType);
    if (!gem.ok) return json(gem.body, gem.status, origin);

    const items = Array.isArray(gem.parsed?.items) ? gem.parsed.items : [];
    return json(
      {
        items,
        notes: gem.parsed?.notes || "",
        remaining: limits.remaining,
        free: true,
      },
      200,
      origin
    );
  },
};
