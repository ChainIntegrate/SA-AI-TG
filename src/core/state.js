import { nowIso } from "../utils/time.js";

export function getUserPrefs({ db, chatId }) {
  const row = db.prepare(`SELECT prefs_json FROM user_prefs WHERE chat_id=?`).get(String(chatId));
  if (!row) return defaultPrefs();
  try { return JSON.parse(row.prefs_json); } catch { return defaultPrefs(); }
}

export function upsertUserPrefs({ db, chatId, patch }) {
  const cur = getUserPrefs({ db, chatId });
  const next = { ...cur, ...patch, updatedAt: nowIso() };
  db.prepare(`
INSERT INTO user_prefs(chat_id, prefs_json, updated_at)
VALUES(?,?,?)
ON CONFLICT(chat_id) DO UPDATE SET prefs_json=excluded.prefs_json, updated_at=excluded.updated_at
  `).run(String(chatId), JSON.stringify(next), nowIso());
  return next;
}

function defaultPrefs() {
  return {
    paese: "Italia",
    canalePreferito: "LinkedIn",
    followupDays: 5,
    minDip: 30,
    maxDip: 120,
    esclusioni: [],
    lastDraftMessage: null
  };
}
