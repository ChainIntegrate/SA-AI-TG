import { nowIso, addDaysIso } from "../utils/time.js";
import { getUserPrefs, upsertUserPrefs } from "./state.js";

export function createDealForCompany({ cfg, db, chatId, company, channel }) {
  const prefs = getUserPrefs({ db, chatId });
  const nextFollow = addDaysIso(prefs.followupDays || cfg.FOLLOWUP_DAYS_DEFAULT);

  const dealId = db.prepare(`
INSERT INTO deals(chat_id, company_id, stage, role_target, role_why, channel, next_followup_at, created_at)
VALUES(?,?,?,?,?,?,?,?)
  `).run(String(chatId), company.id, "Da_contattare", company.roleTarget, company.roleWhy, channel, nextFollow, nowIso()).lastInsertRowid;

  const deal = db.prepare(`SELECT * FROM deals WHERE id=?`).get(dealId);

  // salva draft in prefs (placeholder, lo setta analyzer)
  upsertUserPrefs({ db, chatId, patch: { lastDraftMessage: { companyName: company.name, text: company.messageDraft } } });

  return {
    ...deal,
    roleTarget: deal.role_target,
    roleWhy: deal.role_why,
    messageDraft: company.messageDraft
  };
}

export function setDealStage({ db, chatId, companyName, stage }) {
  const row = db.prepare(`
SELECT d.id AS deal_id
FROM deals d
JOIN companies c ON c.id=d.company_id
WHERE d.chat_id=? AND c.chat_id=? AND c.name=?
ORDER BY d.id DESC LIMIT 1
  `).get(String(chatId), String(chatId), companyName);
  if (!row) return false;

  const prefs = getUserPrefs({ db, chatId });
  const nextFollow = (stage === "Contattato") ? addDaysIso(prefs.followupDays || 5) : null;

  db.prepare(`UPDATE deals SET stage=?, next_followup_at=? WHERE id=?`)
    .run(stage, nextFollow, row.deal_id);
  return true;
}

export function addNote({ db, chatId, companyName, text }) {
  const c = db.prepare(`SELECT id FROM companies WHERE chat_id=? AND name=? ORDER BY id DESC LIMIT 1`)
    .get(String(chatId), companyName);
  if (!c) return false;
  db.prepare(`INSERT INTO notes(chat_id, company_id, text, created_at) VALUES(?,?,?,?)`)
    .run(String(chatId), c.id, String(text), nowIso());
  return true;
}

export function recordOutboundMessage({ db, chatId, companyName, text }) {
  const row = db.prepare(`
SELECT d.id AS deal_id
FROM deals d
JOIN companies c ON c.id=d.company_id
WHERE d.chat_id=? AND c.chat_id=? AND c.name=?
ORDER BY d.id DESC LIMIT 1
  `).get(String(chatId), String(chatId), companyName);
  if (!row) return false;
  db.prepare(`INSERT INTO messages(chat_id, deal_id, direction, text, created_at) VALUES(?,?,?,?,?)`)
    .run(String(chatId), row.deal_id, "OUTBOUND", String(text), nowIso());
  return true;
}

export function listPipeline({ db, chatId }) {
  const rows = db.prepare(`
SELECT c.name AS companyName, d.stage AS stage, d.next_followup_at AS nextFollowupAt
FROM deals d
JOIN companies c ON c.id=d.company_id
WHERE d.chat_id=? AND c.chat_id=?
ORDER BY d.id DESC
LIMIT 50
  `).all(String(chatId), String(chatId));
  return rows || [];
}
