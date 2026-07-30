/**
 * Ledger Points — aligned to the community reverse-engineered
 * Weight Watchers® SmartPoints / Freestyle food formula (Dec 2015–2021 era).
 *
 * NOT affiliated with or endorsed by WW International / WeightWatchers.
 * Official WW algorithms are proprietary and change over time (2022+ uses
 * a different undisclosed mix of fiber, protein, unsat fat, added sugar, sat fat).
 * This matches the widely documented SmartPoints formula so values are usually
 * the same or within ~1 point of the classic WW calculator for labeled foods.
 *
 * Food formula (publicly reverse-engineered):
 *   points = max(0, round(
 *     calories × 0.0305
 *   + satFat_g × 0.275
 *   + sugar_g  × 0.12
 *   − protein_g × 0.098
 *   ))
 *
 * When saturated fat is missing (most of our DB), we estimate:
 *   satFat ≈ totalFat × 0.33  (typical mixed-food ratio)
 * Or use n.sat_fat / n.sat_fat_g / n.saturated_fat when present.
 *
 * Optional Freestyle-style zero-point foods (eggs, lean chicken, fish, fruit,
 * veg, nonfat yogurt, etc.) when points_zero_foods is on.
 */

/** SmartPoints coefficients (community reverse-engineered) */
export const SP = {
  calories: 0.0305,
  satFat: 0.275,
  sugar: 0.12,
  protein: 0.098,
};

/**
 * Estimate saturated fat grams when the label doesn't list it.
 * ~1/3 of total fat is a common mixed-diet approximation.
 */
export function estimateSatFat(n = {}) {
  const explicit =
    n.sat_fat ?? n.sat_fat_g ?? n.saturated_fat ?? n.saturated_fat_g ?? n.satFat;
  if (explicit != null && String(explicit).trim() !== "") {
    const v = Number(explicit);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const fat = Math.max(0, Number(n.fat) || 0);
  // Slightly higher sat estimate for dairy/meat-ish names if we have a name
  const name = String(n.food_name || n.name || "").toLowerCase();
  let ratio = 0.33;
  if (/\b(butter|cheese|cream|bacon|sausage|beef|pork|lamb|coconut)\b/.test(name)) {
    ratio = 0.45;
  } else if (/\b(oil|olive|avocado|nuts|almond|peanut|salmon)\b/.test(name)) {
    ratio = 0.15;
  } else if (/\b(chicken|turkey|fish|egg)\b/.test(name)) {
    ratio = 0.28;
  }
  return Math.round(fat * ratio * 10) / 10;
}

/**
 * Freestyle-era style zero-point foods (approximate list).
 * Only applied when settings.points_zero_foods !== "0".
 * Mixed dishes / restaurant builds should NOT zero out via this alone.
 */
export function isZeroPointFood(n = {}) {
  const name = String(n.food_name || n.name || "").toLowerCase().trim();
  if (!name) return false;

  // Skip obvious mixed/processed
  if (
    /\b(fried|breaded|nugget|patty|burger|sandwich|wrap|pizza|taco|burrito|casserole|soup|sauce|dressing|cookie|cake|chip|fries|bacon|sausage|hot dog|cheese)\b/.test(
      name
    )
  ) {
    return false;
  }

  // Lean proteins (skinless poultry, eggs, most fish/shellfish, tofu, nonfat dairy)
  if (
    /\b(egg white|eggs?\b|egg\b)/.test(name) &&
    !/\b(deviled|salad|mayo|fried)\b/.test(name)
  ) {
    return true;
  }
  if (
    /\b(chicken breast|turkey breast|skinless chicken|ground turkey 99|extra lean turkey)\b/.test(
      name
    )
  ) {
    return true;
  }
  if (
    /\b(cod|tilapia|haddock|halibut|sole|flounder|shrimp|prawn|crab|lobster|scallop|tuna.*water|canned tuna|salmon)\b/.test(
      name
    ) &&
    !/\b(smoked salmon|lox|oil|mayo|salad)\b/.test(name)
  ) {
    // plain fish/shellfish — freestyle zero; smoked/oil-packed often not
    if (/\b(in oil|oil-packed|smoked)\b/.test(name)) return false;
    return true;
  }
  if (/\b(tofu|tempeh)\b/.test(name) && !/\b(fried|marinated|breadcrumb)\b/.test(name)) {
    return true;
  }
  if (
    /\b(nonfat|fat free|0%|zero fat)\b/.test(name) &&
    /\b(yogurt|greek yogurt|cottage cheese)\b/.test(name)
  ) {
    return true;
  }

  // Most plain fruits (not dried, not juice, not fried)
  if (
    /\b(apple|banana|orange|berry|berries|strawberry|blueberry|raspberry|grape|melon|watermelon|cantaloupe|peach|pear|plum|mango|pineapple|kiwi|cherry|cherries|grapefruit|lemon|lime|fruit)\b/.test(
      name
    ) &&
    !/\b(juice|dried|syrup|candy|pie|smoothie|jam|jelly|canned in syrup)\b/.test(name)
  ) {
    return true;
  }

  // Most non-starchy vegetables
  if (
    /\b(broccoli|spinach|lettuce|kale|cucumber|celery|zucchini|asparagus|cauliflower|cabbage|pepper|bell pepper|tomato|onion|mushroom|carrot|green bean|snap pea|salad greens|mixed greens|vegetable|veggies)\b/.test(
      name
    ) &&
    !/\b(fried|chip|fries|hash|casserole|cream|cheese|butter)\b/.test(name)
  ) {
    return true;
  }

  return false;
}

/**
 * SmartPoints-compatible food points.
 * @param {object} n nutrition
 * @param {object} [opts]
 * @param {boolean} [opts.zeroFoods] apply Freestyle-style zeros
 */
export function foodPoints(n = {}, opts = {}) {
  if (opts.zeroFoods && isZeroPointFood(n)) return 0;

  const cal = Math.max(0, Number(n.calories) || 0);
  const protein = Math.max(0, Number(n.protein) || 0);
  const sugar = Math.max(0, Number(n.sugar_g != null ? n.sugar_g : n.sugar) || 0);
  const sat = estimateSatFat(n);

  // Classic SmartPoints (community formula)
  let raw =
    cal * SP.calories + sat * SP.satFat + sugar * SP.sugar - protein * SP.protein;

  // Floor at 0 like WW
  if (raw < 0) raw = 0;

  // WW displays whole points (round half up)
  return Math.round(raw);
}

/** Raw unrounded value for debugging / comparison */
export function foodPointsRaw(n = {}) {
  const cal = Math.max(0, Number(n.calories) || 0);
  const protein = Math.max(0, Number(n.protein) || 0);
  const sugar = Math.max(0, Number(n.sugar_g != null ? n.sugar_g : n.sugar) || 0);
  const sat = estimateSatFat(n);
  return cal * SP.calories + sat * SP.satFat + sugar * SP.sugar - protein * SP.protein;
}

/**
 * Activity / FitPoints-style earn-back.
 * WW FitPoints are separate; we keep a simple ~1 food-point per 100 kcal burned
 * when points_from_exercise is on (common offline approximation).
 */
export function exercisePoints(burnedCal, enabled = true) {
  if (!enabled) return 0;
  const b = Math.max(0, Number(burnedCal) || 0);
  return Math.floor(b / 100);
}

/**
 * Daily points budget — WW Freestyle–style personalization (approx).
 * Official WW uses a proprietary table from sex, age, height, weight.
 * We approximate so typical budgets land ~23–40 like the app.
 *
 * Manual points_budget always wins.
 */
export function dailyPointsBudget(settings = {}, goals = {}) {
  const manual = settings.points_budget;
  if (manual != null && String(manual).trim() !== "") {
    const n = parseFloat(manual);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }

  const sex = String(settings.sex || "female").toLowerCase();
  const weight = parseFloat(settings.body_weight_lb) || 0;
  const age = parseFloat(settings.age) || 0;
  const height = parseFloat(settings.height_in) || 0;
  const activity = settings.activity_level || "moderate";
  const goalType = settings.goal_type || "maintain";
  const zeroFoods = settings.points_zero_foods !== "0";

  // Freestyle-like base (lower when zero-point foods are on)
  let pts = sex === "male" || sex === "m" ? 32 : 23;

  if (weight > 0) {
    // Heavier people get more daily points (rough WW behavior)
    pts += Math.round(Math.max(-4, Math.min(12, (weight - 150) / 15)));
  } else {
    // Fall back from calorie goal if no weight
    const cals = Number(goals.calories) || parseFloat(settings.calorie_goal) || 2000;
    pts = Math.round(cals / 70); // ~28 at 2000 with zeros on
  }

  if (age >= 50) pts += 1;
  if (age >= 60) pts += 2;
  if (height >= 70) pts += 1;

  const actBoost = {
    sedentary: 0,
    light: 1,
    moderate: 2,
    active: 4,
    extra: 6,
  };
  pts += actBoost[activity] ?? 2;

  if (goalType === "lose") pts = Math.max(23, pts - 2);
  if (goalType === "gain") pts += 4;

  // Without zero-point foods, people log full protein/fruit points → need more budget
  if (!zeroFoods) {
    pts = Math.round(pts * 1.45);
  }

  // WW daily floor is often 23
  return Math.max(23, Math.min(60, Math.round(pts)));
}

export function sumFoodPoints(items = [], opts = {}) {
  return items.reduce((s, it) => s + foodPoints(it, opts), 0);
}

/**
 * Full day snapshot for the diary card.
 */
export function dayPointsSummary({ entries = [], burned = 0, settings = {}, goals = {} } = {}) {
  const enabled = settings.points_enabled !== "0";
  const earnEx = settings.points_from_exercise !== "0";
  const zeroFoods = settings.points_zero_foods !== "0";
  const opts = { zeroFoods };
  const budget = dailyPointsBudget(settings, goals);
  const used = sumFoodPoints(entries, opts);
  const earned = exercisePoints(burned, earnEx);
  const remaining = budget - used + earned;
  // WW weeklies are often ~14–28; Freestyle commonly 14 or 28
  const weeklyFlex = Math.max(14, Math.round(budget * 0.7));
  return {
    enabled,
    budget,
    used: Math.round(used * 10) / 10,
    earned,
    remaining: Math.round(remaining * 10) / 10,
    weeklyFlex,
    over: remaining < 0,
    zeroFoods,
    formulaHint:
      "SmartPoints-style: calories + sat fat + sugar − protein (community formula). Not official WW.",
  };
}

export function formatPoints(n, digits = 0) {
  const x = Number(n) || 0;
  if (digits > 0) return (Math.round(x * 10 ** digits) / 10 ** digits).toFixed(digits);
  return String(Math.round(x));
}

export const POINTS_HELP = {
  title: "Ledger Points (SmartPoints-matched)",
  blurb:
    "Uses the same reverse-engineered SmartPoints math as classic WW calculators: calories, saturated fat, sugar, and protein. Optional Freestyle-style zero-point foods for eggs, lean chicken, fish, fruit & veg. Not official Weight Watchers.",
  formula:
    "points = round(cal×0.0305 + satFat×0.275 + sugar×0.12 − protein×0.098) · sat fat estimated as ~⅓ total fat when missing",
};
