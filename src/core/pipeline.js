// src/core/pipeline.js
import { nowIso, addDaysIso } from "../utils/time.js";
import { getUserPrefs, upsertUserPrefs } from "./state.js";

/**
 * Cache colonne messages per evitare PRAGMA ad ogni insert/list.
 * { hasChannel: boolean, hasContact: boolean }
 */
let _messagesColsCache = null;

function getMessagesCols(db) {
  if (_messagesColsCache) return _messagesColsCache;

  try {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all();
    const names = new Set((cols || []).map((c) => String(c?.name || "").toLowerCase()));
    _messagesColsCache = {
      hasChannel: names.has("channel"),
      hasContact: names.has("contact"),
    };
  } catch {
    // se per qualsiasi motivo PRAGMA fallisse, fallback safe
    _messagesColsCache = { hasChannel: false, hasContact: false };
  }

  return _messagesColsCache;
}

export function createDealForCompany({ cfg, db, chatId, company, channel }) {
  const prefs = getUserPrefs({ db, chatId });
  const nextFollow = addDaysIso(prefs.followupDays || cfg.FOLLOWUP_DAYS_DEFAULT);

  const dealId = db
    .prepare(
      `
INSERT INTO deals(chat_id, company_id, stage, role_target, role_why, channel, next_followup_at, created_at)
VALUES(?,?,?,?,?,?,?,?)
`
    )
    .run(
      String(chatId),
      company.id,
      "Da_contattare",
      company.roleTarget,
      company.roleWhy,
      channel,
      nextFollow,
      nowIso()
    ).lastInsertRowid;

  const deal = db.prepare(`SELECT * FROM deals WHERE id=?`).get(dealId);

  // salva draft in prefs (per /ok)
  upsertUserPrefs({
    db,
    chatId,
    patch: {
      lastDraftMessage: {
        companyName: company.name,
        text: company.messageDraft,
        // channel qui è utile se vuoi già mostrarlo
        channel: channel || null,
        contact: null,
      },
    },
  });

  return {
    ...deal,
    roleTarget: deal.role_target,
    roleWhy: deal.role_why,
    messageDraft: company.messageDraft,
    channel: deal.channel,
  };
}

export function setDealStage({ db, chatId, companyName, stage }) {
  const row = db
    .prepare(
      `
SELECT d.id AS deal_id
FROM deals d
JOIN companies c ON c.id=d.company_id
WHERE d.chat_id=? AND c.chat_id=? AND c.name=?
ORDER BY d.id DESC LIMIT 1
`
    )
    .get(String(chatId), String(chatId), companyName);

  if (!row) return false;

  const prefs = getUserPrefs({ db, chatId });
  const nextFollow = stage === "Contattato" ? addDaysIso(prefs.followupDays || 5) : null;

  db.prepare(`UPDATE deals SET stage=?, next_followup_at=? WHERE id=?`).run(stage, nextFollow, row.deal_id);
  return true;
}

export function addNote({ db, chatId, companyName, text }) {
  const c = db
    .prepare(`SELECT id FROM companies WHERE chat_id=? AND name=? ORDER BY id DESC LIMIT 1`)
    .get(String(chatId), companyName);

  if (!c) return false;

  db.prepare(`INSERT INTO notes(chat_id, company_id, text, created_at) VALUES(?,?,?,?)`).run(
    String(chatId),
    c.id,
    String(text),
    nowIso()
  );

  return true;
}

/**
 * Ora supporta opzionalmente channel/contact (senza rompere DB vecchi).
 * Se la tabella messages non ha colonne channel/contact, salva solo text.
 */
export function recordOutboundMessage({ db, chatId, companyName, text, channel = null, contact = null }) {
  const row = db
    .prepare(
      `
SELECT d.id AS deal_id
FROM deals d
JOIN companies c ON c.id=d.company_id
WHERE d.chat_id=? AND c.chat_id=? AND c.name=?
ORDER BY d.id DESC LIMIT 1
`
    )
    .get(String(chatId), String(chatId), companyName);

  if (!row) return false;

  const cols = getMessagesCols(db);

  // insert dinamico: se esistono le colonne, le usiamo; altrimenti fallback
  if (cols.hasChannel && cols.hasContact) {
    db.prepare(
      `INSERT INTO messages(chat_id, deal_id, direction, text, channel, contact, created_at) VALUES(?,?,?,?,?,?,?)`
    ).run(String(chatId), row.deal_id, "OUTBOUND", String(text), channel, contact, nowIso());
    return true;
  }

  if (cols.hasChannel && !cols.hasContact) {
    db.prepare(`INSERT INTO messages(chat_id, deal_id, direction, text, channel, created_at) VALUES(?,?,?,?,?,?)`).run(
      String(chatId),
      row.deal_id,
      "OUTBOUND",
      String(text),
      channel,
      nowIso()
    );
    return true;
  }

  if (!cols.hasChannel && cols.hasContact) {
    db.prepare(`INSERT INTO messages(chat_id, deal_id, direction, text, contact, created_at) VALUES(?,?,?,?,?,?)`).run(
      String(chatId),
      row.deal_id,
      "OUTBOUND",
      String(text),
      contact,
      nowIso()
    );
    return true;
  }

  // fallback base (schema attuale tuo)
  db.prepare(`INSERT INTO messages(chat_id, deal_id, direction, text, created_at) VALUES(?,?,?,?,?)`).run(
    String(chatId),
    row.deal_id,
    "OUTBOUND",
    String(text),
    nowIso()
  );
  return true;
}

/**
 * Lista pipeline "ricca": include canale, ruolo, prossimo followup,
 * e ultimo OUTBOUND con data + (se presenti) contact/channel.
 */
export function listPipeline({ db, chatId }) {
  // join sull’ultimo OUTBOUND per ogni deal
  const rows = db
    .prepare(
      `
SELECT
  c.name AS companyName,
  d.stage AS stage,
  d.channel AS channel,
  d.role_target AS roleTarget,
  d.role_why AS roleWhy,
  d.next_followup_at AS nextFollowupAt,

  m.created_at AS lastOutboundAt,
  m.text AS lastOutboundText,
  -- se le colonne non esistono, SQLite darà errore: quindi facciamo query compatibile sotto
  -- (vedi logica qui sotto)
  NULL AS lastOutboundChannel,
  NULL AS lastOutboundContact

FROM deals d
JOIN companies c ON c.id=d.company_id

LEFT JOIN messages m
  ON m.id = (
    SELECT m2.id
    FROM messages m2
    WHERE m2.deal_id = d.id AND m2.direction = 'OUTBOUND'
    ORDER BY m2.id DESC
    LIMIT 1
  )

WHERE d.chat_id=? AND c.chat_id=?
ORDER BY d.id DESC
LIMIT 50
`
    )
    .all(String(chatId), String(chatId));

  // Se il DB ha colonne channel/contact su messages, rifacciamo query “estesa”
  const cols = getMessagesCols(db);
  if (cols.hasChannel || cols.hasContact) {
    const rows2 = db
      .prepare(
        `
SELECT
  c.name AS companyName,
  d.stage AS stage,
  d.channel AS channel,
  d.role_target AS roleTarget,
  d.role_why AS roleWhy,
  d.next_followup_at AS nextFollowupAt,

  m.created_at AS lastOutboundAt,
  m.text AS lastOutboundText,
  ${cols.hasChannel ? "m.channel" : "NULL"} AS lastOutboundChannel,
  ${cols.hasContact ? "m.contact" : "NULL"} AS lastOutboundContact

FROM deals d
JOIN companies c ON c.id=d.company_id

LEFT JOIN messages m
  ON m.id = (
    SELECT m2.id
    FROM messages m2
    WHERE m2.deal_id = d.id AND m2.direction = 'OUTBOUND'
    ORDER BY m2.id DESC
    LIMIT 1
  )

WHERE d.chat_id=? AND c.chat_id=?
ORDER BY d.id DESC
LIMIT 50
`
      )
      .all(String(chatId), String(chatId));

    return rows2 || [];
  }

  return rows || [];
}

// --- DB CLEANUP HELPERS ---

function q(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}
function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}
function get(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

/**
 * Cancella TUTTO per chatId (companies/deals/messages/notes) in modo consistente.
 * Ordine: messages -> notes -> deals -> companies.
 */
export function purgeAllForChat({ db, chatId }) {
  const cid = String(chatId);

  const tx = db.transaction(() => {
    q(db, `DELETE FROM messages WHERE chat_id=?`, [cid]);
    q(db, `DELETE FROM notes    WHERE chat_id=?`, [cid]);
    q(db, `DELETE FROM deals    WHERE chat_id=?`, [cid]);
    q(db, `DELETE FROM companies WHERE chat_id=?`, [cid]);
  });

  tx();
  return true;
}

/**
 * Pulizia selettiva per chatId.
 * flags: { messages?: boolean, notes?: boolean, deals?: boolean, companies?: boolean }
 * Nota: se cancelli companies, prima cancella deals/messages/notes.
 */
export function purgeForChat({ db, chatId, flags }) {
  const cid = String(chatId);

  const tx = db.transaction(() => {
    if (flags?.messages) q(db, `DELETE FROM messages WHERE chat_id=?`, [cid]);
    if (flags?.notes)    q(db, `DELETE FROM notes    WHERE chat_id=?`, [cid]);
    if (flags?.deals)    q(db, `DELETE FROM deals    WHERE chat_id=?`, [cid]);
    if (flags?.companies) q(db, `DELETE FROM companies WHERE chat_id=?`, [cid]);
  });

  tx();
  return true;
}

/**
 * Cancella una singola azienda (per nome) + tutto lo storico collegato.
 * Prende l'azienda più recente con quel nome per il chatId.
 */
export function deleteCompanyCascade({ db, chatId, companyName }) {
  const cid = String(chatId);
  const name = String(companyName || "").trim();
  if (!name) return { ok: false, reason: "missing_name" };

  const c = get(
    db,
    `SELECT id, name FROM companies WHERE chat_id=? AND name=? ORDER BY id DESC LIMIT 1`,
    [cid, name]
  );
  if (!c) return { ok: false, reason: "not_found" };

  const tx = db.transaction(() => {
    // trova deals della company
    const deals = all(db, `SELECT id FROM deals WHERE chat_id=? AND company_id=?`, [cid, c.id]);
    const dealIds = deals.map(d => d.id);

    // cancella messages per quei deals
    if (dealIds.length) {
      // costruisci IN (?, ?, ...)
      const ph = dealIds.map(() => "?").join(",");
      q(db, `DELETE FROM messages WHERE chat_id=? AND deal_id IN (${ph})`, [cid, ...dealIds]);
    }

    // cancella notes per company
    q(db, `DELETE FROM notes WHERE chat_id=? AND company_id=?`, [cid, c.id]);

    // cancella deals
    q(db, `DELETE FROM deals WHERE chat_id=? AND company_id=?`, [cid, c.id]);

    // cancella company
    q(db, `DELETE FROM companies WHERE chat_id=? AND id=?`, [cid, c.id]);
  });

  tx();
  return { ok: true, deletedCompanyId: c.id, deletedCompanyName: c.name };
}

/**
 * Garbage collection: tieni solo gli ultimi N deals (per chatId), cancella il resto a cascata.
 */
export function pruneDealsKeepLastN({ db, chatId, keep = 50 }) {
  const cid = String(chatId);
  const k = Math.max(0, Number(keep) || 0);

  const tx = db.transaction(() => {
    const keepIds = all(
      db,
      `SELECT id FROM deals WHERE chat_id=? ORDER BY id DESC LIMIT ?`,
      [cid, k]
    ).map(r => r.id);

    // se nulla da tenere, purge all deals+messages (non companies)
    if (!keepIds.length) {
      q(db, `DELETE FROM messages WHERE chat_id=?`, [cid]);
      q(db, `DELETE FROM deals WHERE chat_id=?`, [cid]);
      return;
    }

    const ph = keepIds.map(() => "?").join(",");
    // cancella messages dei deals NON in keep
    q(
      db,
      `DELETE FROM messages WHERE chat_id=? AND deal_id NOT IN (${ph})`,
      [cid, ...keepIds]
    );
    // cancella deals NON in keep
    q(
      db,
      `DELETE FROM deals WHERE chat_id=? AND id NOT IN (${ph})`,
      [cid, ...keepIds]
    );
  });

  tx();
  return true;
}