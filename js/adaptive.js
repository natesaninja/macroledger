/**
 * Adaptive calorie/macro targets based on weight trend + intake.
 * Sample component structure for weekly adjustment.
 */
import { listWeight, diaryForDate, putDailyTarget, getSettings, setSettings } from "./db.js";
import { metabolismFromSettings } from "./metabolism.js";

function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localISO(dt);
}

/** Linear regression slope of weight over last N logs (lb/day). */
export function weightSlopeLbPerDay(weights) {
  if (!weights || weights.length < 2) return null;
  const pts = [...weights]
    .sort((a, b) => a.log_date.localeCompare(b.log_date))
    .slice(-14);
  if (pts.length < 2) return null;
  const t0 = new Date(pts[0].log_date + "T12:00:00").getTime();
  const xs = pts.map((p) => (new Date(p.log_date + "T12:00:00").getTime() - t0) / 86400000);
  const ys = pts.map((p) => Number(p.weight_lb));
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (!den) return 0;
  return num / den; // lb per day
}

/**
 * Propose new daily calorie goal.
 * @returns {{ current, proposed, delta, reason, macros } | null}
 */
export async function proposeAdaptiveTargets() {
  const settings = await getSettings();
  if (settings.adaptive_enabled === "0") return null;

  const weights = await listWeight(30);
  const slope = weightSlopeLbPerDay(weights); // lb/day
  const current = parseFloat(settings.calorie_goal) || 2000;
  const goal = settings.goal_type || "maintain";

  // Expected weekly change (lb/week)
  const expectedWeekly =
    goal === "lose" ? -0.5 : goal === "gain" ? 0.25 : 0;
  const actualWeekly = slope != null ? slope * 7 : null;

  let delta = 0;
  let reason = "Not enough weight history yet (log weight 2+ times).";

  if (actualWeekly != null) {
    // error: losing slower than expected → more deficit (negative delta cals)
    // 1 lb fat ≈ 3500 kcal → 0.1 lb/week ≈ 50 kcal/day
    const errorWeekly = actualWeekly - expectedWeekly;
    delta = Math.round(errorWeekly * 500); // scale: 0.1 lb/wk → 50 kcal/d
    delta = Math.max(-200, Math.min(200, delta));
    reason =
      goal === "lose"
        ? `Weight change ~${actualWeekly.toFixed(2)} lb/wk (goal ${expectedWeekly}). Adjust ${delta >= 0 ? "+" : ""}${delta} kcal/day.`
        : `Weight trend ~${actualWeekly.toFixed(2)} lb/wk. Suggest ${delta >= 0 ? "+" : ""}${delta} kcal/day.`;
  }

  let proposed = current + delta;
  // safety: never move more than 10% without explicit confirm (we still propose, UI confirms)
  const cap = Math.round(current * 0.1);
  if (Math.abs(proposed - current) > cap) {
    proposed = current + Math.sign(proposed - current) * cap;
    reason += ` (capped to ±10%).`;
  }
  proposed = Math.max(1200, proposed);

  // Macros from metabolism profile when possible
  const meta = await metabolismFromSettings({
    ...settings,
    calorie_goal: String(proposed),
  });
  const proteinPerLb = parseFloat(settings.protein_per_lb) || 0.8;
  const weight = parseFloat(settings.body_weight_lb) || meta?.weight_lb || 0;
  let protein = weight ? Math.round(weight * proteinPerLb) : parseFloat(settings.protein_goal) || 150;
  let fat = weight ? Math.round(Math.max(weight * 0.3, (proposed * 0.25) / 9)) : parseFloat(settings.fat_goal) || 65;
  let carbs = Math.max(0, Math.round((proposed - protein * 4 - fat * 9) / 4));

  // Diet type tweaks
  if (settings.diet_type === "keto") {
    carbs = Math.min(carbs, 40);
    fat = Math.round((proposed - protein * 4 - carbs * 4) / 9);
  } else if (settings.diet_type === "high_protein") {
    protein = Math.round(protein * 1.15);
    carbs = Math.max(0, Math.round((proposed - protein * 4 - fat * 9) / 4));
  }

  return {
    current,
    proposed,
    delta: proposed - current,
    reason,
    macros: { protein, carbs, fat },
    actualWeekly,
    expectedWeekly,
  };
}

export async function applyAdaptiveProposal(proposal, date = null) {
  if (!proposal) return;
  const d = date || localISO(new Date());
  await setSettings({
    calorie_goal: String(proposal.proposed),
    protein_goal: String(proposal.macros.protein),
    carbs_goal: String(proposal.macros.carbs),
    fat_goal: String(proposal.macros.fat),
  });
  await putDailyTarget({
    date: d,
    calorie_goal: proposal.proposed,
    protein_g: proposal.macros.protein,
    carbs_g: proposal.macros.carbs,
    fat_g: proposal.macros.fat,
    source: "adaptive",
    notes: proposal.reason,
  });
}

/** Average intake last N days (for coach / insights). */
export async function avgIntakeLastDays(n = 7) {
  const today = localISO(new Date());
  let sum = 0;
  let days = 0;
  for (let i = 0; i < n; i++) {
    const date = shiftDays(today, -i);
    const entries = await diaryForDate(date);
    if (!entries.length) continue;
    sum += entries.reduce((s, e) => s + (e.calories || 0), 0);
    days++;
  }
  return days ? sum / days : null;
}
