import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

export function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // 1) base schema (create if not exists)
  db.exec(`
CREATE TABLE IF NOT EXISTS user_prefs (
  chat_id TEXT PRIMARY KEY,
  prefs_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  sector TEXT,
  country TEXT,
  size_est TEXT,
  signals_json TEXT,
  source_urls_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  role_target TEXT,
  role_why TEXT,
  channel TEXT,
  next_followup_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  deal_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(deal_id) REFERENCES deals(id)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  company_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_companies_chat ON companies(chat_id);
CREATE INDEX IF NOT EXISTS idx_deals_chat ON deals(chat_id);
CREATE INDEX IF NOT EXISTS idx_deals_followup ON deals(chat_id, next_followup_at);
CREATE INDEX IF NOT EXISTS idx_messages_deal ON messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  `);

  // 2) migrations (ALTER TABLE add columns if missing)
  migrate(db);

  return db;
}

/* --------------------------- migrations --------------------------- */

function migrate(db) {
  // messages: channel/contact (per mostrare “punto di contatto” in pipeline)
  ensureColumn(db, "messages", "channel", "TEXT");
  ensureColumn(db, "messages", "contact", "TEXT");

  // companies: dove salvare contatto trovato da ricerca/AI (prima dell’outbound)
  // lo teniamo come JSON, così può contenere più campi (name/role/url/email/evidence_ref/confidence)
  ensureColumn(db, "companies", "contact_hint_json", "TEXT");

  // indici aggiuntivi utili
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_dir ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);
}

function ensureColumn(db, table, column, ddlType) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = (cols || []).some((c) => String(c.name).toLowerCase() === String(column).toLowerCase());
  if (exists) return;

  // ALTER TABLE safe
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
}