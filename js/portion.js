/**
 * Household / batch cooking — log only your share of the pot.
 * factor = myShare / cookedFor  (e.g. cooked 4, I ate 1 → 0.25)
 */

export function clampPortion(n, fallback = 1) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return fallback;
  return Math.min(99, Math.max(0.25, x));
}

export function portionFactor(cookedFor, myShare) {
  const c = clampPortion(cookedFor, 1);
  const m = clampPortion(myShare, 1);
  return m / c;
}

export function readPortionInputs(root = document) {
  const cookedEl = root.querySelector?.("#portion-cooked") || document.getElementById("portion-cooked");
  const mineEl = root.querySelector?.("#portion-mine") || document.getElementById("portion-mine");
  // Per-modal overrides
  const cookedReview = document.getElementById("portion-cooked-review");
  const mineReview = document.getElementById("portion-mine-review");
  const cookedAdd = document.getElementById("portion-cooked-add");
  const mineAdd = document.getElementById("portion-mine-add");
  const cookedRb = document.getElementById("portion-cooked-rb");
  const mineRb = document.getElementById("portion-mine-rb");

  // Prefer the visible modal's fields if present
  let cooked = 1;
  let mine = 1;
  if (cookedReview && mineReview && !document.getElementById("review-modal")?.hidden) {
    cooked = cookedReview.value;
    mine = mineReview.value;
  } else if (cookedAdd && mineAdd && !document.getElementById("add-modal")?.hidden) {
    cooked = cookedAdd.value;
    mine = mineAdd.value;
  } else if (cookedRb && mineRb) {
    cooked = cookedRb.value;
    mine = mineRb.value;
  } else if (cookedEl && mineEl) {
    cooked = cookedEl.value;
    mine = mineEl.value;
  }

  const cookedFor = clampPortion(cooked, 1);
  const myShare = clampPortion(mine, 1);
  return {
    cookedFor,
    myShare,
    factor: portionFactor(cookedFor, myShare),
    isFull: cookedFor === myShare,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Scale a nutrition object (diary line, draft, or food×servings already applied). */
export function scaleMacros(obj, factor) {
  if (!obj || factor === 1) return { ...obj };
  const f = Number(factor) || 1;
  const out = { ...obj };
  for (const k of ["calories", "protein", "carbs", "fat", "fiber", "sodium_mg", "sugar_g"]) {
    if (out[k] != null) out[k] = round2(out[k] * f);
  }
  if (out.servings != null) out.servings = round2((Number(out.servings) || 1) * f);
  return out;
}

export function scaleItemList(items, factor) {
  if (!Array.isArray(items)) return [];
  if (factor === 1) return items.map((i) => ({ ...i }));
  return items.map((i) => scaleMacros(i, factor));
}

export function portionHint(cookedFor, myShare) {
  const c = clampPortion(cookedFor, 1);
  const m = clampPortion(myShare, 1);
  if (c === m) return "Logging the full amount (no split).";
  const pct = Math.round((m / c) * 100);
  return `Logging ${m} of ${c} shares (~${pct}% of the pot).`;
}
