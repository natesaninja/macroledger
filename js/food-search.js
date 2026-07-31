/**
 * Online food search — Open Food Facts (free, no API key).
 * Returns normalized foods with macros so the user never has to look them up.
 */

const OFF_SEARCH =
  "https://world.openfoodfacts.org/cgi/search.pl";
const UA = "MacroLedger/1.0 (https://github.com/natesaninja/macroledger)";

function num(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 10) / 10;
  }
  return 0;
}

/**
 * Map an Open Food Facts product JSON → MacroLedger food shape.
 * Prefers per-serving when available; else per 100g.
 */
export function productToFood(p) {
  if (!p) return null;
  const n = p.nutriments || {};
  let serving = String(p.serving_size || "").trim();
  let cal = n["energy-kcal_serving"];
  let protein = n.proteins_serving;
  let carbs = n.carbohydrates_serving;
  let fat = n.fat_serving;
  let fiber = n.fiber_serving;
  let sugar = n.sugars_serving;
  let sodium = n.sodium_serving;

  const hasServingMacros = cal != null || protein != null || carbs != null || fat != null;
  if (!hasServingMacros) {
    serving = serving || "100g";
    cal = n["energy-kcal_100g"] ?? n["energy-kcal"];
    protein = n.proteins_100g;
    carbs = n.carbohydrates_100g;
    fat = n.fat_100g;
    fiber = n.fiber_100g;
    sugar = n.sugars_100g;
    sodium = n.sodium_100g;
    // sodium often in g → mg
    if (sodium != null && Number(sodium) < 5) sodium = Number(sodium) * 1000;
  } else if (!serving) {
    serving = "1 serving";
  }

  const name = String(p.product_name || p.product_name_en || p.generic_name || "").trim();
  if (!name) return null;

  const calories = num(cal);
  // Skip junk rows with no energy at all
  if (calories <= 0 && num(protein) <= 0 && num(carbs) <= 0 && num(fat) <= 0) return null;

  return {
    name: name.slice(0, 200),
    brand: String((p.brands || "").split(",")[0] || "").trim().slice(0, 80),
    serving_size: serving.slice(0, 80) || "1 serving",
    calories,
    protein: num(protein),
    carbs: num(carbs),
    fat: num(fat),
    fiber: num(fiber),
    sugar_g: num(sugar),
    sodium_mg: num(sodium),
    barcode: String(p.code || p._id || "").replace(/\D/g, ""),
    source: "openfoodfacts",
    is_custom: true,
    confidence: 0.75,
    verified: false,
    offline_id: `off_${p.code || p._id || name}`,
  };
}

/**
 * Search Open Food Facts by food name (needs internet).
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function searchOpenFoodFacts(query, limit = 12) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  if (!navigator.onLine) return [];

  const url =
    `${OFF_SEARCH}?search_terms=${encodeURIComponent(q)}` +
    `&search_simple=1&action=process&json=1` +
    `&page_size=${Math.min(30, Math.max(5, limit))}` +
    `&fields=code,product_name,product_name_en,generic_name,brands,serving_size,nutriments`;

  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();
  const products = Array.isArray(data.products) ? data.products : [];
  const out = [];
  const seen = new Set();
  for (const p of products) {
    const food = productToFood(p);
    if (!food) continue;
    const key = `${food.brand}|${food.name}|${food.serving_size}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(food);
    if (out.length >= limit) break;
  }
  return out;
}
