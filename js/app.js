/**
 * MacroLedger PWA � offline-first UI
 */
import {
  ensureSeeded,
  ensureRestaurantFoods,
  migrateLegacyDatabases,
  getSettings,
  setSettings,
  goalsFromSettings,
  searchFoods,
  addFood,
  deleteFood,
  findByBarcode,
  diaryForDate,
  addDiaryEntry,
  updateDiaryServings,
  deleteDiary,
  copyDiary,
  exerciseForDate,
  addExercise,
  deleteExercise,
  getWater,
  setWater,
  listWeight,
  upsertWeight,
  deleteWeight,
  exportAllJson,
  importAllJson,
  listFavorites,
  listRecents,
  toggleFavorite,
  saveMeal,
  listSavedMeals,
  deleteSavedMeal,
  logSavedMeal,
  getStreak,
  verifyDiaryEntry,
} from "./db.js";
import { SEED_FOODS, RESTAURANT_FOODS } from "./seed-foods.js";
import {
  metabolismFromSettings,
  estimateExerciseCalories,
  burnPlan,
  resolveWeightLb,
} from "./metabolism.js";
import {
  needsOnboarding,
  computeOnboardingSuggestion,
  completeOnboarding,
} from "./onboarding.js";
import { parseFoodUtterance } from "./nlp-log.js";
import {
  estimateMealFromPhoto,
  photoScansRemaining,
  isPhotoLogConfigured,
  DEFAULT_PHOTO_PROXY_URL,
  CLIENT_DAILY_LIMIT,
  PhotoLogError,
} from "./photo-log.js";
import { proposeAdaptiveTargets, applyAdaptiveProposal } from "./adaptive.js";
import { getFastingStatus, fmtDuration, PROTOCOLS, protocolSummary } from "./fasting.js";
import {
  RESTAURANT_BUILDERS,
  sumSelection,
  selectionToLines,
} from "./restaurant-builder.js";

import {
  startScanner,
  stopScanner,
  flipScanner,
  decodeBarcodeFromFile,
  cameraHelp,
} from "./barcode-scan.js";
import {
  loadLocalBackup,
  loadProfileBackup,
  saveProfileBackup,
  scheduleFullBackup,
  markFileBackupSaved,
  daysSinceFileBackup,
  APP_CACHE,
} from "./persist.js";

const MEALS = [
  { id: "breakfast", label: "Breakfast", icon: "" },
  { id: "lunch", label: "Lunch", icon: "" },
  { id: "dinner", label: "Dinner", icon: "" },
  { id: "snacks", label: "Snacks", icon: "" },
];
const CIRC = 2 * Math.PI * 52;

const UI_THEMES = [
  {
    id: "light",
    name: "Paper",
    desc: "Quiet ledger (default)",
    swatches: ["#f6f3ee", "#1f7a54", "#3d5a80"],
  },
  {
    id: "midnight",
    name: "Ink",
    desc: "Warm dark",
    swatches: ["#161412", "#5aad84", "#8eabcc"],
  },
  {
    id: "ocean",
    name: "Slate",
    desc: "Cool paper",
    swatches: ["#eef1f4", "#2f6f8f", "#3d5a80"],
  },
  {
    id: "sunset",
    name: "Dusk",
    desc: "Warm evening",
    swatches: ["#1a1512", "#c47a52", "#d4a85a"],
  },
  {
    id: "contrast",
    name: "High contrast",
    desc: "Max readability",
    swatches: ["#000000", "#39ff14", "#ffffff"],
  },
];

function applyTheme(themeId) {
  const id = UI_THEMES.some((t) => t.id === themeId) ? themeId : "light";
  document.documentElement.setAttribute("data-theme", id);
  // Match browser chrome where supported
  const meta = document.querySelector('meta[name="theme-color"]');
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  if (meta && accent) meta.setAttribute("content", accent);
  updateThemeToggleIcon(id);
  updateBrandLogo(id);
  return id;
}

/** Light paper themes use blue logo; ink/dark themes use green logo. */
function updateBrandLogo(themeId) {
  const img = document.getElementById("brand-logo");
  if (!img) return;
  const light = themeId === "light" || themeId === "ocean";
  const src = light
    ? "icons/logo-mark-light.png?v=25"
    : "icons/logo-mark-dark.png?v=25";
  if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  img.alt = light ? "MacroLedger" : "MacroLedger (dark)";
}

function updateThemeToggleIcon(themeId) {
  const icon = document.getElementById("theme-toggle-icon");
  const btn = document.getElementById("theme-toggle");
  if (!icon || !btn) return;
  // Paper → offer Ink. Dark-ish themes → offer Paper.
  const isLight = themeId === "light" || themeId === "ocean";
  icon.textContent = isLight ? "Ink" : "Paper";
  btn.title = isLight ? "Switch to ink (dark)" : "Switch to paper (light)";
  btn.setAttribute("aria-label", btn.title);
}

async function toggleLightDark() {
  const s = await getSettings();
  const cur = s.ui_theme || "light";
  // Flip between paper and ink; other themes return to paper
  const next = cur === "light" ? "midnight" : "light";
  applyTheme(next);
  renderThemePicker(next);
  await setSettings({ ui_theme: next });
  toast(next === "light" ? "Paper theme" : "Ink theme");
}

function renderThemePicker(activeId) {
  const grid = document.getElementById("theme-grid");
  if (!grid) return;
  const active = activeId || "light";
  grid.innerHTML = UI_THEMES.map(
    (t) => `
    <button type="button" class="theme-card ${t.id === active ? "active" : ""}" data-theme="${t.id}" role="option" aria-selected="${t.id === active}">
      <div class="tc-name">${escapeHtml(t.name)}</div>
      <div class="tc-swatches">${t.swatches.map((c) => `<i style="background:${c}"></i>`).join("")}</div>
    </button>`
  ).join("");
  grid.querySelectorAll(".theme-card").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = applyTheme(btn.dataset.theme);
      renderThemePicker(id);
      await setSettings({ ui_theme: id });
      toast(`${UI_THEMES.find((t) => t.id === id)?.name || id} theme on`);
    });
  });
}

let currentDate = todayISO();
let settings = null;
let selectedFood = null;
let pendingOff = null;
let modalMeal = "breakfast";
let deferredInstall = null;
let scanBusy = false;
let fastingTimerId = null;
let rbState = { builderId: "chipotle", formatId: null, selected: {} };
let reviewDrafts = [];
let onboardStep = 0;
let onboardDraft = {
  user_name: "You",
  goal_type: "lose",
  sex: "male",
  activity_level: "moderate",
  diet_type: "standard",
  macro_mode: "beginner",
  body_weight_lb: "",
  height_in: "",
  age: "",
};
let recipeItems = [];

// ---- helpers ----
function todayISO() {
  const d = new Date();
  return localISO(d);
}
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function shiftDate(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return localISO(d);
}
function formatDateLabel(iso) {
  if (iso === todayISO()) return "Today";
  if (iso === shiftDate(todayISO(), -1)) return "Yesterday";
  return parseISO(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
function formatNum(n, digits = 0) {
  const x = Number(n) || 0;
  return digits === 0 ? Math.round(x).toLocaleString() : x.toFixed(digits);
}
function pct(u, g) {
  return g ? Math.min(100, Math.max(0, (u / g) * 100)) : 0;
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}
function MacroLedgers(p, c, f, opts = {}) {
  return `<div class="macro-chips">
    ${opts.calories != null ? `<span class="chip cal"><span class="chip-l">Cal</span> ${formatNum(opts.calories)}</span>` : ""}
    <span class="chip protein"><span class="chip-l">P</span> ${formatNum(p, 1)}g</span>
    <span class="chip carbs"><span class="chip-l">C</span> ${formatNum(c, 1)}g</span>
    <span class="chip fat"><span class="chip-l">F</span> ${formatNum(f, 1)}g</span>
  </div>`;
}
function downloadBlob(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- online status ----
function updateOnline() {
  const on = navigator.onLine;
  document.getElementById("online-dot").classList.toggle("off", !on);
  document.getElementById("online-label").textContent = on ? "Online" : "Offline";
}

// ---- day load ----
async function loadDay() {
  settings = await getSettings();
  updatePhotoLogStatus();
  const goals = goalsFromSettings(settings);
  const entries = await diaryForDate(currentDate);
  const exercises = await exerciseForDate(currentDate);
  const water = await getWater(currentDate);
  const weightLb = await resolveWeightLb(settings);
  const meta = await metabolismFromSettings(settings);

  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium_mg: 0, sugar_g: 0 };
  const byMeal = { breakfast: [], lunch: [], dinner: [], snacks: [] };
  const mealTotals = {};
  for (const m of MEALS) {
    mealTotals[m.id] = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium_mg: 0, sugar_g: 0 };
  }
  for (const e of entries) {
    byMeal[e.meal]?.push(e);
    for (const k of Object.keys(totals)) {
      totals[k] += Number(e[k]) || 0;
      if (mealTotals[e.meal]) mealTotals[e.meal][k] += Number(e[k]) || 0;
    }
  }
  const burned = exercises.reduce((s, e) => s + (Number(e.calories) || 0), 0);
  const remaining = {
    calories: goals.calories - totals.calories + burned,
    protein: goals.protein - totals.protein,
    carbs: goals.carbs - totals.carbs,
    fat: goals.fat - totals.fat,
    fiber: goals.fiber - totals.fiber,
  };
  const prevDay = shiftDate(currentDate, -1);
  const prevEntries = await diaryForDate(prevDay);
  const prevCounts = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
  for (const e of prevEntries) prevCounts[e.meal] = (prevCounts[e.meal] || 0) + 1;

  const day = {
    goals,
    totals,
    remaining,
    meals: byMeal,
    meal_totals: mealTotals,
    exercises,
    exercise_burned: burned,
    water,
    prev_day: prevDay,
    prev_meal_counts: prevCounts,
    burn_plan: burnPlan(goals, totals.calories, burned, weightLb, meta),
    metabolism: meta,
    user_name: settings.user_name || "You",
  };
  renderDay(day);
}

function renderDay(d) {
  document.getElementById("date-label").textContent = formatDateLabel(currentDate);
  document.getElementById("greeting").textContent = `${d.user_name}'s diary � on device`;

  const rem = d.remaining.calories;
  const over = rem < 0;
  const burned = d.exercise_burned || 0;
  document.getElementById("cal-remaining").textContent = formatNum(Math.abs(rem));
  document.getElementById("cal-remaining-label").textContent = over ? "over" : "remaining";
  document.getElementById("stat-goal").textContent = `${formatNum(d.goals.calories)} cal`;
  document.getElementById("stat-food").textContent = `${formatNum(d.totals.calories)} cal`;
  document.getElementById("stat-exercise").textContent =
    burned > 0 ? `+${formatNum(burned)} cal` : "0 cal";
  document.getElementById("stat-remaining").textContent = `${formatNum(rem)} cal`;
  document.querySelector(".stat.highlight").classList.toggle("over", over);

  const eff = d.goals.calories + burned;
  const used = eff ? Math.min(d.totals.calories / eff, 1) : 0;
  const ring = document.getElementById("cal-ring");
  ring.style.strokeDasharray = String(CIRC);
  ring.style.strokeDashoffset = String(CIRC * (1 - used));
  ring.classList.toggle("over", over && d.totals.calories > 0);

  document.getElementById("macro-bars").innerHTML = ["protein", "carbs", "fat", "fiber"]
    .map((key) => {
      const label = key[0].toUpperCase() + key.slice(1);
      const u = d.totals[key];
      const g = d.goals[key];
      const left = g - u;
      return `<div class="macro ${key}">
        <div class="macro-head"><span>${label}</span><strong>${formatNum(u)} / ${formatNum(g)}g</strong></div>
        <div class="bar"><i style="width:${pct(u, g)}%"></i></div>
        <div class="macro-head" style="margin-top:0.25rem;margin-bottom:0">
          <span style="font-size:0.68rem">${left >= 0 ? formatNum(left) + "g left" : formatNum(Math.abs(left)) + "g over"}</span>
        </div>
      </div>`;
    })
    .join("");

  renderBurn(d);
  renderDensity(d);
  renderMicroBars(d);
  renderFastingCard();
  renderWater(d.water, d.goals.water);
  renderMeals(d);
  renderExercise(d);
  renderQuickRail("recents");
  refreshStreak();

  const prevTotal = Object.values(d.prev_meal_counts).reduce((a, b) => a + b, 0);
  document.getElementById("copy-yesterday-btn").disabled = prevTotal === 0;
}

function renderDensity(d) {
  const cals = d.totals.calories || 0;
  const p = d.totals.protein || 0;
  const goal = d.goals.calories || 1;
  const proteinDensity = cals > 0 ? (p * 4) / cals : 0; // fraction of cals from protein
  const fill = cals / goal;
  let calChip =
    fill < 0.9
      ? `<span class="density-chip green">Calories on track</span>`
      : fill <= 1.05
        ? `<span class="density-chip yellow">Near goal</span>`
        : `<span class="density-chip red">Over goal</span>`;
  let pChip =
    proteinDensity >= 0.25
      ? `<span class="density-chip green">High protein density</span>`
      : proteinDensity >= 0.15
        ? `<span class="density-chip yellow">OK protein density</span>`
        : cals > 0
          ? `<span class="density-chip red">Low protein density</span>`
          : "";
  document.getElementById("density-row").innerHTML = calChip + pChip;
}

async function refreshStreak() {
  const s = await getStreak();
  document.getElementById("streak-chip").textContent = `Streak ${s.current || 0}d`;
  document.getElementById("streak-chip").title = `Best streak: ${s.best || 0} days`;
}

async function renderQuickRail(mode) {
  const rail = document.getElementById("quick-rail");
  const foods = mode === "favs" ? await listFavorites() : await listRecents(12);
  if (!foods.length) {
    rail.innerHTML = `<div class="empty-state" style="padding:0.25rem 0">No ${mode === "favs" ? "favorites" : "recents"} yet � log foods to build this list.</div>`;
    return;
  }
  rail.innerHTML = foods
    .map(
      (f) => `<button type="button" class="quick-pill" data-id="${f.id}">
      <div class="qp-name">${escapeHtml(f.name)}</div>
      <div class="qp-cal">${formatNum(f.calories)} cal � tap to add</div>
    </button>`
    )
    .join("");
  rail.querySelectorAll(".quick-pill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const list = foods;
      const food = list.find((x) => x.id === id);
      if (!food) return;
      await addDiaryEntry({
        entry_date: currentDate,
        meal: guessMealSlot(),
        food_id: food.id,
        food_name: food.name,
        serving_size: food.serving_size,
        servings: 1,
        calories: food.calories,
        protein: food.protein,
        carbs: food.carbs,
        fat: food.fat,
        fiber: food.fiber || 0,
        sodium_mg: food.sodium_mg || 0,
        sugar_g: food.sugar_g || 0,
        source: "quick",
        user_verified: true,
      });
      toast(`Added ${food.name}`);
      loadDay();
    });
  });
}

function guessMealSlot() {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 21) return "dinner";
  return "snacks";
}

function renderBurn(d) {
  const bp = d.burn_plan;
  const meta = d.metabolism;
  document.getElementById("burn-weight-label").textContent = bp.weight_lb
    ? `${bp.weight_lb} lb`
    : "no weight";
  const body = document.getElementById("burn-body");
  if (!bp.weight_lb) {
    body.innerHTML = `<p class="burn-msg">Set your weight in Goals for burn estimates based on your body.</p>`;
    return;
  }
  body.innerHTML = `
    <div class="burn-stats">
      <div class="burn-stat"><span class="bv">${formatNum(bp.burn_to_hit_goal)}</span><span class="bl">cal to burn</span></div>
      <div class="burn-stat"><span class="bv">${bp.walk_minutes_to_hit_goal != null ? bp.walk_minutes_to_hit_goal + "m" : "�"}</span><span class="bl">walk est.</span></div>
      <div class="burn-stat"><span class="bv">${bp.tdee != null ? formatNum(bp.tdee) : "�"}</span><span class="bl">TDEE</span></div>
    </div>
    <p class="burn-msg ${bp.burn_to_hit_goal <= 0 ? "ok" : ""}">${escapeHtml(bp.message)}</p>
    ${
      meta
        ? `<p class="burn-msg" style="margin-top:0.35rem">Plan ~${formatNum(meta.target_calories)} cal � ${MacroLedgers(
            meta.suggested_macros.protein,
            meta.suggested_macros.carbs,
            meta.suggested_macros.fat
          )}</p>`
        : ""
    }
  `;
}

function renderWater(glasses, goal) {
  document.getElementById("water-count").textContent = `${glasses} / ${goal}`;
  const wrap = document.getElementById("water-glasses");
  wrap.innerHTML = "";
  const total = Math.max(goal, glasses, 8);
  for (let i = 1; i <= total; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "glass" + (i <= glasses ? " filled" : "");
    btn.addEventListener("click", async () => {
      const next = i === glasses ? i - 1 : i;
      await setWater(currentDate, next);
      loadDay();
    });
    wrap.appendChild(btn);
  }
}

function renderMeals(d) {
  const root = document.getElementById("meals");
  const prev = d.prev_meal_counts;
  root.innerHTML = MEALS.map((m) => {
    const entries = d.meals[m.id] || [];
    const mt = d.meal_totals[m.id] || {};
    const rows = entries
      .map(
        (e) => `
      <div class="entry">
        <div>
          <div class="entry-name">${escapeHtml(e.food_name)}${
            e.user_verified === false || (e.confidence != null && e.confidence < 0.8)
              ? `<span class="flag-uncertain">? review</span>`
              : ""
          }${e.source && e.source !== "manual" ? `<span class="badge">${escapeHtml(e.source)}</span>` : ""}</div>
          <div class="entry-meta">${formatNum(e.servings, 2)} � ${escapeHtml(e.serving_size)}</div>
          ${MacroLedgers(e.protein, e.carbs, e.fat, { calories: e.calories })}
        </div>
        <div class="entry-cals">${formatNum(e.calories)}</div>
        <div class="entry-actions">
          ${
            e.user_verified === false
              ? `<button type="button" class="verify" data-id="${e.id}" title="Confirm">OK</button>`
              : ""
          }
          ${
            e.food_id
              ? `<button type="button" class="fav" data-id="${e.food_id}" title="Favorite">Fav</button>`
              : ""
          }
          <button type="button" class="edit-serv" data-id="${e.id}" data-s="${e.servings}" title="Edit servings">Edit</button>
          <button type="button" class="del" data-id="${e.id}" title="Remove">Del</button>
        </div>
      </div>`
      )
      .join("");
    const mealMacros =
      entries.length > 0
        ? `<div class="meal-macro-row">${MacroLedgers(mt.protein, mt.carbs, mt.fat, {
            calories: mt.calories,
          })}</div>`
        : "";
    return `<article class="meal-card">
      <div class="meal-header">
        <div class="meal-title">${m.label}</div>
        <span class="meal-cal">${formatNum(mt.calories || 0)} cal</span>
        <div class="meal-actions">
          <button type="button" class="copy-meal-btn" data-meal="${m.id}" title="Copy from yesterday" ${
            prev[m.id] ? "" : "disabled"
          }>Copy</button>
          <button type="button" class="add-meal-btn" data-meal="${m.id}" title="Add food">+</button>
        </div>
      </div>
      <div class="meal-entries">${rows}</div>
      ${mealMacros}
    </article>`;
  }).join("");

  root.querySelectorAll(".add-meal-btn").forEach((b) =>
    b.addEventListener("click", () => openModal(b.dataset.meal))
  );
  root.querySelectorAll(".copy-meal-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const n = await copyDiary(d.prev_day, currentDate, b.dataset.meal);
        toast(`Copied ${n}`);
        loadDay();
      } catch (e) {
        toast(e.message);
      }
    })
  );
  root.querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async () => {
      await deleteDiary(Number(b.dataset.id));
      toast("Removed");
      loadDay();
    })
  );
  root.querySelectorAll(".edit-serv").forEach((b) =>
    b.addEventListener("click", async () => {
      const next = prompt("Servings:", b.dataset.s);
      if (!next) return;
      const s = parseFloat(next);
      if (!(s > 0)) return toast("Invalid");
      await updateDiaryServings(Number(b.dataset.id), s);
      loadDay();
    })
  );
  root.querySelectorAll(".verify").forEach((b) =>
    b.addEventListener("click", async () => {
      await verifyDiaryEntry(Number(b.dataset.id));
      toast("Confirmed");
      loadDay();
    })
  );
  root.querySelectorAll(".fav").forEach((b) =>
    b.addEventListener("click", async () => {
      const on = await toggleFavorite(Number(b.dataset.id));
      toast(on ? "Added to favorites" : "Removed favorite");
    })
  );
}

function renderExercise(d) {
  document.getElementById("exercise-total").textContent = `${formatNum(
    d.exercise_burned
  )} cal burned`;
  const root = document.getElementById("exercise-entries");
  const list = d.exercises || [];
  if (!list.length) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = list
    .map(
      (e) => `
    <div class="entry">
      <div>
        <div class="entry-name">${escapeHtml(e.name)}</div>
        <div class="entry-meta">${e.duration_min ? formatNum(e.duration_min) + " min" : "�"}</div>
      </div>
      <div class="entry-cals">+${formatNum(e.calories)}</div>
      <div class="entry-actions">
        <button type="button" class="del-ex" data-id="${e.id}">??</button>
      </div>
    </div>`
    )
    .join("");
  root.querySelectorAll(".del-ex").forEach((b) =>
    b.addEventListener("click", async () => {
      await deleteExercise(Number(b.dataset.id));
      loadDay();
    })
  );
}

// ---- modal food ----
function openModal(meal) {
  modalMeal = meal;
  selectedFood = null;
  pendingOff = null;
  document.getElementById("add-modal").hidden = false;
  document.getElementById("food-search").value = "";
  document.getElementById("barcode-input").value = "";
  document.getElementById("servings-row").hidden = true;
  document.getElementById("add-selected").disabled = true;
  document.getElementById("quick-add-form").hidden = true;
  document.getElementById("barcode-status").hidden = true;
  document.querySelectorAll("#meal-pills .pill").forEach((p) =>
    p.classList.toggle("active", p.dataset.meal === meal)
  );
  doSearch("");
}
function closeModal() {
  stopCamera();
  document.getElementById("add-modal").hidden = true;
}

async function doSearch(q) {
  const foods = await searchFoods(q, 30);
  const box = document.getElementById("search-results");
  if (!foods.length) {
    box.innerHTML = `<div class="empty-state">No foods found.</div>`;
    return;
  }
  box.innerHTML = foods
    .map(
      (f) => `
    <button type="button" class="result-item" data-id="${f.id}">
      <div class="rname">${escapeHtml(f.name)}${f.is_custom ? '<span class="badge">Custom</span>' : ""}</div>
      <div class="rmeta">${escapeHtml(f.serving_size)}</div>
      ${MacroLedgers(f.protein, f.carbs, f.fat, { calories: f.calories })}
    </button>`
    )
    .join("");
  box.querySelectorAll(".result-item").forEach((el) => {
    el.addEventListener("click", () => {
      selectedFood = foods.find((f) => f.id === Number(el.dataset.id));
      pendingOff = null;
      box.querySelectorAll(".result-item").forEach((x) => x.classList.remove("selected"));
      el.classList.add("selected");
      document.getElementById("servings-row").hidden = false;
      document.getElementById("add-selected").disabled = false;
      updatePreview();
    });
  });
}

function updatePreview() {
  const food = selectedFood || pendingOff;
  if (!food) return;
  const s = parseFloat(document.getElementById("servings-input").value) || 1;
  document.getElementById("preview-macros").innerHTML = MacroLedgers(
    food.protein * s,
    food.carbs * s,
    food.fat * s,
    { calories: food.calories * s }
  );
}

async function lookupBarcode(raw) {
  const code = String(raw || "").replace(/\D/g, "");
  const status = document.getElementById("barcode-status");
  status.hidden = false;
  if (code.length < 8) {
    status.textContent = "Enter at least 8 digits";
    status.className = "barcode-status error";
    return;
  }
  // Local first
  const local = await findByBarcode(code);
  if (local) {
    selectedFood = local;
    pendingOff = null;
    showBarcodeResult(local, "local");
    status.textContent = "Found on this device";
    status.className = "barcode-status ok";
    return;
  }
  if (!navigator.onLine) {
    status.textContent = "Offline � barcode only works for foods already saved on this device";
    status.className = "barcode-status error";
    return;
  }
  status.textContent = "Looking up online�";
  status.className = "barcode-status";
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${code}.json`,
      { headers: { "User-Agent": "MacroLedgerPWA/1.0" } }
    );
    const data = await res.json();
    if (data.status !== 1 || !data.product) {
      status.textContent = "Product not found";
      status.className = "barcode-status error";
      return;
    }
    const p = data.product;
    const n = p.nutriments || {};
    let serving = (p.serving_size || "").trim() || "100g";
    let cal = n["energy-kcal_serving"];
    let protein = n.proteins_serving;
    let carbs = n.carbohydrates_serving;
    let fat = n.fat_serving;
    let fiber = n.fiber_serving;
    if (cal == null) {
      serving = "100g";
      cal = n["energy-kcal_100g"] ?? n["energy-kcal"];
      protein = n.proteins_100g;
      carbs = n.carbohydrates_100g;
      fat = n.fat_100g;
      fiber = n.fiber_100g;
    }
    const food = {
      name: (p.product_name || p.product_name_en || "Unknown").slice(0, 200),
      brand: ((p.brands || "").split(",")[0] || "").trim(),
      serving_size: serving,
      calories: Math.round((Number(cal) || 0) * 10) / 10,
      protein: Math.round((Number(protein) || 0) * 10) / 10,
      carbs: Math.round((Number(carbs) || 0) * 10) / 10,
      fat: Math.round((Number(fat) || 0) * 10) / 10,
      fiber: Math.round((Number(fiber) || 0) * 10) / 10,
      barcode: code,
    };
    selectedFood = null;
    pendingOff = food;
    showBarcodeResult(food, "openfoodfacts");
    status.textContent = "Found online � will save when you add";
    status.className = "barcode-status ok";
  } catch {
    status.textContent = "Lookup failed (need internet)";
    status.className = "barcode-status error";
  }
}

function showBarcodeResult(food, source) {
  const box = document.getElementById("search-results");
  box.innerHTML = `<button type="button" class="result-item selected">
    <div class="rname">${escapeHtml(food.name)} <span class="badge">${source}</span></div>
    <div class="rmeta">${escapeHtml(food.serving_size)}</div>
    ${MacroLedgers(food.protein, food.carbs, food.fat, { calories: food.calories })}
  </button>`;
  document.getElementById("servings-row").hidden = false;
  document.getElementById("add-selected").disabled = false;
  updatePreview();
}

function setBarcodeStatus(msg, cls = "") {
  const status = document.getElementById("barcode-status");
  if (!msg) {
    status.hidden = true;
    status.textContent = "";
    status.className = "barcode-status";
    return;
  }
  status.hidden = false;
  status.textContent = msg;
  status.className = "barcode-status" + (cls ? " " + cls : "");
}

async function onBarcodeDetected(code) {
  if (scanBusy) return;
  const digits = String(code || "").replace(/\D/g, "");
  if (digits.length < 8) return;
  scanBusy = true;
  try {
    await stopCamera();
    document.getElementById("barcode-input").value = digits;
    setBarcodeStatus(`Scanned ${digits} � looking up�`, "ok");
    toast("Barcode scanned");
    await lookupBarcode(digits);
  } finally {
    scanBusy = false;
  }
}

function scanUi() {
  return {
    video: document.getElementById("camera-video"),
    canvas: document.getElementById("scan-canvas"),
    onCode: (code) => onBarcodeDetected(code),
    onStatus: (msg, kind) => setBarcodeStatus(msg, kind || ""),
  };
}

async function startCamera() {
  document.getElementById("camera-scan-wrap").hidden = false;
  setBarcodeStatus("Starting rear camera with zoom�", "");
  try {
    await startScanner(scanUi());
  } catch (err) {
    console.error(err);
    setBarcodeStatus(cameraHelp(err), "error");
  }
}

async function flipCamera() {
  try {
    await flipScanner(scanUi());
  } catch (err) {
    setBarcodeStatus(cameraHelp(err), "error");
  }
}

async function scanBarcodeFromFile(file) {
  if (!file) return;
  setBarcodeStatus("Reading barcode from photo�", "");
  try {
    const code = await decodeBarcodeFromFile(file);
    if (code) await onBarcodeDetected(code);
    else setBarcodeStatus("No barcode found in photo. Try closer / better light, or type the UPC.", "error");
  } catch (err) {
    console.error(err);
    setBarcodeStatus(
      "Could not read barcode in photo. Type the numbers under the code (that always works).",
      "error"
    );
  }
}

async function stopCamera() {
  await stopScanner();
  const v = document.getElementById("camera-video");
  if (v) {
    v.srcObject = null;
    v.style.transform = "";
  }
  const wrap = document.getElementById("camera-scan-wrap");
  if (wrap) wrap.hidden = true;
}

// ---- progress / foods / goals ----
async function loadProgress() {
  settings = await getSettings();
  const goals = goalsFromSettings(settings);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = shiftDate(todayISO(), -i);
    const entries = await diaryForDate(date);
    const ex = await exerciseForDate(date);
    const cals = entries.reduce((s, e) => s + e.calories, 0);
    const burned = ex.reduce((s, e) => s + e.calories, 0);
    days.push({ date, cals, burned, logged: cals > 0 || burned > 0 });
  }
  const maxCal = Math.max(goals.calories, ...days.map((d) => d.cals), 1);
  document.getElementById("history-chart").innerHTML = days
    .map((d) => {
      const net = d.cals - d.burned;
      let cls = "empty";
      let h = 4;
      if (d.logged) {
        cls = net <= goals.calories ? "under" : "over";
        h = Math.max(8, (d.cals / maxCal) * 110);
      }
      const day = parseISO(d.date).toLocaleDateString(undefined, { weekday: "narrow" });
      return `<div class="hist-bar-wrap" title="${d.date}: ${formatNum(d.cals)} cal">
        <div class="hist-bar ${cls}" style="height:${h}px"></div>
        <div class="hist-day">${day}</div>
      </div>`;
    })
    .join("");

  const weights = await listWeight(60);
  const list = document.getElementById("weight-list");
  if (!weights.length) list.innerHTML = `<div class="empty-state">No weight logs yet.</div>`;
  else {
    list.innerHTML = weights
      .map(
        (w) => `<div class="weight-row">
        <span class="w-date">${w.log_date}</span>
        <span class="w-val">${formatNum(w.weight_lb, 1)} lb</span>
        <button type="button" data-id="${w.id}">�</button>
      </div>`
      )
      .join("");
    list.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        await deleteWeight(Number(b.dataset.id));
        loadProgress();
      })
    );
  }
}

async function loadFoodDb(q = "") {
  const foods = await searchFoods(q, 80);
  document.getElementById("food-db-list").innerHTML = foods
    .map(
      (f) => `<div class="food-row">
      <div>
        <div class="fname">${escapeHtml(f.name)}${f.is_custom ? '<span class="badge">Custom</span>' : ""}</div>
        <div class="fmeta">${escapeHtml(f.serving_size)}</div>
        ${MacroLedgers(f.protein, f.carbs, f.fat, { calories: f.calories })}
      </div>
      <div class="fcals">${formatNum(f.calories)}
        ${f.is_custom ? `<br><button type="button" class="ghost-btn del-food" data-id="${f.id}" style="margin-top:4px;padding:2px 8px">Delete</button>` : ""}
      </div>
    </div>`
    )
    .join("");
  document.querySelectorAll(".del-food").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete?")) return;
      await deleteFood(Number(b.dataset.id));
      loadFoodDb(document.getElementById("food-db-search").value);
    })
  );
}

function renderRecipeItems() {
  const box = document.getElementById("recipe-items");
  const totals = recipeItems.reduce(
    (a, i) => {
      a.calories += i.calories;
      a.protein += i.protein;
      a.carbs += i.carbs;
      a.fat += i.fat;
      return a;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  document.getElementById("recipe-totals").innerHTML =
    recipeItems.length === 0
      ? "Totals appear here"
      : MacroLedgers(totals.protein, totals.carbs, totals.fat, { calories: totals.calories });
  box.innerHTML = recipeItems
    .map(
      (i, idx) =>
        `<div class="entry"><div><div class="entry-name">${escapeHtml(i.food_name)}</div>
        ${MacroLedgers(i.protein, i.carbs, i.fat, { calories: i.calories })}</div>
        <button type="button" class="ghost-btn" data-i="${idx}">�</button></div>`
    )
    .join("");
  box.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      recipeItems.splice(Number(b.dataset.i), 1);
      renderRecipeItems();
    })
  );
}

async function loadMealsView() {
  const meals = await listSavedMeals();
  const list = document.getElementById("saved-meals-list");
  if (!meals.length) {
    list.innerHTML = `<div class="empty-state">No saved meals yet.</div>`;
    return;
  }
  list.innerHTML = meals
    .map(
      (m) => `<div class="food-row">
      <div>
        <div class="fname">${escapeHtml(m.name)} ${m.is_recipe ? '<span class="badge">Recipe</span>' : ""}</div>
        <div class="fmeta">${(m.items || []).length} ingredients � ${formatNum(m.totals?.calories || 0)} cal</div>
      </div>
      <div>
        <button type="button" class="primary-btn log-meal" data-id="${m.id}" style="padding:0.35rem 0.75rem;font-size:0.8rem">Log</button>
        <button type="button" class="ghost-btn del-meal" data-id="${m.id}" style="padding:0.35rem 0.5rem">�</button>
      </div>
    </div>`
    )
    .join("");
  list.querySelectorAll(".log-meal").forEach((b) =>
    b.addEventListener("click", async () => {
      const n = await logSavedMeal(Number(b.dataset.id), currentDate, guessMealSlot(), 1);
      toast(`Logged ${n} items`);
      loadDay();
    })
  );
  list.querySelectorAll(".del-meal").forEach((b) =>
    b.addEventListener("click", async () => {
      await deleteSavedMeal(Number(b.dataset.id));
      loadMealsView();
    })
  );
}

async function loadGoals() {
  settings = await getSettings();
  renderThemePicker(settings.ui_theme || "light");
  const eatStart = document.getElementById("set-eating-start");
  if (eatStart && !settings.eating_window_start) settings.eating_window_start = "12:00";
  const map = {
    "set-user-name": "user_name",
    "set-weight": "body_weight_lb",
    "set-height": "height_in",
    "set-age": "age",
    "set-sex": "sex",
    "set-activity": "activity_level",
    "set-goal-type": "goal_type",
    "set-protein-per-lb": "protein_per_lb",
    "set-calorie": "calorie_goal",
    "set-protein": "protein_goal",
    "set-carbs": "carbs_goal",
    "set-fat": "fat_goal",
    "set-fiber": "fiber_goal",
    "set-water": "water_goal",
    "set-sodium": "sodium_goal",
    "set-sugar": "sugar_goal",
    "set-show-micros": "show_micros",
    "set-fasting-enabled": "fasting_enabled",
    "set-fasting-protocol": "fasting_protocol",
    "set-eating-start": "eating_window_start",
    "set-custom-eat": "custom_eat_hours",
    "set-adaptive": "adaptive_enabled",
    "set-photo-proxy": "photo_proxy_url",
    "set-photo-gemini-key": "photo_gemini_key",
  };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.value = settings[key] ?? "";
  }
  const meta = await metabolismFromSettings(settings);
  const panel = document.getElementById("metabolism-panel");
  if (!meta) {
    panel.innerHTML = `<p class="hint" style="margin:0">Enter weight to see BMR / TDEE / suggested macros.</p>`;
  } else {
    panel.innerHTML = `
      <div class="meta-grid">
        <div class="meta-cell"><span class="mv">${meta.bmr}</span><span class="ml">BMR</span></div>
        <div class="meta-cell"><span class="mv">${meta.tdee}</span><span class="ml">TDEE</span></div>
        <div class="meta-cell"><span class="mv">${meta.target_calories}</span><span class="ml">Target</span></div>
      </div>
      ${MacroLedgers(meta.suggested_macros.protein, meta.suggested_macros.carbs, meta.suggested_macros.fat)}
    `;
  }
  const prop = await proposeAdaptiveTargets();
  const ap = document.getElementById("adaptive-panel");
  if (!prop) {
    ap.innerHTML = `<p class="hint" style="margin:0">Adaptive off or unavailable.</p>`;
  } else {
    ap.innerHTML = `<div class="metabolism-panel">
      <strong>Adaptive suggestion:</strong> ${formatNum(prop.current)} → <strong>${formatNum(prop.proposed)}</strong> kcal
      (${prop.delta >= 0 ? "+" : ""}${prop.delta})
      <p class="hint" style="margin:0.35rem 0 0">${escapeHtml(prop.reason)}</p>
      ${MacroLedgers(prop.macros.protein, prop.macros.carbs, prop.macros.fat)}
    </div>`;
  }
  updatePhotoLogStatus();
}

function updatePhotoLogStatus() {
  const left = photoScansRemaining(CLIENT_DAILY_LIMIT);
  const ready = isPhotoLogConfigured(settings || {});
  const status = document.getElementById("photo-setup-status");
  const hint = document.getElementById("photo-log-hint");
  if (status) {
    status.textContent = ready
      ? `Photo meal is ready. Free scans left today: ${left}/${CLIENT_DAILY_LIMIT}.`
      : "Photo meal needs internet. Open Diary and try Photo meal when you’re online.";
  }
  if (hint) {
    hint.textContent = ready
      ? `Snap your plate — about ${left} free photo${left === 1 ? "" : "s"} left today. Needs internet.`
      : "Snap your plate when online — free a few times per day.";
  }
}

// ---- wire UI ----
// ---- Onboarding ----
function showOnboardStep() {
  const steps = ["welcome", "goal", "body", "activity", "diet", "review"];
  const step = steps[onboardStep];
  const bar = document.getElementById("onboard-bar");
  bar.style.width = `${((onboardStep + 1) / steps.length) * 100}%`;
  document.getElementById("onboard-back").hidden = onboardStep === 0;
  const nextBtn = document.getElementById("onboard-next");
  nextBtn.textContent = step === "review" ? "Start tracking" : "Continue";

  const el = document.getElementById("onboard-step");
  if (step === "welcome") {
    el.innerHTML = `<h2>Welcome to MacroLedger</h2>
      <p>Privacy-first calorie &amp; macro tracking. Your diary stays <strong>on this device</strong>.</p>
      <p class="hint" style="margin:0.5rem 0"><strong>Already used MacroLedger?</strong> Restore a backup file instead of starting over.</p>
      <label class="ghost-btn export-link" style="cursor:pointer;display:inline-flex;margin-bottom:0.75rem">
        Restore from backup file
        <input type="file" id="restore-input-onboard" accept="application/json,.json" hidden />
      </label>
      <p class="hint">On iPhone: <strong>never delete the Home Screen icon to update</strong> — that can erase your data. The app updates itself when online.</p>
      <p>We'll set your goals in under a minute.</p>
      <label>What should we call you?
        <input id="ob-name" value="${escapeHtml(onboardDraft.user_name)}" />
      </label>`;
    const obRestore = document.getElementById("restore-input-onboard");
    if (obRestore) {
      obRestore.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!confirm("Replace ALL data on this device with the backup?")) return;
        try {
          const data = JSON.parse(await file.text());
          await importAllJson(data);
          markFileBackupSaved();
          scheduleFullBackup(exportAllJson);
          document.getElementById("onboard").hidden = true;
          toast("Restored from backup file");
          loadDay();
        } catch (err) {
          toast("Restore failed: " + err.message);
        }
        e.target.value = "";
      };
    }
  } else if (step === "goal") {
    el.innerHTML = `<h2>What's your goal?</h2>
      <div class="choice-grid three" id="ob-goal">
        ${["lose", "maintain", "gain"]
          .map(
            (g) =>
              `<button type="button" class="choice ${onboardDraft.goal_type === g ? "active" : ""}" data-v="${g}">${
                g === "lose" ? "Lose" : g === "gain" ? "Gain" : "Maintain"
              }</button>`
          )
          .join("")}
      </div>`;
    el.querySelectorAll(".choice").forEach((b) =>
      b.addEventListener("click", () => {
        onboardDraft.goal_type = b.dataset.v;
        showOnboardStep();
      })
    );
  } else if (step === "body") {
    el.innerHTML = `<h2>About you</h2>
      <div class="form-grid">
        <label>Weight (lb) *<input id="ob-w" type="number" step="0.1" value="${escapeHtml(onboardDraft.body_weight_lb)}" /></label>
        <label>Height (in)<input id="ob-h" type="number" step="0.5" value="${escapeHtml(onboardDraft.height_in)}" /></label>
        <label>Age<input id="ob-age" type="number" value="${escapeHtml(onboardDraft.age)}" /></label>
        <label>Sex
          <select id="ob-sex">
            <option value="male">Male</option><option value="female">Female</option>
          </select>
        </label>
      </div>`;
    el.querySelector("#ob-sex").value = onboardDraft.sex;
  } else if (step === "activity") {
    const opts = [
      ["sedentary", "Sedentary"],
      ["light", "Light"],
      ["moderate", "Moderate"],
      ["active", "Active"],
      ["extra", "Very active"],
    ];
    el.innerHTML = `<h2>Activity level</h2>
      <div class="choice-grid" id="ob-act">
        ${opts
          .map(
            ([v, l]) =>
              `<button type="button" class="choice ${onboardDraft.activity_level === v ? "active" : ""}" data-v="${v}">${l}</button>`
          )
          .join("")}
      </div>`;
    el.querySelectorAll(".choice").forEach((b) =>
      b.addEventListener("click", () => {
        onboardDraft.activity_level = b.dataset.v;
        showOnboardStep();
      })
    );
  } else if (step === "diet") {
    const diets = [
      ["standard", "Standard"],
      ["high_protein", "High protein"],
      ["keto", "Keto"],
      ["vegan", "Vegan"],
    ];
    el.innerHTML = `<h2>Diet preference</h2>
      <div class="choice-grid">
        ${diets
          .map(
            ([v, l]) =>
              `<button type="button" class="choice ${onboardDraft.diet_type === v ? "active" : ""}" data-v="${v}">${l}</button>`
          )
          .join("")}
      </div>
      <p class="hint">Macro style</p>
      <div class="choice-grid">
        <button type="button" class="choice ${onboardDraft.macro_mode === "beginner" ? "active" : ""}" data-m="beginner">Simple (P/C/F)</button>
        <button type="button" class="choice ${onboardDraft.macro_mode === "advanced" ? "active" : ""}" data-m="advanced">Advanced (more nutrients later)</button>
      </div>`;
    el.querySelectorAll("[data-v]").forEach((b) =>
      b.addEventListener("click", () => {
        onboardDraft.diet_type = b.dataset.v;
        showOnboardStep();
      })
    );
    el.querySelectorAll("[data-m]").forEach((b) =>
      b.addEventListener("click", () => {
        onboardDraft.macro_mode = b.dataset.m;
        showOnboardStep();
      })
    );
  } else if (step === "review") {
    el.innerHTML = `<h2>Your plan</h2><p class="hint">Calculating�</p>`;
    computeOnboardingSuggestion(onboardDraft).then((sug) => {
      if (!sug.ok) {
        el.innerHTML = `<h2>Your plan</h2><p class="hint">${escapeHtml(sug.error)}</p>`;
        return;
      }
      onboardDraft._suggestion = sug;
      el.innerHTML = `<h2>Your plan</h2>
        <div class="meta-grid">
          <div class="meta-cell"><span class="mv">${sug.bmr}</span><span class="ml">BMR</span></div>
          <div class="meta-cell"><span class="mv">${sug.tdee}</span><span class="ml">TDEE</span></div>
          <div class="meta-cell"><span class="mv">${sug.target_calories}</span><span class="ml">Target</span></div>
        </div>
        ${MacroLedgers(sug.suggested_macros.protein, sug.suggested_macros.carbs, sug.suggested_macros.fat)}
        <p class="hint">You can change these anytime in Goals. Adaptive mode will suggest weekly tweaks from your weight trend.</p>`;
    });
  }
}

function readOnboardFields() {
  const name = document.getElementById("ob-name");
  if (name) onboardDraft.user_name = name.value || "You";
  const w = document.getElementById("ob-w");
  if (w) onboardDraft.body_weight_lb = w.value;
  const h = document.getElementById("ob-h");
  if (h) onboardDraft.height_in = h.value;
  const age = document.getElementById("ob-age");
  if (age) onboardDraft.age = age.value;
  const sex = document.getElementById("ob-sex");
  if (sex) onboardDraft.sex = sex.value;
}

function setupOnboarding() {
  document.getElementById("onboard-back").onclick = () => {
    readOnboardFields();
    if (onboardStep > 0) {
      onboardStep--;
      showOnboardStep();
    }
  };
  document.getElementById("onboard-next").onclick = async () => {
    readOnboardFields();
    const steps = ["welcome", "goal", "body", "activity", "diet", "review"];
    if (steps[onboardStep] === "body" && !parseFloat(onboardDraft.body_weight_lb)) {
      toast("Weight is required");
      return;
    }
    if (onboardStep < steps.length - 1) {
      onboardStep++;
      showOnboardStep();
      return;
    }
    let sug = onboardDraft._suggestion;
    if (!sug) sug = await computeOnboardingSuggestion(onboardDraft);
    if (!sug.ok) return toast(sug.error);
    await completeOnboarding(onboardDraft, sug);
    const s = await getSettings();
    saveProfileBackup(s);
    scheduleFullBackup(exportAllJson);
    document.getElementById("onboard").hidden = true;
    toast("You're set � profile is saved on this phone");
    loadDay();
  };
}

// ---- Photo meal estimate ----
let photoBusy = false;

async function ensurePhotoLogReady() {
  if (!settings) settings = await getSettings();
  if (!navigator.onLine) {
    toast("Photo meal needs internet. Use barcode or voice while offline.");
    return false;
  }
  if (!isPhotoLogConfigured(settings)) {
    toast("Photo meal isn’t available right now. Try barcode or voice instead.");
    return false;
  }
  if (photoScansRemaining(CLIENT_DAILY_LIMIT) <= 0) {
    toast(
      `You’ve used today’s free photo scans (${CLIENT_DAILY_LIMIT}). Barcode, search & voice still work.`
    );
    return false;
  }
  return true;
}

async function runPhotoMealEstimate(file) {
  if (photoBusy) return;
  photoBusy = true;
  const busy = document.getElementById("photo-busy-modal");
  if (busy) busy.hidden = false;
  try {
    if (!settings) settings = await getSettings();
    if (!isPhotoLogConfigured(settings)) {
      toast("Photo meal isn’t available right now. Try barcode or voice instead.");
      return;
    }
    const meal = guessMealSlot();
    document.getElementById("review-meal").value = meal;
    const result = await estimateMealFromPhoto(file, meal, {
      proxyUrl: settings.photo_proxy_url || undefined,
      geminiKey: settings.photo_gemini_key || "",
      dailyLimit: CLIENT_DAILY_LIMIT,
    });
    openReview(result.drafts);
    updatePhotoLogStatus();
    toast(
      result.remaining != null
        ? `Found ${result.drafts.length} food${result.drafts.length === 1 ? "" : "s"} — check & save · ${result.remaining} photos left today`
        : `Found ${result.drafts.length} food${result.drafts.length === 1 ? "" : "s"} — check & save`
    );
  } catch (err) {
    console.warn("photo log failed", err);
    const msg =
      err instanceof PhotoLogError || err?.message
        ? err.message
        : "Couldn’t estimate that photo. Try again or use barcode / voice.";
    toast(msg);
  } finally {
    if (busy) busy.hidden = true;
    photoBusy = false;
  }
}

// ---- Review drafts (NLP / AI) ----
function openReview(drafts) {
  reviewDrafts = drafts.map((d) => ({ ...d }));
  document.getElementById("review-modal").hidden = false;
  renderReviewList();
}

function renderReviewList() {
  const list = document.getElementById("review-list");
  if (!reviewDrafts.length) {
    list.innerHTML = `<div class="empty-state">Nothing to save.</div>`;
    return;
  }
  list.innerHTML = reviewDrafts
    .map((d, i) => {
      const low = d.confidence < 0.8;
      return `<div class="review-item ${low ? "low" : ""}">
        <div class="ri-head">
          <span>${escapeHtml(d.food_name)} ${low ? '<span class="flag-uncertain">? ' + Math.round(d.confidence * 100) + '%</span>' : ""}</span>
          <button type="button" class="ghost-btn rev-del" data-i="${i}" style="padding:2px 8px">Remove</button>
        </div>
        <div class="entry-meta">${escapeHtml(d.serving_size || "")} � ${formatNum(d.calories)} cal</div>
        ${MacroLedgers(d.protein, d.carbs, d.fat)}
        <label>Servings <input type="number" class="rev-serv" data-i="${i}" min="0.1" step="0.25" value="${d.servings}" /></label>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".rev-del").forEach((b) =>
    b.addEventListener("click", () => {
      reviewDrafts.splice(Number(b.dataset.i), 1);
      renderReviewList();
    })
  );
  list.querySelectorAll(".rev-serv").forEach((inp) =>
    inp.addEventListener("change", () => {
      const i = Number(inp.dataset.i);
      const d = reviewDrafts[i];
      const old = d.servings || 1;
      const s = parseFloat(inp.value) || 1;
      const r = s / old;
      d.servings = s;
      for (const k of ["calories", "protein", "carbs", "fat", "fiber"]) {
        d[k] = Math.round((d[k] || 0) * r * 10) / 10;
      }
      renderReviewList();
    })
  );
}

function setup() {
  setupOnboarding();

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      try {
        const view = btn.dataset.view;
        document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        btn.classList.add("active");
        const panel = document.getElementById(`view-${view}`);
        if (panel) panel.classList.add("active");
        if (view === "progress") loadProgress();
        if (view === "foods") loadFoodDb();
        if (view === "goals") loadGoals();
        if (view === "meals") {
          loadMealsView();
          renderRestaurantBuilder();
        }
        if (view === "diary") loadDay();
      } catch (err) {
        console.warn("tab switch failed", err);
      }
    });
  });

  // Quick log strip
  const el = (id) => document.getElementById(id);
  if (el("btn-show-recents")) el("btn-show-recents").onclick = () => renderQuickRail("recents");
  if (el("btn-show-favs")) el("btn-show-favs").onclick = () => renderQuickRail("favs");
  if (el("btn-voice-log")) {
    el("btn-voice-log").onclick = () => {
      if (el("nlp-modal")) el("nlp-modal").hidden = false;
      el("nlp-text")?.focus();
    };
  }
  const photoInput = el("photo-log-input");
  if (el("btn-photo-log") && photoInput) {
    el("btn-photo-log").onclick = async () => {
      // Check setup BEFORE opening the camera — avoids "photo then dump to Goals"
      const ready = await ensurePhotoLogReady();
      if (!ready) return;
      photoInput.value = "";
      photoInput.click();
    };
    photoInput.onchange = async () => {
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = "";
      if (!file) return;
      // Re-check in case settings changed or quota hit while camera was open
      const ready = await ensurePhotoLogReady();
      if (!ready) return;
      await runPhotoMealEstimate(file);
    };
  }
  document.getElementById("btn-scan-barcode").onclick = () => {
    openModal(guessMealSlot());
    // Wait for modal paint, then request camera (user gesture chain on iOS)
    setTimeout(() => {
      document.getElementById("camera-scan-wrap").hidden = false;
      startCamera();
    }, 300);
  };
  document.getElementById("close-nlp").onclick = () => {
    document.getElementById("nlp-modal").hidden = true;
  };
  document.getElementById("nlp-parse").onclick = async () => {
    const text = document.getElementById("nlp-text").value;
    const meal = guessMealSlot();
    document.getElementById("review-meal").value = meal;
    const drafts = await parseFoodUtterance(text, meal);
    if (!drafts.length) return toast("Could not parse � try simpler phrases");
    document.getElementById("nlp-modal").hidden = true;
    openReview(drafts);
  };
  document.getElementById("nlp-mic").onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast("Speech recognition not supported in this browser");
    const rec = new SR();
    rec.lang = "en-US";
    rec.onresult = (e) => {
      document.getElementById("nlp-text").value = e.results[0][0].transcript;
    };
    rec.onerror = () => toast("Mic error");
    rec.start();
    toast("Listening�");
  };
  document.getElementById("close-review").onclick = document.getElementById(
    "review-discard"
  ).onclick = () => {
    document.getElementById("review-modal").hidden = true;
    reviewDrafts = [];
  };
  document.getElementById("review-save").onclick = async () => {
    const meal = document.getElementById("review-meal").value;
    for (const d of reviewDrafts) {
      await addDiaryEntry({
        ...d,
        entry_date: currentDate,
        meal: d.meal || meal,
        user_verified: d.confidence >= 0.8,
      });
    }
    toast(`Saved ${reviewDrafts.length} items`);
    reviewDrafts = [];
    document.getElementById("review-modal").hidden = true;
    loadDay();
  };

  // Recipe builder
  let recipeSearchT;
  document.getElementById("recipe-food-search").oninput = (e) => {
    clearTimeout(recipeSearchT);
    recipeSearchT = setTimeout(async () => {
      const foods = await searchFoods(e.target.value.trim(), 8);
      const box = document.getElementById("recipe-search-results");
      box.innerHTML = foods
        .map(
          (f) =>
            `<button type="button" class="result-item" data-id="${f.id}"><div class="rname">${escapeHtml(f.name)}</div>
            ${MacroLedgers(f.protein, f.carbs, f.fat, { calories: f.calories })}</button>`
        )
        .join("");
      box.querySelectorAll(".result-item").forEach((el) =>
        el.addEventListener("click", () => {
          const f = foods.find((x) => x.id === Number(el.dataset.id));
          if (!f) return;
          recipeItems.push({
            food_id: f.id,
            food_name: f.name,
            serving_size: f.serving_size,
            servings: 1,
            calories: f.calories,
            protein: f.protein,
            carbs: f.carbs,
            fat: f.fat,
            fiber: f.fiber || 0,
          });
          renderRecipeItems();
        })
      );
    }, 150);
  };
  document.getElementById("recipe-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!recipeItems.length) return toast("Add ingredients first");
    const name = document.getElementById("recipe-name").value.trim();
    const totals = recipeItems.reduce(
      (a, i) => {
        a.calories += i.calories;
        a.protein += i.protein;
        a.carbs += i.carbs;
        a.fat += i.fat;
        a.fiber += i.fiber || 0;
        return a;
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
    );
    await saveMeal({
      name,
      is_recipe: true,
      items: recipeItems,
      totals,
      meal_type: "any",
    });
    toast("Recipe saved");
    recipeItems = [];
    document.getElementById("recipe-name").value = "";
    renderRecipeItems();
    loadMealsView();
  };

  document.getElementById("prev-day").onclick = () => {
    currentDate = shiftDate(currentDate, -1);
    loadDay();
  };
  document.getElementById("next-day").onclick = () => {
    currentDate = shiftDate(currentDate, 1);
    loadDay();
  };
  document.getElementById("today-btn").onclick = document.getElementById(
    "date-label"
  ).onclick = () => {
    currentDate = todayISO();
    loadDay();
  };

  document.getElementById("copy-yesterday-btn").onclick = async () => {
    if (!confirm("Copy all meals from previous day?")) return;
    try {
      const n = await copyDiary(shiftDate(currentDate, -1), currentDate, null);
      toast(`Copied ${n} items`);
      loadDay();
    } catch (e) {
      toast(e.message);
    }
  };

  document.getElementById("close-modal").onclick = closeModal;
  document.getElementById("add-modal").onclick = (e) => {
    if (e.target.id === "add-modal") closeModal();
  };
  document.querySelectorAll("#meal-pills .pill").forEach((p) =>
    p.addEventListener("click", () => {
      modalMeal = p.dataset.meal;
      document.querySelectorAll("#meal-pills .pill").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
    })
  );
  let st;
  document.getElementById("food-search").oninput = (e) => {
    clearTimeout(st);
    st = setTimeout(() => doSearch(e.target.value.trim()), 150);
  };
  document.getElementById("servings-input").oninput = updatePreview;
  document.getElementById("barcode-lookup-btn").onclick = () =>
    lookupBarcode(document.getElementById("barcode-input").value);
  document.getElementById("barcode-input").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      lookupBarcode(e.target.value);
    }
  };
  document.getElementById("camera-scan-btn").onclick = () => {
    document.getElementById("camera-scan-wrap").hidden = false;
    startCamera();
  };
  document.getElementById("camera-stop-btn").onclick = stopCamera;
  const flipBtn = document.getElementById("camera-flip-btn");
  if (flipBtn) flipBtn.onclick = () => flipCamera();
  const fileInput = document.getElementById("barcode-file-input");
  if (fileInput) {
    fileInput.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) await scanBarcodeFromFile(file);
    };
  }

  document.getElementById("add-selected").onclick = async () => {
    const servings = parseFloat(document.getElementById("servings-input").value) || 1;
    let food = selectedFood;
    if (pendingOff && !food) {
      food = await addFood({ ...pendingOff, is_custom: true });
    }
    if (!food) return;
    await addDiaryEntry({
      entry_date: currentDate,
      meal: modalMeal,
      food_id: food.id,
      food_name: food.name,
      serving_size: food.serving_size,
      servings,
      calories: food.calories * servings,
      protein: food.protein * servings,
      carbs: food.carbs * servings,
      fat: food.fat * servings,
      fiber: (food.fiber || 0) * servings,
      sodium_mg: (food.sodium_mg || 0) * servings,
      sugar_g: (food.sugar_g || 0) * servings,
    });
    toast(`Added ${food.name}`);
    closeModal();
    loadDay();
  };

  document.getElementById("quick-add-toggle").onclick = () => {
    const f = document.getElementById("quick-add-form");
    f.hidden = !f.hidden;
  };
  document.getElementById("quick-add-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await addDiaryEntry({
      entry_date: currentDate,
      meal: modalMeal,
      food_name: fd.get("food_name"),
      serving_size: "1 serving",
      servings: 1,
      calories: fd.get("calories"),
      protein: fd.get("protein"),
      carbs: fd.get("carbs"),
      fat: fd.get("fat"),
      fiber: 0,
    });
    toast("Quick-added");
    e.target.reset();
    closeModal();
    loadDay();
  };

  // exercise
  document.getElementById("add-exercise-btn").onclick = () => {
    document.getElementById("exercise-modal").hidden = false;
    refreshExEst();
  };
  document.getElementById("close-exercise-modal").onclick = () => {
    document.getElementById("exercise-modal").hidden = true;
  };
  async function refreshExEst() {
    settings = await getSettings();
    const w = await resolveWeightLb(settings);
    const name = document.getElementById("ex-name").value || "Walking";
    const dur = parseFloat(document.getElementById("ex-duration").value) || 0;
    const est = estimateExerciseCalories(name, dur, w);
    const line = document.getElementById("ex-estimate-line");
    if (!w) line.innerHTML = "Set weight in Goals to estimate burn.";
    else if (est.calories != null)
      line.innerHTML = `At <strong>${w} lb</strong> � <strong>${est.calories} cal</strong> (MET ${est.met})`;
    return est;
  }
  document.getElementById("ex-estimate-btn").onclick = async () => {
    const est = await refreshExEst();
    if (est.calories != null) {
      document.getElementById("ex-calories").value = est.calories;
      toast(`Estimated ${est.calories}`);
    }
  };
  ["ex-name", "ex-duration"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      clearTimeout(refreshExEst._t);
      refreshExEst._t = setTimeout(refreshExEst, 200);
    });
  });
  document.getElementById("exercise-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await addExercise({
      entry_date: currentDate,
      name: fd.get("name"),
      duration_min: fd.get("duration_min"),
      calories: fd.get("calories"),
    });
    toast("Exercise logged");
    e.target.reset();
    document.getElementById("ex-duration").value = "30";
    document.getElementById("exercise-modal").hidden = true;
    loadDay();
  };

  // weight
  document.getElementById("weight-date").value = todayISO();
  document.getElementById("weight-form").onsubmit = async (e) => {
    e.preventDefault();
    await upsertWeight(
      document.getElementById("weight-date").value || todayISO(),
      parseFloat(document.getElementById("weight-input").value)
    );
    document.getElementById("weight-input").value = "";
    toast("Weight logged");
    loadProgress();
  };

  // foods
  let ft;
  document.getElementById("food-db-search").oninput = (e) => {
    clearTimeout(ft);
    ft = setTimeout(() => loadFoodDb(e.target.value.trim()), 150);
  };
  document.getElementById("custom-food-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await addFood(Object.fromEntries(fd.entries()));
    toast("Food saved");
    e.target.reset();
    e.target.serving_size.value = "1 serving";
    loadFoodDb();
  };

  // goals
  document.getElementById("goals-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const partial = Object.fromEntries(fd.entries());
    // Don't wipe personal Gemini key if the password field was left blank
    if (!String(partial.photo_gemini_key || "").trim()) {
      delete partial.photo_gemini_key;
    }
    await setSettings(partial);
    document.getElementById("goals-saved").hidden = false;
    setTimeout(() => {
      document.getElementById("goals-saved").hidden = true;
    }, 2000);
    toast("Saved");
    await loadGoals();
    loadDay();
  };
  document.getElementById("apply-suggested-btn").onclick = async () => {
    const fd = new FormData(document.getElementById("goals-form"));
    await setSettings(Object.fromEntries(fd.entries()));
    const meta = await metabolismFromSettings(await getSettings());
    if (!meta) return toast("Set weight first");
    document.getElementById("set-calorie").value = meta.target_calories;
    document.getElementById("set-protein").value = meta.suggested_macros.protein;
    document.getElementById("set-carbs").value = meta.suggested_macros.carbs;
    document.getElementById("set-fat").value = meta.suggested_macros.fat;
    await loadGoals();
    toast("Suggested goals filled � Save goals");
  };
  document.getElementById("apply-adaptive-btn").onclick = async () => {
    const prop = await proposeAdaptiveTargets();
    if (!prop) return toast("Need weight history or adaptive enabled");
    if (!confirm(`Apply adaptive targets?\n${prop.current} ? ${prop.proposed} kcal\n${prop.reason}`)) return;
    await applyAdaptiveProposal(prop);
    toast("Adaptive targets applied");
    loadGoals();
    loadDay();
  };
  document.getElementById("reset-onboarding-btn").onclick = async () => {
    await setSettings({ onboarding_complete: "0" });
    onboardStep = 0;
    document.getElementById("onboard").hidden = false;
    showOnboardStep();
  };

  // backup — save a file you keep (Files / iCloud). Home Screen delete can wipe on-device data.
  async function doBackup() {
    try {
      const data = await exportAllJson();
      const name = `MacroLedger-backup-${todayISO()}.json`;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const file = new File([blob], name, { type: "application/json" });
      // iPhone: Share → Save to Files is more reliable than a silent download
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "MacroLedger backup",
          text: "Save this file. Restoring it brings back your profile and diary.",
        });
      } else {
        downloadBlob(name, blob);
      }
      markFileBackupSaved();
      scheduleFullBackup(exportAllJson);
      toast("Backup saved — keep this file safe");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      try {
        const data = await exportAllJson();
        downloadBlob(
          `MacroLedger-backup-${todayISO()}.json`,
          new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
        );
        markFileBackupSaved();
        toast("Backup downloaded");
      } catch (e2) {
        toast("Backup failed: " + (e2.message || "unknown"));
      }
    }
  }
  async function restoreFromFile(file) {
    if (!file) return;
    if (!confirm("Replace ALL data on this device with the backup?")) return;
    try {
      const data = JSON.parse(await file.text());
      await importAllJson(data);
      markFileBackupSaved();
      scheduleFullBackup(exportAllJson);
      toast("Restored from backup file");
      document.getElementById("onboard").hidden = true;
      loadDay();
      if (document.getElementById("view-progress")?.classList.contains("active")) loadProgress();
    } catch (err) {
      toast("Restore failed: " + err.message);
    }
  }
  document.getElementById("export-json-btn").onclick = doBackup;
  document.getElementById("backup-btn").onclick = doBackup;
  const backupBtn2 = document.getElementById("backup-btn-info");
  if (backupBtn2) backupBtn2.onclick = doBackup;
  document.getElementById("restore-input").onchange = async (e) => {
    await restoreFromFile(e.target.files?.[0]);
    e.target.value = "";
  };
  const restoreInput2 = document.getElementById("restore-input-info");
  if (restoreInput2) {
    restoreInput2.onchange = async (e) => {
      await restoreFromFile(e.target.files?.[0]);
      e.target.value = "";
    };
  }
  const restoreOnboard = document.getElementById("restore-input-onboard");
  if (restoreOnboard) {
    restoreOnboard.onchange = async (e) => {
      await restoreFromFile(e.target.files?.[0]);
      e.target.value = "";
    };
  }
  document.getElementById("export-csv-btn").onclick = async () => {
    const all = await (await import("./db.js")).dbGetAll("diary");
    const lines = [
      "date,meal,food,servings,calories,protein,carbs,fat,fiber",
      ...all.map(
        (r) =>
          `${r.entry_date},${r.meal},"${(r.food_name || "").replace(/"/g, '""')}",${r.servings},${r.calories},${r.protein},${r.carbs},${r.fat},${r.fiber}`
      ),
    ];
    downloadBlob(
      `diary-${todayISO()}.csv`,
      new Blob([lines.join("\n")], { type: "text/csv" })
    );
    toast("CSV exported");
  };

  // Install PWA � iOS Safari is primary (no beforeinstallprompt on iOS)
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;

  function openIosInstallHelp() {
    document.getElementById("ios-install-modal").hidden = false;
  }
  function closeIosInstallHelp() {
    document.getElementById("ios-install-modal").hidden = true;
  }
  document.getElementById("close-ios-install").onclick = closeIosInstallHelp;
  document.getElementById("ios-install-done").onclick = () => {
    closeIosInstallHelp();
    localStorage.setItem("ct-install-dismiss", "1");
    document.getElementById("install-banner").classList.remove("show");
  };
  document.getElementById("ios-install-modal").addEventListener("click", (e) => {
    if (e.target.id === "ios-install-modal") closeIosInstallHelp();
  });
  const infoIosBtn = document.getElementById("info-show-ios-steps");
  if (infoIosBtn) infoIosBtn.onclick = openIosInstallHelp;
  const updateBtns = [
    document.getElementById("btn-check-update"),
    document.getElementById("btn-check-update-info"),
  ].filter(Boolean);
  updateBtns.forEach((btn) => {
    btn.onclick = () => checkForAppUpdate({ manual: true });
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    // Android/desktop Chrome only � still supported, not our focus
    e.preventDefault();
    deferredInstall = e;
    if (!isIos && !localStorage.getItem("ct-install-dismiss") && !isStandalone) {
      document.getElementById("install-title").textContent = "Install MacroLedger";
      document.getElementById("install-hint").textContent =
        "Install for an app icon and offline use.";
      document.getElementById("install-btn").textContent = "Install";
      document.getElementById("install-banner").classList.add("show");
    }
  });

  document.getElementById("install-btn").onclick = async () => {
    if (isIos || !deferredInstall) {
      openIosInstallHelp();
      return;
    }
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    document.getElementById("install-banner").classList.remove("show");
  };
  document.getElementById("install-dismiss").onclick = () => {
    localStorage.setItem("ct-install-dismiss", "1");
    document.getElementById("install-banner").classList.remove("show");
  };

  if (isIos && !isStandalone && !localStorage.getItem("ct-install-dismiss")) {
    document.getElementById("install-title").textContent = "Install on iPhone";
    document.getElementById("install-hint").innerHTML =
      "Safari ? Share ? <strong>Add to Home Screen</strong> for an app icon &amp; offline use.";
    document.getElementById("install-btn").textContent = "Show steps";
    document.getElementById("install-banner").classList.add("show");
  }
  if (isStandalone) {
    document.getElementById("install-banner").classList.remove("show");
    document.getElementById("storage-label").textContent = "Home Screen app � on device";
  }

  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      document.getElementById("exercise-modal").hidden = true;
    }
  });
}

function renderMicroBars(d) {
  const el = document.getElementById("micro-bars");
  if (!el) return;
  if (!settings || settings.show_micros === "0") {
    el.innerHTML = "";
    return;
  }
  const items = [
    { key: "sodium_mg", goalKey: "sodium", label: "Sodium", unit: "mg", cls: "sodium" },
    { key: "sugar_g", goalKey: "sugar", label: "Sugar", unit: "g", cls: "sugar" },
  ];
  el.innerHTML = items
    .map((m) => {
      const used = d.totals[m.key] || 0;
      const goal = d.goals[m.goalKey] || 1;
      const p = pct(used, goal);
      const left = goal - used;
      return `<div class="macro ${m.cls}">
        <div class="macro-head"><span>${m.label}</span><strong>${formatNum(used)}${m.unit} / ${formatNum(goal)}${m.unit}</strong></div>
        <div class="bar"><i style="width:${p}%"></i></div>
        <div class="macro-head" style="margin-top:0.25rem;margin-bottom:0">
          <span style="font-size:0.68rem">${left >= 0 ? formatNum(left) + m.unit + " left" : formatNum(Math.abs(left)) + m.unit + " over"}</span>
        </div>
      </div>`;
    })
    .join("");
}

function fillProtocolSelect(sel, selected) {
  if (!sel) return;
  const cur = selected || sel.value || "16:8";
  sel.innerHTML = Object.entries(PROTOCOLS)
    .map(([id, meta]) => `<option value="${id}">${meta.label} — ${meta.blurb}</option>`)
    .join("");
  if (PROTOCOLS[cur]) sel.value = cur;
  else sel.value = "16:8";
}

function renderFastingCard() {
  const card = document.getElementById("fasting-card");
  if (!card || !settings) return;
  try {
    const st = getFastingStatus(settings, new Date());
    const phaseEl = document.getElementById("fasting-phase");
    const timerEl = document.getElementById("fasting-timer");
    const detailEl = document.getElementById("fasting-detail");
    const prog = document.getElementById("fasting-progress");
    if (phaseEl) {
      phaseEl.textContent = st.phase === "off" ? "Off" : st.phase === "fasting" ? "Fasting" : "Eating";
      phaseEl.className = "fasting-phase " + st.phase;
    }
    const sum = st.summary || protocolSummary(settings);
    const titleEl = document.getElementById("fasting-title");
    if (titleEl) {
      titleEl.textContent = st.enabled ? sum.label : "Intermittent fasting";
    }
    if (!st.enabled) {
      if (timerEl) timerEl.textContent = "—";
      if (detailEl) {
        detailEl.textContent =
          "Turn On below, then pick any window (12:12, 14:10, 16:8, 18:6, custom…).";
      }
      if (prog) prog.style.width = "0%";
    } else {
      if (timerEl) timerEl.textContent = fmtDuration(st.msRemaining);
      if (detailEl) detailEl.textContent = `${st.title} · ${st.detail}`;
      if (prog) {
        prog.style.width = `${Math.min(100, st.progress * 100)}%`;
        prog.style.background = st.phase === "fasting" ? "var(--protein)" : "var(--accent)";
      }
    }

    // Sync quick controls (without fighting user mid-edit)
    const en = document.getElementById("fast-enabled-quick");
    const prot = document.getElementById("fast-protocol-quick");
    const start = document.getElementById("fast-start-quick");
    const custom = document.getElementById("fast-custom-quick");
    const customWrap = document.getElementById("fast-custom-wrap");
    const sumEl = document.getElementById("fast-window-summary");
    if (prot && (prot.options.length === 0 || prot.options.length < Object.keys(PROTOCOLS).length)) {
      fillProtocolSelect(prot, settings.fasting_protocol || "16:8");
    }
    if (en && document.activeElement !== en) en.value = settings.fasting_enabled === "1" ? "1" : "0";
    if (prot && document.activeElement !== prot) prot.value = settings.fasting_protocol || "16:8";
    if (start && document.activeElement !== start) start.value = settings.eating_window_start || "12:00";
    if (custom && document.activeElement !== custom) custom.value = settings.custom_eat_hours || "8";
    if (customWrap) customWrap.hidden = (settings.fasting_protocol || "16:8") !== "custom";
    if (sumEl) {
      const s = protocolSummary(settings);
      const { h, min } = (() => {
        const m = String(settings.eating_window_start || "12:00").match(/(\d+):(\d+)/);
        return m ? { h: +m[1], min: +m[2] } : { h: 12, min: 0 };
      })();
      const endMins = h * 60 + min + s.eat * 60;
      const eh = Math.floor(endMins / 60) % 24;
      const em = Math.round(endMins % 60);
      const endStr = `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
      sumEl.textContent =
        settings.fasting_enabled === "1"
          ? `Schedule: ${s.text}. Eating about ${settings.eating_window_start || "12:00"} → ~${endStr}.`
          : `Preview: ${s.text}. Turn On to run the timer.`;
    }

    const goalsSum = document.getElementById("goals-fast-summary");
    if (goalsSum) {
      const s = protocolSummary(settings);
      goalsSum.textContent = `Your window: ${s.text} (starts ${settings.eating_window_start || "12:00"}).`;
    }

    if (fastingTimerId) clearInterval(fastingTimerId);
    if (st.enabled) {
      fastingTimerId = setInterval(() => {
        if (document.getElementById("view-diary")?.classList.contains("active")) {
          renderFastingCard();
        }
      }, 1000);
    }
  } catch (err) {
    console.warn("renderFastingCard failed", err);
  }
}

function setupFastingButtons() {
  const endBtn = document.getElementById("fasting-end-meal");
  const clearBtn = document.getElementById("fasting-clear-meal");
  const resetBtn = document.getElementById("fasting-reset-timer");

  const saveQuick = async (partial, msg) => {
    await setSettings(partial);
    settings = await getSettings();
    if (msg) toast(msg);
    renderFastingCard();
  };

  if (endBtn) {
    endBtn.onclick = async () => {
      await saveQuick(
        { last_meal_ended_at: new Date().toISOString(), fasting_enabled: "1" },
        "Timer started — fasting from now"
      );
    };
  }
  if (clearBtn) {
    clearBtn.onclick = async () => {
      await saveQuick({ last_meal_ended_at: "" }, "Using daily schedule only");
    };
  }
  if (resetBtn) {
    resetBtn.onclick = async () => {
      // Full timer reset: clear meal override, keep protocol, re-enable
      await saveQuick(
        { last_meal_ended_at: "", fasting_enabled: "1" },
        "Timer reset to your schedule"
      );
    };
  }

  const en = document.getElementById("fast-enabled-quick");
  const prot = document.getElementById("fast-protocol-quick");
  const start = document.getElementById("fast-start-quick");
  const custom = document.getElementById("fast-custom-quick");

  fillProtocolSelect(prot, settings?.fasting_protocol || "16:8");

  if (en) {
    en.onchange = () => saveQuick({ fasting_enabled: en.value }, en.value === "1" ? "Fasting on" : "Fasting off");
  }
  if (prot) {
    prot.onchange = async () => {
      const wrap = document.getElementById("fast-custom-wrap");
      if (wrap) wrap.hidden = prot.value !== "custom";
      await saveQuick(
        { fasting_protocol: prot.value, fasting_enabled: "1" },
        `Window: ${PROTOCOLS[prot.value]?.label || prot.value}`
      );
    };
  }
  if (start) {
    start.onchange = () => saveQuick({ eating_window_start: start.value || "12:00", fasting_enabled: "1" }, "Eating start updated");
  }
  if (custom) {
    custom.onchange = () =>
      saveQuick(
        { custom_eat_hours: custom.value || "8", fasting_protocol: "custom", fasting_enabled: "1" },
        `Custom: ${custom.value}h eating window`
      );
  }

  // Goals form: show custom field + live summary when protocol changes
  const goalsProt = document.getElementById("set-fasting-protocol");
  const goalsCustom = document.getElementById("set-custom-eat");
  if (goalsProt) {
    goalsProt.onchange = () => {
      if (goalsCustom) {
        goalsCustom.closest("label")?.classList.toggle("dim", goalsProt.value !== "custom");
      }
      // preview only until Save
      const s = {
        ...(settings || {}),
        fasting_protocol: goalsProt.value,
        custom_eat_hours: goalsCustom?.value || "8",
        eating_window_start: document.getElementById("set-eating-start")?.value || "12:00",
        fasting_enabled: document.getElementById("set-fasting-enabled")?.value || "0",
      };
      const sum = protocolSummary(s);
      const el = document.getElementById("goals-fast-summary");
      if (el) el.textContent = `Preview: ${sum.text}. Save goals to apply.`;
    };
  }
}

function setupRestaurantBuilder() {
  const sel = document.getElementById("rb-restaurant");
  if (!sel) return;
  sel.innerHTML = RESTAURANT_BUILDERS.map(
    (b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`
  ).join("");
  rbState.builderId = RESTAURANT_BUILDERS[0].id;
  rbState.formatId = RESTAURANT_BUILDERS[0].formats[0].id;
  rbState.selected = {};
  sel.onchange = () => {
    rbState.builderId = sel.value;
    const b = RESTAURANT_BUILDERS.find((x) => x.id === rbState.builderId);
    rbState.formatId = b.formats[0].id;
    rbState.selected = {};
    renderRestaurantBuilder();
  };
  document.getElementById("rb-log-btn").onclick = () => logRestaurantBuild(false);
  document.getElementById("rb-save-btn").onclick = () => logRestaurantBuild(true);
  const go = document.getElementById("btn-restaurant-build");
  if (go) {
    go.onclick = () => {
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.querySelector('.nav-tab[data-view="meals"]')?.classList.add("active");
      document.getElementById("view-meals").classList.add("active");
      renderRestaurantBuilder();
      loadMealsView();
    };
  }
  renderRestaurantBuilder();
}

function getRbBuilder() {
  return RESTAURANT_BUILDERS.find((b) => b.id === rbState.builderId) || RESTAURANT_BUILDERS[0];
}

function getRbFormat() {
  const b = getRbBuilder();
  return b.formats.find((f) => f.id === rbState.formatId) || b.formats[0];
}

function renderRestaurantBuilder() {
  const b = getRbBuilder();
  const fmtEl = document.getElementById("rb-formats");
  const groupsEl = document.getElementById("rb-groups");
  if (!fmtEl || !groupsEl) return;

  fmtEl.innerHTML = b.formats
    .map(
      (f) =>
        `<button type="button" class="pill ${rbState.formatId === f.id ? "active" : ""}" data-f="${f.id}">${escapeHtml(f.label)}</button>`
    )
    .join("");
  fmtEl.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      rbState.formatId = btn.dataset.f;
      renderRestaurantBuilder();
    };
  });

  groupsEl.innerHTML = b.groups
    .map((g) => {
      // hide tortilla group unless burrito-like
      if (g.id === "tortilla") {
        const fmt = getRbFormat();
        if (fmt && fmt.tortilla === false) return "";
      }
      const cur = rbState.selected[g.id];
      const opts = g.options
        .map((o, idx) => {
          const active = g.multi
            ? Array.isArray(cur) && cur.includes(o.name)
            : cur === o.name;
          return `<button type="button" class="rb-opt ${active ? "active" : ""}" data-g="${g.id}" data-i="${idx}" data-multi="${g.multi ? "1" : "0"}">${escapeHtml(o.name)} <span style="opacity:.7">${Math.round(o.calories)} cal</span></button>`;
        })
        .join("");
      return `<div class="rb-group"><h4>${escapeHtml(g.label)}${g.required ? " *" : ""}${g.multi ? " (multi)" : ""}</h4><div class="rb-opts">${opts}</div></div>`;
    })
    .join("");

  groupsEl.querySelectorAll(".rb-opt").forEach((btn) => {
    btn.onclick = () => {
      const gid = btn.dataset.g;
      const idx = Number(btn.dataset.i);
      const group = b.groups.find((x) => x.id === gid);
      if (!group) return;
      const n = group.options[idx]?.name;
      if (!n) return;
      const multi = btn.dataset.multi === "1";
      if (multi) {
        const arr = Array.isArray(rbState.selected[gid]) ? [...rbState.selected[gid]] : [];
        const i = arr.indexOf(n);
        if (i >= 0) arr.splice(i, 1);
        else arr.push(n);
        rbState.selected[gid] = arr;
      } else {
        rbState.selected[gid] = rbState.selected[gid] === n ? null : n;
      }
      renderRestaurantBuilder();
    };
  });

  const totals = sumSelection(b, rbState.selected, getRbFormat());
  document.getElementById("rb-totals").innerHTML = `
    <div class="macro-chips">${MacroLedgers(totals.protein, totals.carbs, totals.fat, { calories: totals.calories })}</div>
    <div class="macro-chips" style="margin-top:0.35rem">
      <span class="chip cal"><span class="chip-l">Na</span> ${formatNum(totals.sodium_mg)}mg</span>
      <span class="chip carbs"><span class="chip-l">Sugar</span> ${formatNum(totals.sugar_g, 1)}g</span>
      <span class="chip fiber"><span class="chip-l">Fiber</span> ${formatNum(totals.fiber, 1)}g</span>
    </div>`;
}

async function logRestaurantBuild(saveToo) {
  const b = getRbBuilder();
  const fmt = getRbFormat();
  const lines = selectionToLines(b, rbState.selected, fmt);
  if (!lines.length) {
    toast("Pick at least one item");
    return;
  }
  const meal = guessMealSlot();
  for (const line of lines) {
    await addDiaryEntry({
      ...line,
      entry_date: currentDate,
      meal,
      source: "restaurant_builder",
      user_verified: true,
    });
  }
  if (saveToo) {
    const totals = sumSelection(b, rbState.selected, fmt);
    await saveMeal({
      name: `${b.name} ${fmt.label}`,
      is_recipe: false,
      meal_type: meal,
      items: lines,
      totals,
    });
    toast(`Logged & saved ${lines.length} items`);
  } else {
    toast(`Logged ${lines.length} items to ${meal}`);
  }
  loadDay();
}

async function tryRestoreUserData() {
  // 1) Migrate from old IndexedDB names (rebrand wiped this before)
  try {
    await migrateLegacyDatabases();
  } catch (e) {
    console.warn("IDB migrate failed", e);
  }

  // 2) If still no profile, restore full localStorage backup
  let s = await getSettings();
  if (s.onboarding_complete === "1" || (s.body_weight_lb && String(s.body_weight_lb).trim())) {
    saveProfileBackup(s);
    scheduleFullBackup(exportAllJson);
    return { restored: false };
  }

  const full = loadLocalBackup();
  if (full && (full.settings || full.diary)) {
    try {
      await importAllJson(full);
      await setSettings({ onboarding_complete: "1" });
      toast("Restored your saved diary & profile");
      return { restored: true };
    } catch (e) {
      console.warn("full restore failed", e);
    }
  }

  // 3) Profile-only backup
  const prof = loadProfileBackup();
  if (prof?.settings) {
    try {
      await setSettings({ ...prof.settings, onboarding_complete: "1" });
      toast("Restored your profile settings");
      return { restored: true };
    } catch (e) {
      console.warn("profile restore failed", e);
    }
  }
  return { restored: false };
}

// ---- App updates (never delete Home Screen icon) ----
let swReg = null;
const SW_RELOAD_KEY = "ml_sw_reload_at";

function wireServiceWorkerLifecycle() {
  if (!("serviceWorker" in navigator)) return;
  // Reload at most once per 60s — prevents infinite reload loops on iPhone
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    try {
      const last = parseInt(sessionStorage.getItem(SW_RELOAD_KEY) || "0", 10) || 0;
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem(SW_RELOAD_KEY, String(Date.now()));
    } catch {
      /* private mode */
    }
    // Quiet reload — no version hunting for non-tech users
    setTimeout(() => {
      try {
        window.location.reload();
      } catch {
        /* ignore */
      }
    }, 350);
  });
}

async function checkForAppUpdate({ manual = false } = {}) {
  if (!("serviceWorker" in navigator)) {
    if (manual) toast("Updates aren’t available in this browser");
    return;
  }
  if (!navigator.onLine) {
    if (manual) toast("Go online to check for updates");
    return;
  }
  try {
    if (manual) toast("Checking for updates…");
    const reg = swReg || (await navigator.serviceWorker.getRegistration()) || null;
    if (!reg) {
      if (manual) {
        // Hard refresh path without SW thrash
        window.location.reload();
      }
      return;
    }
    await reg.update();
    if (reg.waiting) {
      applyWaitingServiceWorker(reg, { quiet: !manual });
      if (manual) toast("Update found — applying…");
      return;
    }
    if (reg.installing) {
      if (manual) toast("Downloading update…");
      return;
    }
    if (manual) {
      toast("You’re up to date");
      window.location.reload();
    }
  } catch (e) {
    console.warn("update check failed", e);
    if (manual) toast("Update check failed — try again online");
  }
}

function applyWaitingServiceWorker(reg, { quiet = true } = {}) {
  if (!reg?.waiting) return false;
  try {
    // Allow one controllerchange reload for this update
    sessionStorage.setItem(SW_RELOAD_KEY, "0");
  } catch {
    /* private mode */
  }
  reg.waiting.postMessage("SKIP_WAITING");
  if (!quiet) toast("Updating…");
  return true;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  wireServiceWorkerLifecycle();
  try {
    // Stable URL (no query) so registration does not thrash every version bump
    swReg = await navigator.serviceWorker.register("./sw-ml.js", {
      updateViaCache: "none",
    });
    // Quiet auto-update: apply new versions without asking users to hunt for buttons
    if (swReg.waiting) applyWaitingServiceWorker(swReg);
    swReg.update().catch(() => {});
    swReg.addEventListener("updatefound", () => {
      const nw = swReg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          applyWaitingServiceWorker(swReg, { quiet: true });
        }
      });
    });
    // Recheck when app comes back online or to foreground
    window.addEventListener("online", () => swReg?.update?.().catch(() => {}));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") swReg?.update?.().catch(() => {});
    });
    console.log("SW registered", swReg.scope);
  } catch (e) {
    console.warn("SW failed", e);
  }
}

// ---- boot ----
async function boot() {
  // Never leave photo overlay stuck open from a prior crash
  try {
    const busy = document.getElementById("photo-busy-modal");
    if (busy) busy.hidden = true;
  } catch {
    /* ok */
  }

  try {
    setup();
  } catch (err) {
    console.error("setup failed", err);
    toast("Something went wrong — close and reopen the app while online");
  }

  try {
    setupFastingButtons();
    setupRestaurantBuilder();
  } catch (err) {
    console.warn("secondary setup failed", err);
  }

  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", () => toggleLightDark());

  // Recover data BEFORE seed/onboarding so updates don't wipe you
  try {
    await tryRestoreUserData();
  } catch (err) {
    console.warn("restore failed", err);
  }

  // Apply saved theme ASAP
  try {
    const s0 = await getSettings();
    applyTheme(s0.ui_theme || "light");
  } catch {
    applyTheme("light");
  }

  try {
    await ensureSeeded(SEED_FOODS);
    const addedRestaurants = await ensureRestaurantFoods(RESTAURANT_FOODS, "eastcoast_v2");
    if (addedRestaurants > 0) {
      console.log(`Added ${addedRestaurants} restaurant foods`);
    }
  } catch (err) {
    console.warn("seed failed", err);
  }

  try {
    if (await needsOnboarding()) {
      document.getElementById("onboard").hidden = false;
      onboardStep = 0;
      showOnboardStep();
    } else {
      const s = await getSettings();
      saveProfileBackup(s);
      scheduleFullBackup(exportAllJson);
      const days = daysSinceFileBackup();
      if (days > 7) {
        setTimeout(() => {
          toast("Tip: Progress → Save backup file (keeps data if icon is removed)");
        }, 2500);
      }
    }
  } catch (err) {
    console.warn("onboarding gate failed", err);
  }

  // Register SW last — never block the diary on SW
  registerServiceWorker().catch((e) => console.warn(e));

  try {
    await loadDay();
  } catch (err) {
    console.error("loadDay failed", err);
    toast("Couldn’t load your diary — try Restore from file on Progress, or reopen online");
  }
}

boot().catch((err) => {
  console.error(err);
  toast("Failed to start: " + err.message);
});
