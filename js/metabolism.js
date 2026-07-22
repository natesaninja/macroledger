import { ACTIVITY_FACTORS, EXERCISE_METS } from "./seed-foods.js";
import { latestWeight } from "./db.js";

export function calcBmr(weightLb, heightIn, age, sex) {
  const kg = weightLb * 0.453592;
  const cm = heightIn * 2.54;
  const base = 10 * kg + 6.25 * cm - 5 * age;
  if (sex === "female") return base - 161;
  return base + 5; // male (default)
}

export async function resolveWeightLb(settings) {
  const log = await latestWeight();
  if (log) return Number(log.weight_lb);
  if (settings.body_weight_lb) return parseFloat(settings.body_weight_lb);
  return null;
}

export async function metabolismFromSettings(settings) {
  const weight = await resolveWeightLb(settings);
  if (!weight || weight <= 0) return null;
  const height = parseFloat(settings.height_in) || 67;
  const age = parseInt(settings.age, 10) || 30;
  const sex = settings.sex === "female" ? "female" : "male";
  const activity =
    settings.activity_level in ACTIVITY_FACTORS
      ? settings.activity_level
      : "moderate";
  const goal = ["lose", "maintain", "gain"].includes(settings.goal_type)
    ? settings.goal_type
    : "maintain";
  const proteinPerLb = parseFloat(settings.protein_per_lb) || 0.8;

  const bmr = calcBmr(weight, height, age, sex);
  const tdee = bmr * ACTIVITY_FACTORS[activity];
  let target = tdee;
  if (goal === "lose") target = tdee - 500;
  if (goal === "gain") target = tdee + 300;
  target = Math.max(1200, target);

  const protein = weight * proteinPerLb;
  const fat = Math.max(weight * 0.3, (target * 0.25) / 9);
  const carbs = Math.max(0, (target - protein * 4 - fat * 9) / 4);

  return {
    weight_lb: Math.round(weight * 10) / 10,
    height_in: height,
    age,
    sex,
    activity_level: activity,
    goal_type: goal,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    target_calories: Math.round(target),
    suggested_macros: {
      protein: Math.round(protein),
      carbs: Math.round(carbs),
      fat: Math.round(fat),
    },
    using_height_fallback: !settings.height_in,
    using_age_fallback: !settings.age,
  };
}

export function estimateExerciseCalories(activity, durationMin, weightLb) {
  let met = EXERCISE_METS[activity];
  let name = activity;
  if (met == null) {
    for (const [n, m] of Object.entries(EXERCISE_METS)) {
      if (
        n.toLowerCase().includes(activity.toLowerCase()) ||
        activity.toLowerCase().includes(n.toLowerCase())
      ) {
        met = m;
        name = n;
        break;
      }
    }
  }
  if (met == null) met = 5;
  if (!weightLb || weightLb <= 0) {
    return { activity: name, met, calories: null, weight_lb: null };
  }
  const kg = weightLb * 0.453592;
  const calories = Math.round((met * 3.5 * kg) / 200 * durationMin);
  return { activity: name, met, calories, weight_lb: weightLb, duration_min: durationMin };
}

export function burnPlan(goals, foodCals, burned, weightLb, meta) {
  const burnToHit = Math.max(0, foodCals - goals.calories - burned);
  const remaining = goals.calories - foodCals + burned;
  const result = {
    burn_to_hit_goal: Math.round(burnToHit),
    remaining: Math.round(remaining * 10) / 10,
    weight_lb: weightLb,
    tdee: meta ? meta.tdee : null,
    bmr: meta ? meta.bmr : null,
    target_calories: meta ? meta.target_calories : null,
    walk_minutes_to_hit_goal: null,
    message: "",
  };
  if (weightLb && burnToHit > 0) {
    const kg = weightLb * 0.453592;
    const kcalPerMin = (3.5 * 3.5 * kg) / 200;
    result.walk_minutes_to_hit_goal = Math.round(burnToHit / kcalPerMin);
  }
  if (burnToHit <= 0) {
    result.message = "You're within your calorie goal — no extra burn required.";
  } else if (result.walk_minutes_to_hit_goal != null) {
    result.message = `Burn ~${result.burn_to_hit_goal} cal to get back to goal (≈${result.walk_minutes_to_hit_goal} min walk at your weight).`;
  } else {
    result.message = `Burn ~${result.burn_to_hit_goal} cal to get back to goal. Set weight in Goals for walk estimates.`;
  }
  return result;
}
