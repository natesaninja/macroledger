/**
 * IndexedDB — MacroLedger user data
 *
 * PERMANENT name — never rename this. Past renames (calorietrack-pwa → MacroLedger-pwa)
 * wiped profiles; we migrate from legacy names once.
 */
const DB_NAME = "ml-user-data-v1";
const DB_VERSION = 2;

/** Old DB names from earlier builds (PowerShell renames changed these accidentally). */
const LEGACY_DB_NAMES = [
  "calorietrack-pwa",
  "CalorieTrack-pwa",
  "MacroLedger-pwa",
  "MacroChip-pwa",
  "macrochip-pwa",
  "Macro Chip-pwa",
];

function openNamedDb(name, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => {
      // Only create schema for our permanent DB (or empty legacy opens)
      if (name !== DB_NAME && e.oldVersion === 0) {
        // Don't invent schema on accidental legacy creates — abort by not creating? 
        // Actually opening non-existent legacy just creates empty - we'll detect empty.
      }
      const db = req.result;
      const old = e.oldVersion;
      ensureSchema(db, old);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function ensureSchema(db, oldVersion) {
  const old = oldVersion || 0;
  if (old < 1) {
    if (!db.objectStoreNames.contains("settings")) {
      db.createObjectStore("settings", { keyPath: "key" });
    }
    if (!db.objectStoreNames.contains("foods")) {
      const foods = db.createObjectStore("foods", { keyPath: "id", autoIncrement: true });
      foods.createIndex("name", "name", { unique: false });
      foods.createIndex("barcode", "barcode", { unique: false });
    }
    if (!db.objectStoreNames.contains("diary")) {
      const diary = db.createObjectStore("diary", { keyPath: "id", autoIncrement: true });
      diary.createIndex("entry_date", "entry_date", { unique: false });
    }
    if (!db.objectStoreNames.contains("exercise")) {
      const ex = db.createObjectStore("exercise", { keyPath: "id", autoIncrement: true });
      ex.createIndex("entry_date", "entry_date", { unique: false });
    }
    if (!db.objectStoreNames.contains("weight")) {
      const w = db.createObjectStore("weight", { keyPath: "id", autoIncrement: true });
      w.createIndex("log_date", "log_date", { unique: true });
    }
    if (!db.objectStoreNames.contains("water")) {
      db.createObjectStore("water", { keyPath: "log_date" });
    }
    if (!db.objectStoreNames.contains("meta")) {
      db.createObjectStore("meta", { keyPath: "key" });
    }
  }
  if (old < 2) {
    if (!db.objectStoreNames.contains("favorites")) {
      db.createObjectStore("favorites", { keyPath: "food_id" });
    }
    if (!db.objectStoreNames.contains("recents")) {
      const r = db.createObjectStore("recents", { keyPath: "food_id" });
      r.createIndex("last_used_at", "last_used_at", { unique: false });
    }
    if (!db.objectStoreNames.contains("saved_meals")) {
      db.createObjectStore("saved_meals", { keyPath: "id", autoIncrement: true });
    }
    if (!db.objectStoreNames.contains("biometrics")) {
      const b = db.createObjectStore("biometrics", { keyPath: "id", autoIncrement: true });
      b.createIndex("log_date", "log_date", { unique: false });
      b.createIndex("kind", "kind", { unique: false });
    }
    if (!db.objectStoreNames.contains("daily_targets")) {
      db.createObjectStore("daily_targets", { keyPath: "date" });
    }
    if (!db.objectStoreNames.contains("streaks")) {
      db.createObjectStore("streaks", { keyPath: "key" });
    }
  }
}

async function dumpDb(db) {
  const out = {};
  for (const name of Array.from(db.objectStoreNames)) {
    out[name] = await reqToPromise(db.transaction(name, "readonly").objectStore(name).getAll());
  }
  return out;
}

async function countUseful(dump) {
  const settings = dump.settings || [];
  const diary = dump.diary || [];
  const weight = dump.weight || [];
  const hasProfile = settings.some(
    (s) =>
      (s.key === "onboarding_complete" && String(s.value) === "1") ||
      (s.key === "body_weight_lb" && String(s.value || "").trim() !== "") ||
      (s.key === "calorie_goal" && String(s.value || "") !== "" && String(s.value) !== "2000")
  );
  return {
    score: (hasProfile ? 100 : 0) + diary.length * 2 + weight.length * 5 + settings.length,
    hasProfile,
    diary: diary.length,
  };
}

let _migratePromise = null;

/** One-time: copy richest legacy DB into permanent ml-user-data-v1 */
export async function migrateLegacyDatabases() {
  if (_migratePromise) return _migratePromise;
  _migratePromise = (async () => {
    const main = await openNamedDb(DB_NAME, DB_VERSION);
    let mainDump = await dumpDb(main);
    let mainScore = await countUseful(mainDump);

    let best = { name: DB_NAME, dump: mainDump, score: mainScore.score };

    let known = null;
    try {
      if (indexedDB.databases) {
        known = new Set((await indexedDB.databases()).map((d) => d.name).filter(Boolean));
      }
    } catch {
      known = null;
    }

    for (const legacy of LEGACY_DB_NAMES) {
      try {
        // Avoid creating empty DBs just by probing
        if (known && !known.has(legacy)) continue;
        const db = await openNamedDb(legacy, DB_VERSION);
        const dump = await dumpDb(db);
        const useful = await countUseful(dump);
        db.close();
        if (useful.score > best.score) {
          best = { name: legacy, dump, score: useful.score };
        }
      } catch (e) {
        console.warn("legacy scan failed", legacy, e);
      }
    }

    // If main is empty-ish and best is a legacy DB, import it
    if (best.name !== DB_NAME && best.score > mainScore.score) {
      console.log("Migrating user data from", best.name, "score", best.score);
      await importDumpIntoMain(best.dump);
      mainDump = best.dump;
    }
    main.close();
    return best;
  })();
  return _migratePromise;
}

async function importDumpIntoMain(dump) {
  const db = await openNamedDb(DB_NAME, DB_VERSION);
  const stores = Array.from(db.objectStoreNames);
  // Clear then put
  for (const name of stores) {
    if (!dump[name]) continue;
    const tx = db.transaction(name, "readwrite");
    tx.objectStore(name).clear();
    await txDone(tx);
    const tx2 = db.transaction(name, "readwrite");
    const store = tx2.objectStore(name);
    for (const row of dump[name]) {
      store.put(row);
    }
    await txDone(tx2);
  }
  db.close();
}

function openDb() {
  return openNamedDb(DB_NAME, DB_VERSION);
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(store, key) {
  const db = await openDb();
  return reqToPromise(db.transaction(store, "readonly").objectStore(store).get(key));
}

export async function dbGetAll(store) {
  const db = await openDb();
  return reqToPromise(db.transaction(store, "readonly").objectStore(store).getAll());
}

export async function dbPut(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const id = await reqToPromise(tx.objectStore(store).put(value));
  await txDone(tx);
  return id;
}

export async function dbAdd(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const id = await reqToPromise(tx.objectStore(store).add(value));
  await txDone(tx);
  return id;
}

export async function dbDelete(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function dbClear(store) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await txDone(tx);
}

export async function dbIndexGetAll(store, indexName, query) {
  const db = await openDb();
  const idx = db.transaction(store, "readonly").objectStore(store).index(indexName);
  return reqToPromise(idx.getAll(query));
}

// ---- Settings ----
export const DEFAULT_SETTINGS = {
  calorie_goal: "2000",
  protein_goal: "150",
  carbs_goal: "200",
  fat_goal: "65",
  fiber_goal: "25",
  water_goal: "8",
  sodium_goal: "2300",
  sugar_goal: "50",
  show_micros: "1",
  fasting_enabled: "0",
  fasting_protocol: "16:8",
  eating_window_start: "12:00",
  custom_eat_hours: "8",
  last_meal_ended_at: "",
  user_name: "You",
  body_weight_lb: "",
  height_in: "",
  age: "",
  sex: "male",
  activity_level: "moderate",
  goal_type: "maintain",
  protein_per_lb: "0.8",
  diet_type: "standard",
  macro_mode: "beginner",
  onboarding_complete: "0",
  /** Set when user (or auto-personalize) has intentionally set calorie targets */
  targets_confirmed: "0",
  adaptive_enabled: "1",
  units: "imperial",
  ui_theme: "light",
  /** Shared Cloudflare Worker URL for free multi-user photo macros */
  photo_proxy_url: "",
  /** Optional personal Gemini key (this device only; not for public sharing) */
  photo_gemini_key: "",
};

export async function getSettings() {
  const rows = await dbGetAll("settings");
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

/**
 * True when calorie target still looks like the factory default and was never
 * replaced by onboarding / Apply suggested / a manual non-default save.
 */
export function looksLikeDefaultCalorieGoal(settings) {
  const c = String(settings?.calorie_goal ?? "").trim();
  return c === "" || c === "2000";
}

export async function setSettings(partial) {
  for (const [key, value] of Object.entries(partial)) {
    await dbPut("settings", { key, value: String(value ?? "") });
  }
  const all = await getSettings();
  // Notify app layer to autosave (dynamic import avoids circular deps)
  try {
    const { saveProfileBackup, scheduleFullBackup } = await import("./persist.js");
    saveProfileBackup(all);
    scheduleFullBackup(exportAllJson);
  } catch {
    /* ok */
  }
  return all;
}

export function goalsFromSettings(s) {
  return {
    calories: parseFloat(s.calorie_goal) || 2000,
    protein: parseFloat(s.protein_goal) || 150,
    carbs: parseFloat(s.carbs_goal) || 200,
    fat: parseFloat(s.fat_goal) || 65,
    fiber: parseFloat(s.fiber_goal) || 25,
    water: parseInt(s.water_goal, 10) || 8,
    sodium: parseFloat(s.sodium_goal) || 2300,
    sugar: parseFloat(s.sugar_goal) || 50,
  };
}

// ---- Foods ----
export async function listFoods() {
  return dbGetAll("foods");
}

export async function searchFoods(q, limit = 40) {
  const all = await listFoods();
  const needle = (q || "").trim().toLowerCase();
  let list = all;
  if (needle) {
    list = all.filter(
      (f) =>
        (f.name || "").toLowerCase().includes(needle) ||
        (f.brand || "").toLowerCase().includes(needle) ||
        (f.barcode || "").includes(needle)
    );
    list.sort((a, b) => {
      const an = (a.name || "").toLowerCase().startsWith(needle) ? 0 : 1;
      const bn = (b.name || "").toLowerCase().startsWith(needle) ? 0 : 1;
      if (an !== bn) return an - bn;
      return (b.is_custom ? 1 : 0) - (a.is_custom ? 1 : 0);
    });
  } else {
    list = [...all].sort((a, b) => {
      if (!!b.is_custom !== !!a.is_custom) return b.is_custom ? 1 : -1;
      return (a.name || "").localeCompare(b.name || "");
    });
  }
  return list.slice(0, limit);
}

export async function getFood(id) {
  return dbGet("foods", id);
}

export async function findByBarcode(code) {
  const all = await dbIndexGetAll("foods", "barcode", code);
  return all[0] || null;
}

export async function addFood(food) {
  const row = {
    name: food.name,
    brand: food.brand || "",
    serving_size: food.serving_size || "1 serving",
    calories: Number(food.calories) || 0,
    protein: Number(food.protein) || 0,
    carbs: Number(food.carbs) || 0,
    fat: Number(food.fat) || 0,
    fiber: Number(food.fiber) || 0,
    sodium_mg: Number(food.sodium_mg) || 0,
    sugar_g: Number(food.sugar_g) || 0,
    barcode: food.barcode || "",
    source: food.source || (food.is_custom !== false ? "custom" : "seed"),
    confidence: food.confidence != null ? Number(food.confidence) : 1,
    verified: food.verified !== false,
    is_custom: food.is_custom !== false,
    micronutrients: food.micronutrients || {},
  };
  const id = await dbAdd("foods", row);
  return { ...row, id };
}

export async function deleteFood(id) {
  const f = await getFood(id);
  if (!f) throw new Error("Not found");
  if (!f.is_custom) throw new Error("Only custom foods can be deleted");
  await dbDelete("foods", id);
  await dbDelete("favorites", id).catch(() => {});
  await dbDelete("recents", id).catch(() => {});
}

// Favorites / recents
export async function toggleFavorite(foodId) {
  const existing = await dbGet("favorites", foodId);
  if (existing) {
    await dbDelete("favorites", foodId);
    return false;
  }
  await dbPut("favorites", { food_id: foodId, created_at: Date.now() });
  return true;
}

export async function listFavorites() {
  const favs = await dbGetAll("favorites");
  const out = [];
  for (const f of favs) {
    const food = await getFood(f.food_id);
    if (food) out.push(food);
  }
  return out;
}

export async function touchRecent(foodId) {
  const prev = await dbGet("recents", foodId);
  await dbPut("recents", {
    food_id: foodId,
    last_used_at: Date.now(),
    use_count: (prev?.use_count || 0) + 1,
  });
}

export async function listRecents(limit = 12) {
  const all = await dbGetAll("recents");
  all.sort((a, b) => b.last_used_at - a.last_used_at);
  const out = [];
  for (const r of all.slice(0, limit)) {
    const food = await getFood(r.food_id);
    if (food) out.push({ ...food, use_count: r.use_count });
  }
  return out;
}

// ---- Diary ----
export async function diaryForDate(date) {
  const rows = await dbIndexGetAll("diary", "entry_date", date);
  const order = { breakfast: 1, lunch: 2, dinner: 3, snacks: 4 };
  return rows.sort((a, b) => (order[a.meal] || 9) - (order[b.meal] || 9) || a.id - b.id);
}

export async function addDiaryEntry(entry) {
  const row = {
    entry_date: entry.entry_date,
    meal: entry.meal,
    food_id: entry.food_id ?? null,
    food_name: entry.food_name,
    serving_size: entry.serving_size || "1 serving",
    servings: Number(entry.servings) || 1,
    calories: Number(entry.calories) || 0,
    protein: Number(entry.protein) || 0,
    carbs: Number(entry.carbs) || 0,
    fat: Number(entry.fat) || 0,
    fiber: Number(entry.fiber) || 0,
    sodium_mg: Number(entry.sodium_mg) || 0,
    sugar_g: Number(entry.sugar_g) || 0,
    source: entry.source || "manual",
    confidence: entry.confidence != null ? Number(entry.confidence) : 1,
    user_verified: entry.user_verified !== false,
    notes: entry.notes || "",
  };
  const id = await dbAdd("diary", row);
  if (row.food_id) await touchRecent(row.food_id);
  await bumpStreak(row.entry_date);
  try {
    const { scheduleFullBackup } = await import("./persist.js");
    scheduleFullBackup(exportAllJson);
  } catch {
    /* ok */
  }
  return { ...row, id };
}

export async function updateDiaryServings(id, servings) {
  const row = await dbGet("diary", id);
  if (!row) throw new Error("Entry not found");
  const old = row.servings || 1;
  row.servings = servings;
  for (const k of ["calories", "protein", "carbs", "fat", "fiber", "sodium_mg", "sugar_g"]) {
    row[k] = Math.round(((row[k] || 0) / old) * servings * 100) / 100;
  }
  await dbPut("diary", row);
  return row;
}

export async function verifyDiaryEntry(id) {
  const row = await dbGet("diary", id);
  if (!row) return;
  row.user_verified = true;
  row.confidence = 1;
  await dbPut("diary", row);
  return row;
}

export async function deleteDiary(id) {
  await dbDelete("diary", id);
}

export async function copyDiary(fromDate, toDate, meal = null) {
  let rows = await diaryForDate(fromDate);
  if (meal) rows = rows.filter((r) => r.meal === meal);
  if (!rows.length) throw new Error("No entries to copy");
  let n = 0;
  for (const r of rows) {
    const { id, ...rest } = r;
    await addDiaryEntry({ ...rest, entry_date: toDate, source: "copy" });
    n++;
  }
  return n;
}

// ---- Saved meals / recipes ----
export async function saveMeal(meal) {
  const row = {
    name: meal.name,
    meal_type: meal.meal_type || "any",
    items: meal.items || [],
    totals: meal.totals || {},
    is_recipe: !!meal.is_recipe,
    servings_default: meal.servings_default || 1,
    created_at: Date.now(),
  };
  const id = await dbAdd("saved_meals", row);
  return { ...row, id };
}

export async function listSavedMeals() {
  const all = await dbGetAll("saved_meals");
  return all.sort((a, b) => b.created_at - a.created_at);
}

export async function deleteSavedMeal(id) {
  await dbDelete("saved_meals", id);
}

export async function logSavedMeal(mealId, date, mealSlot, servingsMult = 1) {
  const meal = await dbGet("saved_meals", mealId);
  if (!meal) throw new Error("Meal not found");
  let n = 0;
  for (const item of meal.items || []) {
    await addDiaryEntry({
      entry_date: date,
      meal: mealSlot || "lunch",
      food_id: item.food_id || null,
      food_name: item.food_name || item.name,
      serving_size: item.serving_size || "1 serving",
      servings: (item.servings || 1) * servingsMult,
      calories: (item.calories || 0) * servingsMult,
      protein: (item.protein || 0) * servingsMult,
      carbs: (item.carbs || 0) * servingsMult,
      fat: (item.fat || 0) * servingsMult,
      fiber: (item.fiber || 0) * servingsMult,
      source: "saved_meal",
      user_verified: true,
    });
    n++;
  }
  return n;
}

// ---- Exercise ----
export async function exerciseForDate(date) {
  return dbIndexGetAll("exercise", "entry_date", date);
}

export async function addExercise(entry) {
  const row = {
    entry_date: entry.entry_date,
    name: entry.name,
    duration_min: Number(entry.duration_min) || 0,
    calories: Number(entry.calories) || 0,
    note: entry.note || "",
    source: entry.source || "manual",
  };
  const id = await dbAdd("exercise", row);
  return { ...row, id };
}

export async function deleteExercise(id) {
  await dbDelete("exercise", id);
}

// ---- Water / weight / biometrics ----
export async function getWater(date) {
  const r = await dbGet("water", date);
  return r ? r.glasses : 0;
}

export async function setWater(date, glasses) {
  await dbPut("water", { log_date: date, glasses: Math.max(0, glasses) });
}

export async function listWeight(limit = 60) {
  const all = await dbGetAll("weight");
  return all.sort((a, b) => b.log_date.localeCompare(a.log_date)).slice(0, limit);
}

export async function latestWeight() {
  const all = await listWeight(1);
  return all[0] || null;
}

export async function upsertWeight(log_date, weight_lb, note = "") {
  const db = await openDb();
  const existing = await reqToPromise(
    db.transaction("weight", "readonly").objectStore("weight").index("log_date").get(log_date)
  );
  if (existing) {
    existing.weight_lb = weight_lb;
    existing.note = note;
    await dbPut("weight", existing);
    await setSettings({ body_weight_lb: String(weight_lb) });
    return existing;
  }
  const row = { log_date, weight_lb, note };
  const id = await dbAdd("weight", row);
  await setSettings({ body_weight_lb: String(weight_lb) });
  return { ...row, id };
}

export async function deleteWeight(id) {
  await dbDelete("weight", id);
}

export async function addBiometric(entry) {
  const row = {
    log_date: entry.log_date,
    kind: entry.kind,
    value: Number(entry.value),
    unit: entry.unit || "",
    note: entry.note || "",
    source: entry.source || "manual",
  };
  const id = await dbAdd("biometrics", row);
  return { ...row, id };
}

export async function biometricsForDate(date) {
  return dbIndexGetAll("biometrics", "log_date", date);
}

// ---- Streaks ----
async function bumpStreak(entryDate) {
  const today = entryDate;
  const prev = await dbGet("streaks", "log");
  if (!prev) {
    await dbPut("streaks", { key: "log", current: 1, last_date: today, best: 1 });
    return;
  }
  if (prev.last_date === today) return;
  // compute day gap
  const a = new Date(prev.last_date + "T12:00:00");
  const b = new Date(today + "T12:00:00");
  const gap = Math.round((b - a) / 86400000);
  let current = prev.current || 0;
  if (gap === 1) current += 1;
  else if (gap > 1) current = 1;
  const best = Math.max(prev.best || 0, current);
  await dbPut("streaks", { key: "log", current, last_date: today, best });
}

export async function getStreak() {
  return (
    (await dbGet("streaks", "log")) || { key: "log", current: 0, last_date: "", best: 0 }
  );
}

// ---- Daily targets history ----
export async function putDailyTarget(row) {
  await dbPut("daily_targets", row);
}

export async function getDailyTarget(date) {
  return dbGet("daily_targets", date);
}

// ---- Seed ----
function foodRowFromTuple(f, source = "seed") {
  return {
    name: f[0],
    brand: f[1] || "",
    serving_size: f[2],
    calories: f[3],
    protein: f[4],
    carbs: f[5],
    fat: f[6],
    fiber: f[7] || 0,
    sodium_mg: f[8] != null ? f[8] : 0,
    sugar_g: f[9] != null ? f[9] : 0,
    barcode: "",
    source,
    confidence: 1,
    verified: true,
    is_custom: false,
    micronutrients: {},
  };
}

export async function ensureSeeded(seedFoods) {
  const meta = await dbGet("meta", "seeded");
  if (meta && meta.value) return false;
  const existing = await listFoods();
  if (existing.length) {
    await dbPut("meta", { key: "seeded", value: true });
    return false;
  }
  for (const f of seedFoods) {
    await dbAdd("foods", foodRowFromTuple(f, "seed"));
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await dbPut("settings", { key, value });
  }
  await dbPut("meta", { key: "seeded", value: true });
  return true;
}

/** Add restaurant menu items for installs that already finished base seed. */
export async function ensureRestaurantFoods(restaurantFoods, version = "eastcoast_v1") {
  const key = `restaurants_${version}`;
  const meta = await dbGet("meta", key);
  if (meta && meta.value) return 0;
  if (!restaurantFoods?.length) {
    await dbPut("meta", { key, value: true });
    return 0;
  }

  // Skip duplicates by brand+name
  const existing = await listFoods();
  const have = new Set(
    existing.map((f) => `${(f.brand || "").toLowerCase()}|${(f.name || "").toLowerCase()}`)
  );
  let added = 0;
  for (const f of restaurantFoods) {
    const k = `${(f[1] || "").toLowerCase()}|${(f[0] || "").toLowerCase()}`;
    if (have.has(k)) continue;
    await dbAdd("foods", foodRowFromTuple(f, "restaurant"));
    have.add(k);
    added++;
  }
  await dbPut("meta", { key, value: true });
  return added;
}

export async function exportAllJson() {
  return {
    version: 2,
    exported_at: new Date().toISOString(),
    settings: await getSettings(),
    foods: await listFoods(),
    diary: await dbGetAll("diary"),
    exercise: await dbGetAll("exercise"),
    weight: await dbGetAll("weight"),
    water: await dbGetAll("water"),
    favorites: await dbGetAll("favorites"),
    recents: await dbGetAll("recents"),
    saved_meals: await dbGetAll("saved_meals"),
    biometrics: await dbGetAll("biometrics"),
    daily_targets: await dbGetAll("daily_targets"),
    streaks: await dbGetAll("streaks"),
  };
}

export async function importAllJson(data) {
  if (!data || typeof data !== "object") throw new Error("Invalid backup");
  const stores = [
    "settings",
    "foods",
    "diary",
    "exercise",
    "weight",
    "water",
    "favorites",
    "recents",
    "saved_meals",
    "biometrics",
    "daily_targets",
    "streaks",
  ];
  for (const store of stores) {
    try {
      await dbClear(store);
    } catch {
      /* store may not exist on old backup */
    }
  }
  if (data.settings) {
    for (const [key, value] of Object.entries(data.settings)) {
      await dbPut("settings", { key, value: String(value ?? "") });
    }
  }
  const readd = async (store, rows) => {
    for (const r of rows || []) {
      const { id, ...rest } = r;
      if (store === "settings" || store === "water" || store === "meta" || store === "favorites" || store === "recents" || store === "daily_targets" || store === "streaks") {
        await dbPut(store, r);
      } else {
        await dbAdd(store, rest);
      }
    }
  };
  await readd("foods", data.foods);
  await readd("diary", data.diary);
  await readd("exercise", data.exercise);
  await readd("weight", data.weight);
  for (const w of data.water || []) await dbPut("water", w);
  for (const f of data.favorites || []) await dbPut("favorites", f);
  for (const r of data.recents || []) await dbPut("recents", r);
  await readd("saved_meals", data.saved_meals);
  await readd("biometrics", data.biometrics);
  for (const t of data.daily_targets || []) await dbPut("daily_targets", t);
  for (const s of data.streaks || []) await dbPut("streaks", s);
  await dbPut("meta", { key: "seeded", value: true });
}
