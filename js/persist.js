/**
 * Autosave so profile + diary survive app updates.
 * - IndexedDB is primary
 * - localStorage mirror recovers if the IDB name was renamed or wiped
 *
 * IMPORTANT: Do NOT delete the Home Screen icon to "update" — that can erase data on iPhone.
 */

const LS_KEY = "ml_autosave_v1";
const LS_PROFILE_KEY = "ml_profile_v1";

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
