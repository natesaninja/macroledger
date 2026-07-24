/**
 * Autosave so profile + diary survive app *code* updates.
 * - IndexedDB is primary
 * - localStorage mirror recovers if the IDB name was renamed or wiped
 *
 * CRITICAL (iPhone): Deleting the Home Screen icon often erases IndexedDB AND
 * localStorage for this site. Never delete the icon to "update" — use Info → Update app.
 * Keep a JSON backup in the Files app for phone switches.
 */

const LS_KEY = "ml_autosave_v1";
const LS_PROFILE_KEY = "ml_profile_v1";
const LS_FILE_BACKUP_AT = "ml_file_backup_at";
/** App shell cache name — client must not delete this (see app boot). */
export const APP_CACHE = "macroledger-v24";

let saveTimer = null;

export function loadLocalBackup() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function loadProfileBackup() {
  try {
    const raw = localStorage.getItem(LS_PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveProfileBackup(settings) {
  try {
    localStorage.setItem(
      LS_PROFILE_KEY,
      JSON.stringify({
        saved_at: new Date().toISOString(),
        settings: { ...settings, onboarding_complete: "1" },
      })
    );
  } catch (e) {
    console.warn("profile backup failed", e);
  }
}

export function scheduleFullBackup(exportFn) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const data = await exportFn();
      // Cap size — if too big, still keep profile
      const json = JSON.stringify(data);
      if (json.length > 4_500_000) {
        console.warn("Full backup too large for localStorage; profile only");
        if (data.settings) saveProfileBackup(data.settings);
        return;
      }
      localStorage.setItem(LS_KEY, json);
      if (data.settings) saveProfileBackup(data.settings);
    } catch (e) {
      console.warn("autosave failed", e);
    }
  }, 400);
}

export function clearLocalBackups() {
  try {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_PROFILE_KEY);
  } catch {
    /* ok */
  }
}

export function markFileBackupSaved() {
  try {
    localStorage.setItem(LS_FILE_BACKUP_AT, new Date().toISOString());
  } catch {
    /* ok */
  }
}

export function daysSinceFileBackup() {
  try {
    const raw = localStorage.getItem(LS_FILE_BACKUP_AT);
    if (!raw) return Infinity;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return Infinity;
    return (Date.now() - t) / (1000 * 60 * 60 * 24);
  } catch {
    return Infinity;
  }
}

/** True when local mirrors exist (survives some IDB glitches, not Home Screen delete). */
export function hasLocalMirror() {
  return !!(loadLocalBackup() || loadProfileBackup());
}
