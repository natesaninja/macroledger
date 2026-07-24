/**
 * Natural-language food logging (v1 dictionary + quantity parser).
 * Always returns draft items with confidence for user review.
 *
 * Example: "I had grilled chicken salad with olive oil and 2 eggs"
 */
import { searchFoods, listFavorites, listRecents } from "./db.js";

const QTY_RE =
  /(\d+\.?\d*)\s*(cups?|cup|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|g|grams?|slices?|piece|pieces|large|medium|small|servings?|bowls?)?/gi;

const CONNECTORS = /\b(and|with|plus|also|then|had|ate|i|a|an|the|some|of|for|my|today|breakfast|lunch|dinner|snack)\b/gi;

/** Alias → search query boost */
const ALIASES = {
  "chicken salad": "chicken breast",
  "grilled chicken": "chicken breast",
  "chicken breast": "chicken breast",
  eggs: "eggs",
  egg: "eggs",
  rice: "white rice",
  "brown rice": "brown rice",
  oatmeal: "oatmeal",
  "olive oil": "olive oil",
  "peanut butter": "peanut butter",
  banana: "banana",
  apple: "apple",
  coffee: "coffee",
  pizza: "pizza",
  salad: "mixed salad greens",
  yogurt: "greek yogurt",
  milk: "2% milk",
  bread: "whole wheat bread",
  pasta: "pasta",
  salmon: "salmon",
  tuna: "tuna",
  avocado: "avocado",
  protein: "protein powder",
  shake: "protein powder",
};

function normalizePhrase(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function extractSegments(text) {
  const cleaned = text.replace(CONNECTORS, " ").replace(/\s+/g, " ").trim();
  // split on commas and "and"
  return cleaned
    .split(/,|\&/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => {
      // further split long parts by known multi-word aliases
      return [part];
    });
}

function parseQuantity(segment) {
  QTY_RE.lastIndex = 0;
  const m = QTY_RE.exec(segment);
  if (!m) return { qty: 1, unit: "", rest: segment };
  const qty = parseFloat(m[1]) || 1;
  const unit = (m[2] || "").toLowerCase();
  const rest = (segment.slice(0, m.index) + " " + segment.slice(m.index + m[0].length)).trim();
  return { qty, unit, rest: rest || segment.replace(m[0], "").trim() };
}

function servingsFromQty(qty, unit, food) {
  // crude: numbers map to servings; "2 eggs" → 2 when food is egg
  if (!unit) return qty;
  if (/tbsp|tablespoon/.test(unit)) return qty; // often 1 tbsp serving
  if (/tsp|teaspoon/.test(unit)) return Math.max(0.25, qty / 3);
  if (/cup/.test(unit)) return qty;
  if (/oz|ounce/.test(unit)) {
    // if serving is "4 oz", scale
    const sm = (food.serving_size || "").match(/([\d.]+)\s*oz/i);
    if (sm) return qty / parseFloat(sm[1]);
    return qty / 4;
  }
  if (/slice|piece/.test(unit)) return qty;
  return qty;
}

async function resolveFood(phrase, preferLists) {
  const norm = normalizePhrase(phrase);
  if (!norm) return null;

  // alias map
  let query = norm;
  for (const [alias, q] of Object.entries(ALIASES)) {
    if (norm.includes(alias)) {
      query = q;
      break;
    }
  }

  // prefer favorites/recents exact-ish match
  for (const list of preferLists) {
    const hit = list.find(
      (f) =>
        normalizePhrase(f.name).includes(query) ||
        query.includes(normalizePhrase(f.name).split(" (")[0])
    );
    if (hit) return { food: hit, confidence: 0.85, via: "recent_or_fav" };
  }

  const results = await searchFoods(query, 8);
  if (!results.length) {
    // try first two words
    const short = query.split(" ").slice(0, 2).join(" ");
    const r2 = await searchFoods(short, 5);
    if (r2[0]) return { food: r2[0], confidence: 0.55, via: "search_fuzzy" };
    return null;
  }
  // prefer starts-with
  const best =
    results.find((f) => normalizePhrase(f.name).startsWith(query)) || results[0];
  const conf = normalizePhrase(best.name).includes(query) ? 0.75 : 0.6;
  return { food: best, confidence: conf, via: "search" };
}

/**
 * @param {string} text
 * @param {string} meal default meal slot
 * @returns {Promise<Array<DraftItem>>}
 */
export async function parseFoodUtterance(text, meal = "lunch") {
  if (!text || !text.trim()) return [];

  const favs = await listFavorites();
  const recents = await listRecents(20);
  const prefer = [favs, recents];

  // Also try full alias multiword on entire string
  const drafts = [];
  const lower = text.toLowerCase();

  // Multi-word alias scan first (greedy longest)
  const aliasKeys = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
  let remaining = lower;
  const matchedSpans = [];

  for (const alias of aliasKeys) {
    if (remaining.includes(alias)) {
      matchedSpans.push(alias);
      remaining = remaining.replace(alias, " ");
    }
  }

  // quantity before alias: "2 eggs"
  for (const alias of matchedSpans) {
    const re = new RegExp(`(\\d+\\.?\\d*)?\\s*${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const m = lower.match(re);
    const qty = m && m[1] ? parseFloat(m[1]) : 1;
    const resolved = await resolveFood(ALIASES[alias] || alias, prefer);
    if (!resolved) {
      drafts.push({
        food_name: alias,
        servings: qty,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        fiber: 0,
        serving_size: "1 serving",
        meal,
        confidence: 0.3,
        source: "nlp",
        user_verified: false,
        needs_review: true,
        note: "Unrecognized — edit or pick a food",
      });
      continue;
    }
    const { food, confidence } = resolved;
    const servings = servingsFromQty(qty, "", food);
    drafts.push(scaleFoodDraft(food, servings, meal, confidence, "nlp"));
  }

  // If nothing matched aliases, fall back to segment search
  if (!drafts.length) {
    const segments = extractSegments(text);
    for (const seg of segments) {
      const { qty, unit, rest } = parseQuantity(seg);
      const phrase = rest || seg;
      const resolved = await resolveFood(phrase, prefer);
      if (!resolved) {
        drafts.push({
          food_name: phrase,
          servings: qty,
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          fiber: 0,
          serving_size: "1 serving",
          meal,
          confidence: 0.25,
          source: "nlp",
          user_verified: false,
          needs_review: true,
          note: "Low confidence match",
        });
        continue;
      }
      const servings = servingsFromQty(qty, unit, resolved.food);
      drafts.push(
        scaleFoodDraft(resolved.food, servings, meal, resolved.confidence * 0.9, "nlp")
      );
    }
  }

  return drafts;
}

function scaleFoodDraft(food, servings, meal, confidence, source) {
  return {
    food_id: food.id,
    food_name: food.name,
    serving_size: food.serving_size,
    servings,
    calories: round1(food.calories * servings),
    protein: round1(food.protein * servings),
    carbs: round1(food.carbs * servings),
    fat: round1(food.fat * servings),
    fiber: round1((food.fiber || 0) * servings),
    meal,
    confidence,
    source,
    user_verified: false,
    needs_review: confidence < 0.8,
    note: confidence < 0.8 ? "AI/text estimate — confirm" : "",
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * @deprecated Use estimateMealFromPhoto from photo-log.js
 */
export function parseVisionPlaceholder() {
  return {
    drafts: [],
    message:
      "Use Photo meal on the diary (needs free proxy or Gemini key in Goals). Barcode, search, and voice still work offline.",
  };
}
