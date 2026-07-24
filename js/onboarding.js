/**
 * Onboarding quiz → initial targets
 */
import { setSettings, getSettings } from "./db.js";
import { metabolismFromSettings } from "./metabolism.js";

export const ONBOARDING_STEPS = [
  "welcome",
  "goal",
  "body",
  "activity",
  "diet",
  "review",
];

export function dietProteinPerLb(dietType) {
  switch (dietType) {
    case "high_protein":
      return 1.0;
    case "keto":
      return 0.9;
    case "vegan":
      return 0.8;
    default:
      return 0.8;
  }
}

/**
 * Compute suggested targets from draft profile fields.
 */
export async function computeOnboardingSuggestion(draft) {
  const protein_per_lb = dietProteinPerLb(draft.diet_type || "standard");
  const settingsLike = {
    body_weight_lb: String(draft.body_weight_lb || ""),
    height_in: String(draft.height_in || ""),
    age: String(draft.age || ""),
    sex: draft.sex === "female" ? "female" : "male",
    activity_level: draft.activity_level || "moderate",
    goal_type: draft.goal_type || "maintain",
    protein_per_lb: String(protein_per_lb),
    diet_type: draft.diet_type || "standard",
  };
  const meta = await metabolismFromSettings(settingsLike);
  if (!meta) {
    return {
      ok: false,
      error: "Enter your weight to calculate targets.",
    };
  }
  let { target_calories, suggested_macros, bmr, tdee } = meta;
  if (draft.diet_type === "keto") {
    suggested_macros = {
      protein: suggested_macros.protein,
      carbs: Math.min(40, suggested_macros.carbs),
      fat: Math.round(
        (target_calories - suggested_macros.protein * 4 - Math.min(40, suggested_macros.carbs) * 4) / 9
      ),
    };
  }
  return {
    ok: true,
    bmr,
    tdee,
    target_calories,
    suggested_macros,
    protein_per_lb,
  };
}

export async function completeOnboarding(draft, suggestion) {
  await setSettings({
    user_name: draft.user_name || "You",
    body_weight_lb: draft.body_weight_lb,
    height_in: draft.height_in || "",
    age: draft.age || "",
    sex: draft.sex === "female" ? "female" : "male",
    activity_level: draft.activity_level || "moderate",
    goal_type: draft.goal_type || "maintain",
    diet_type: draft.diet_type || "standard",
    macro_mode: draft.macro_mode || "beginner",
    protein_per_lb: String(suggestion.protein_per_lb || 0.8),
    calorie_goal: String(suggestion.target_calories),
    protein_goal: String(suggestion.suggested_macros.protein),
    carbs_goal: String(suggestion.suggested_macros.carbs),
    fat_goal: String(suggestion.suggested_macros.fat),
    targets_confirmed: "1",
    onboarding_complete: "1",
    adaptive_enabled: "1",
  });
  return getSettings();
}

export async function needsOnboarding() {
  const s = await getSettings();
  if (s.onboarding_complete === "1") return false;
  // Existing v1 users who already set weight: don't force quiz again
  if (s.body_weight_lb && String(s.body_weight_lb).trim() !== "") {
    await setSettings({ onboarding_complete: "1" });
    return false;
  }
  return true;
}

/**
 * If the user has body stats but is still on the factory 2000-cal default,
 * compute and save personalized targets once. Fixes devices that skipped
 * onboarding or hit the old "Apply suggested" bug.
 * Respects targets_confirmed so intentional 2000 is never re-overwritten.
 */
export async function ensurePersonalizedCalorieGoal() {
  const s = await getSettings();
  if (s.targets_confirmed === "1") {
    return { applied: false, reason: "confirmed" };
  }
  const weight = String(s.body_weight_lb || "").trim();
  if (!weight) return { applied: false, reason: "no_weight" };
  const cal = String(s.calorie_goal || "").trim();
  if (cal && cal !== "2000") {
    // Custom number already — mark confirmed so we don't keep rechecking
    await setSettings({ targets_confirmed: "1" });
    return { applied: false, reason: "already_custom" };
  }

  const meta = await metabolismFromSettings(s);
  if (!meta?.target_calories) return { applied: false, reason: "no_meta" };

  await setSettings({
    calorie_goal: String(meta.target_calories),
    protein_goal: String(meta.suggested_macros.protein),
    carbs_goal: String(meta.suggested_macros.carbs),
    fat_goal: String(meta.suggested_macros.fat),
    targets_confirmed: "1",
  });
  return {
    applied: true,
    target_calories: meta.target_calories,
    from: 2000,
  };
}
