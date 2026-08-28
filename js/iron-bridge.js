/**
 * Pure Iron Ledger → MacroLedger handoff helpers.
 * Browser + node:test. Inject { sessionStorage, localStorage } in tests.
 */

export const HANDOFF_STORAGE_KEY = "il_macro_handoff_v1";
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

/**
 * Parse ?msets=chest:4,lats:3 from Iron handoff.
 * @param {string} raw
 * @returns {Record<string, number>}
 */
export function parseIronMsets(raw) {
  const out = {};
  String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [id, n] = pair.split(":");
      const v = parseInt(n, 10);
      if (id && v > 0) out[id.trim()] = v;
    });
  return out;
}

/** Dose-aware burn multiplier (Rough easier / OED harder). */
export function doseBurnMult(dose) {
  const d = String(dose || "").toLowerCase();
  if (d === "rough") return 0.85;
  if (d === "oed") return 1.1;
  return 1;
}

function decodeParam(raw) {
  const s = String(raw || "");
  if (!s) return "";
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function getter(src) {
  if (!src) return () => "";
  if (typeof src.get === "function") {
    return (k) => {
      const v = src.get(k);
      return v == null ? "" : String(v);
    };
  }
  if (typeof src === "string") {
    const sp = new URLSearchParams(src.startsWith("?") ? src.slice(1) : src);
    return (k) => sp.get(k) || "";
  }
  const obj = src.params && typeof src.params === "object" ? src.params : src;
  return (k) => {
    const v = obj[k];
    return v == null ? "" : String(v);
  };
}

/**
 * Parse Iron handoff from URLSearchParams, query string, or a plain/storage object.
 * @param {URLSearchParams|string|object} searchParams
 */
export function parseIronHandoffParams(searchParams) {
  const get = getter(searchParams);
  const from = String(get("from") || "").toLowerCase();
  const iron = String(get("iron") || "");
  const fromIron =
    iron === "1" || from === "iron-ledger" || from === "ironledger";

  const date = String(get("date") || "").slice(0, 10);
  const min = Math.max(0, parseFloat(get("min") || get("minutes") || "0") || 0);
  const name = decodeParam(get("name") || "") || "Iron Ledger · Strength";
  const sets = Math.max(0, parseInt(get("sets") || "0", 10) || 0);
  const dose = String(get("dose") || "").toLowerCase();
  const muscles = String(get("muscles") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  const msets = parseIronMsets(get("msets"));
  const mode = String(get("mode") || "").toLowerCase() || "med";
  const program = String(get("program") || "").trim();
  const label = decodeParam(get("label") || "");
  const bwKg = parseFloat(get("bw") || "0") || 0;
  const autoRaw = String(get("auto") || "").toLowerCase();
  const auto = autoRaw === "1" || autoRaw === "true";
  const slot = String(get("slot") || "").trim();
  const source = String(get("source") || "").trim();
  const writtenAt = get("writtenAt") || "";

  return {
    fromIron,
    date,
    min,
    name,
    sets,
    dose,
    muscles,
    msets,
    mode,
    program,
    label,
    bwKg,
    auto,
    slot,
    source,
    writtenAt,
  };
}

function isIronExerciseRow(e) {
  return e?.source === "iron_ledger" || String(e?.name || "").startsWith("Iron Ledger");
}

/**
 * Idempotent ingest: same Iron session already on the day.
 * @param {Array} existingExercises
 * @param {{ min?: number, name?: string }} hit
 */
export function isDuplicateIronExercise(existingExercises, { min, name } = {}) {
  const list = existingExercises || [];
  const dur = Number(min);
  const wantName = String(name || "").trim().toLowerCase();
  const hasDur = Number.isFinite(dur) && dur > 0;
  return list.some((e) => {
    if (!isIronExerciseRow(e)) return false;
    const sameDur = hasDur && Number(e.duration_min) === dur;
    const sameName = wantName && String(e.name || "").trim().toLowerCase() === wantName;
    if (hasDur && wantName) return sameDur || sameName;
    if (hasDur) return sameDur;
    if (wantName) return sameName;
    return false;
  });
}

function parseStoredPayload(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function writtenAtMs(payload) {
  if (!payload) return 0;
  const raw = payload.writtenAt;
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

function isFresh(payload, now = Date.now()) {
  const t = writtenAtMs(payload);
  if (!t) return false;
  return now - t <= HANDOFF_TTL_MS;
}

function storageBag(storage) {
  if (storage && (storage.sessionStorage || storage.localStorage)) return storage;
  return typeof globalThis !== "undefined" ? globalThis : {};
}

/**
 * Prefer sessionStorage; accept localStorage only if writtenAt is within 10 minutes.
 * @param {object} [storage]
 */
export function readStoredHandoff(storage) {
  const bag = storageBag(storage);
  try {
    const sessionRaw = bag.sessionStorage?.getItem?.(HANDOFF_STORAGE_KEY);
    const sessionPayload = parseStoredPayload(sessionRaw);
    if (sessionPayload) return sessionPayload;
  } catch {
    /* private mode */
  }
  try {
    const localRaw = bag.localStorage?.getItem?.(HANDOFF_STORAGE_KEY);
    const localPayload = parseStoredPayload(localRaw);
    if (localPayload && isFresh(localPayload)) return localPayload;
  } catch {
    /* private mode */
  }
  return null;
}

export function clearStoredHandoff(storage) {
  const bag = storageBag(storage);
  try {
    bag.sessionStorage?.removeItem?.(HANDOFF_STORAGE_KEY);
  } catch {
    /* ok */
  }
  try {
    bag.localStorage?.removeItem?.(HANDOFF_STORAGE_KEY);
  } catch {
    /* ok */
  }
}

/**
 * Storage payload wins over URL when present and fresh.
 * @returns {{ source: "storage"|"url"|null, params: object|null, raw: object|null }}
 */
export function resolveHandoffSource({ search = "", storage } = {}) {
  const stored = readStoredHandoff(storage);
  if (stored) {
    const params = parseIronHandoffParams(stored);
    if (params.fromIron) {
      return { source: "storage", params, raw: stored };
    }
    // Storage present but not marked from Iron — still prefer it if it has session fields
    if (params.min > 0 || params.date || (params.name && params.name !== "Iron Ledger · Strength")) {
      params.fromIron = true;
      return { source: "storage", params, raw: stored };
    }
  }
  const urlParams = parseIronHandoffParams(search);
  if (urlParams.fromIron) {
    return { source: "url", params: urlParams, raw: null };
  }
  return { source: null, params: null, raw: null };
}
