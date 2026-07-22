/**
 * Intermittent fasting schedule + live timer.
 *
 * Settings:
 *  fasting_enabled: "0"|"1"
 *  fasting_protocol: "12:12"|"14:10"|"15:9"|"16:8"|"18:6"|"20:4"|"omad"|"custom"
 *  eating_window_start: "HH:MM" local (when eating window opens)
 *  custom_eat_hours: hours allowed to eat when protocol=custom (e.g. 8)
 *  last_meal_ended_at: ISO — "I just finished eating" override
 */

export const PROTOCOLS = {
  "12:12": { eatHours: 12, label: "12:12", blurb: "12h fast · 12h eat" },
  "14:10": { eatHours: 10, label: "14:10", blurb: "14h fast · 10h eat" },
  "15:9": { eatHours: 9, label: "15:9", blurb: "15h fast · 9h eat" },
  "16:8": { eatHours: 8, label: "16:8", blurb: "16h fast · 8h eat (popular)" },
  "18:6": { eatHours: 6, label: "18:6", blurb: "18h fast · 6h eat" },
  "20:4": { eatHours: 4, label: "20:4", blurb: "20h fast · 4h eat" },
  omad: { eatHours: 1, label: "OMAD", blurb: "~23h fast · ~1h eat" },
  custom: { eatHours: null, label: "Custom", blurb: "Set your own eat hours" },
};

export function parseHHMM(s, fallback = "12:00") {
  const m = String(s || fallback).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 12, min: 0 };
  return { h: Math.min(23, parseInt(m[1], 10)), min: Math.min(59, parseInt(m[2], 10)) };
}

export function eatHoursFromSettings(s) {
  const p = s.fasting_protocol || "16:8";
  if (p === "custom") {
    if (s.custom_eat_hours != null && String(s.custom_eat_hours).trim() !== "") {
      return Math.min(23, Math.max(1, parseFloat(s.custom_eat_hours) || 8));
    }
    if (s.custom_fast_hours != null && String(s.custom_fast_hours).trim() !== "") {
      return Math.min(23, Math.max(1, 24 - (parseFloat(s.custom_fast_hours) || 16)));
    }
    return 8;
  }
  return PROTOCOLS[p]?.eatHours ?? 8;
}

export function protocolSummary(settings) {
  const eat = eatHoursFromSettings(settings);
  const fast = Math.round((24 - eat) * 10) / 10;
  const p = settings.fasting_protocol || "16:8";
  const label = PROTOCOLS[p]?.label || p;
  return { label, eat, fast, text: `${fast}h fast · ${eat}h eat` };
}

/** Today's eating window [start, end). End may be next calendar day. */
export function windowForDay(settings, now = new Date()) {
  const { h, min } = parseHHMM(settings.eating_window_start || "12:00");
  const eatH = eatHoursFromSettings(settings);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  const end = new Date(start.getTime() + eatH * 3600 * 1000);
  return { start, end, eatHours: eatH, fastHours: 24 - eatH };
}

export function getFastingStatus(settings, now = new Date()) {
  if (settings.fasting_enabled !== "1") {
    return {
      enabled: false,
      phase: "off",
      title: "Fasting off",
      detail: "Turn on below or in Goals. Pick any window — not just 16:8.",
      progress: 0,
      msRemaining: 0,
      msElapsed: 0,
      window: null,
      protocol: settings.fasting_protocol || "16:8",
      summary: protocolSummary(settings),
    };
  }

  const win = windowForDay(settings, now);
  let phase;
  let phaseStart;
  let phaseEnd;
  let title;
  let detail;

  if (now >= win.start && now < win.end) {
    phase = "eating";
    phaseStart = win.start;
    phaseEnd = win.end;
    title = "Eating window";
    detail = `Open until ${fmtTime(win.end)} · ${protocolSummary(settings).text}`;
  } else if (now < win.start) {
    phase = "fasting";
    phaseEnd = win.start;
    phaseStart = new Date(phaseEnd.getTime() - win.fastHours * 3600 * 1000);
    title = "Fasting";
    detail = `Eat from ${fmtTime(win.start)} · ${protocolSummary(settings).text}`;
  } else {
    phase = "fasting";
    phaseStart = win.end;
    const nextStart = new Date(win.start.getTime() + 86400000);
    phaseEnd = nextStart;
    title = "Fasting";
    detail = `Eat from ${fmtTime(nextStart)} · ${protocolSummary(settings).text}`;
  }

  // "I just finished eating" override
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
        detail = `Until ${fmtTime(fastEnd)} (timer from last meal)`;
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
    summary: protocolSummary(settings),
  };
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

export function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
