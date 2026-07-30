/**
 * Ledger Points — a Weight Watchers–style single number for food.
 *
 * Not affiliated with WeightWatchers / WW. Formula is open and on-device only.
 *
 * Rules of thumb (why it feels like WW):
 *  - More protein → fewer points (fill up cheaper)
 *  - More fat / sugar / calories → more points
 *  - Fiber shaves a little off (capped so high-fiber junk can't go negative)
 *
 * foodPoints ≈ cal/50 + fat/12 + sugar/25 − protein/10 − min(fiber,4)/5
 */

/** @param {object} n nutrition grams / calories */
export function foodPoints(n = {}) {
  const cal = Math.max(0, Number(n.calories) || 0);
  const protein = Math.max(0, Number(n.protein) || 0);
  const fat = Math.max(0, Number(n.fat) || 0);
  const fiber = Math.max(0, Number(n.fiber) || 0);
  const sugar = Math.max(0, Number(n.sugar_g != null ? n.sugar_g : n.sugar) || 0);
  const fiberCredit = Math.min(fiber, 4);

  const raw = cal / 50 + fat / 12 + sugar / 25 - protein / 10 - fiberCredit / 5;
  // Whole numbers for WW-like feel; half-points when under 1 for tiny bites
  if (raw <= 0) return 0;
  if (raw < 1) return Math.round(raw * 2) / 2;
  return Math.round(raw);
}

/** Activity earn-back (optional). ~1 point per 100 kcal burned. */
export function exercisePoints(burnedCal, enabled = true) {
  if (!enabled) return 0;
  const b = Math.max(0, Number(burnedCal) || 0);
  return Math.floor(b / 100);
}

/**
 * Daily budget.
 * - Manual points_budget wins when set
 * - Else derived from calorie goal (~1 point per 50 kcal → 2000 cal ≈ 40 pts)
 */
export function dailyPointsBudget(settings = {}, goals = {}) {
  const manual = settings.points_budget;
  if (manual != null && String(manual).trim() !== "") {
    const n = parseFloat(manual);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const cals = Number(goals.calories) || parseFloat(settings.calorie_goal) || 2000;
  // Slightly leaner than cal/50 for lose goals
  const goalType = settings.goal_type || "maintain";
  let budget = cals / 50;
  if (goalType === "lose") budget *= 0.9;
  if (goalType === "gain") budget *= 1.05;
  return Math.max(15, Math.round(budget));
}

export function sumFoodPoints(items = []) {
  return items.reduce((s, it) => s + foodPoints(it), 0);
}

/**
 * Full day snapshot for the diary card.
 * @param {object} opts
 * @param {object[]} opts.entries diary rows with nutrition
 * @param {number} opts.burned exercise kcal
 * @param {object} opts.settings
 * @param {object} opts.goals
 */
export function dayPointsSummary({ entries = [], burned = 0, settings = {}, goals = {} } = {}) {
  const enabled = settings.points_enabled !== "0";
  const earnEx = settings.points_from_exercise !== "0";
  const budget = dailyPointsBudget(settings, goals);
  const used = sumFoodPoints(entries);
  const earned = exercisePoints(burned, earnEx);
  const remaining = budget - used + earned;
  const weeklyFlex = Math.round(budget * 0.5); // soft weekly cushion (info only)
  return {
    enabled,
    budget,
    used: Math.round(used * 10) / 10,
    earned,
    remaining: Math.round(remaining * 10) / 10,
    weeklyFlex,
    over: remaining < 0,
    formulaHint:
      "Points rise with calories, fat & sugar; protein and some fiber lower them. Not official WW.",
  };
}

export function formatPoints(n, digits = 0) {
  const x = Number(n) || 0;
  if (digits > 0) return (Math.round(x * 10 ** digits) / 10 ** digits).toFixed(digits);
  // show .5 when present
  if (Math.abs(x - Math.round(x)) > 0.01) return (Math.round(x * 2) / 2).toString();
  return String(Math.round(x));
}

export const POINTS_HELP = {
  title: "Ledger Points",
  blurb:
    "One number like Weight Watchers — easier for some people than juggling every macro. Higher protein foods “cost” fewer points; sweets and greasy food cost more.",
  formula:
    "points ≈ calories÷50 + fat÷12 + sugar÷25 − protein÷10 − min(fiber,4)÷5",
};
