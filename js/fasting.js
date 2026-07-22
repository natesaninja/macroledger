/**
 * Intermittent fasting schedule + live timer.
 * Settings:
 *  fasting_enabled: "0"|"1"
 *  fasting_protocol: "16:8"|"18:6"|"20:4"|"omad"|"custom"
 *  eating_window_start: "HH:MM" local (start of eating window)
 *  custom_fast_hours: "16" when protocol=custom
 *  last_meal_ended_at: ISO timestamp (optional override "I just finished eating")
 */

export const PROTOCOLS = {
  "16:8": { eatHours: 8, label: "16:8 (popular)" },
  "18:6": { eatHours: 6, label: "18:6" },
  "20:4": { eatHours: 4, label: "20:4" },
  omad: { eatHours: 1, label: "OMAD (~1 hour)" },
  custom: { eatHours: null, label: "Custom" },
};

export function parseHHMM(s, fallback = "12:00") {
  const m = String(s || fallback).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 12, min: 0 };
  return { h: Math.min(23, parseInt(m[1], 10)), min: Math.min(59, parseInt(m[2], 10)) };
}

export function eatHoursFromSettings(s) {
  const p = s.fasting_protocol || "16:8";
  if (p === "custom") {
    const n = parseFloat(s.custom_eat_hours || s.custom_fast_hours);
    // custom_eat_hours preferred; if only fast hours given: eat = 24 - fast
    if (s.custom_eat_hours) return Math.min(23, Math.max(1, parseFloat(s.custom_eat_hours) || 8));
    if (s.custom_fast_hours) return Math.min(23, Math.max(1, 24 - (parseFloat(s.custom_fast_hours) || 16)));
    return 8;
  }
  return PROTOCOLS[p]?.eatHours || 8;
}

/**
 * Build today's eating window [start, end) in Date objects (local).
 * If end crosses midnight, end is tomorrow.
 */
export function windowForDay(settings, now = new Date()) {
  const { h, min } = parseHHMM(settings.eating_window_start || "12:00");
  const eatH = eatHoursFromSettings(settings);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  const end = new Date(start.getTime() + eatH * 3600 * 1000);
  return { start, end, eatHours: eatH, fastHours: 24 - eatH };
}

/**
 * If user set last_meal_ended_at, fasting started then and lasts (24 - eat) hours
 * until they can eat again — classic "started fast after last bite".
 * Prefer schedule windows unless last_meal is more recent and still in fast.
 */
export function getFastingStatus(settings, now = new Date()) {
  if (settings.fasting_enabled !== "1") {
    return {
      enabled: false,
      phase: "off",
      title: "Fasting off",
      detail: "Turn on in Goals to track your window.",
      progress: 0,
      msRemaining: 0,
      msElapsed: 0,
      window: null,
    };
  }

  const win = windowForDay(settings, now);
  let phase;
  let phaseStart;
  let phaseEnd;
  let title;
  let detail;

  // Schedule-based
  const inWindow =
    (now >= win.start && now < win.end) ||
    // window that started yesterday still open
    (() => {
      const yStart = new Date(win.start.getTime() - 86400000);
      const yEnd = new Date(win.end.getTime() - 86400000);
      return now >= yStart && now < yEnd;
    })();

  // Also check tomorrow's window if start is later today and we're before it — fasting
  if (now >= win.start && now < win.end) {
    phase = "eating";
    phaseStart = win.start;
    phaseEnd = win.end;
    title = "Eating window";
    detail = `Open until ${fmtTime(win.end)}`;
  } else if (now < win.start) {
    // fasting until today's window
    phase = "fasting";
    // previous window end = start - fast? actually previous end = today's start (if contiguous) 
    // or yesterday's end
    const prevEnd = win.start;
    const prevStart = new Date(prevEnd.getTime() - win.fastHours * 3600 * 1000);
    phaseStart = prevStart;
    phaseEnd = prevEnd;
    title = "Fasting";
    detail = `Eat from ${fmtTime(win.start)}`;
  } else {
    // after today's window ended — fasting until tomorrow's start
    phase = "fasting";
    phaseStart = win.end;
    const nextStart = new Date(win.start.getTime() + 86400000);
    phaseEnd = nextStart;
    title = "Fasting";
    detail = `Eat from ${fmtTime(nextStart)}`;
  }

  // Optional: "I just finished eating" override
  if (settings.last_meal_ended_at) {
    const mealEnd = new Date(settings.last_meal_ended_at);
    if (!Number.isNaN(mealEnd.getTime())) {
      const fastMs = win.fastHours * 3600 * 1000;
      const fastEnd = new Date(mealEnd.getTime() + fastMs);
      if (now < fastEnd) {
        phase = "fasting";
        phaseStart = mealEnd;
        phaseEnd = fastEnd;
        title = "Fasting";
        detail = `Until ${fmtTime(fastEnd)} (from last meal)`;
      }
    }
  }

  const total = Math.max(1, phaseEnd - phaseStart);
  const elapsed = Math.max(0, Math.min(total, now - phaseStart));
  const remaining = Math.max(0, phaseEnd - now);

  return {
    enabled: true,
    phase,
    title,
    detail,
    progress: elapsed / total,
    msRemaining: remaining,
    msElapsed: elapsed,
    window: win,
    protocol: settings.fasting_protocol || "16:8",
  };
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

export function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
