// src/core/memory.js
import { normalizeWhitespace, safeTruncate } from "../utils/text.js";

const MAX_TURNS = Number(process.env.MEMORY_MAX_TURNS || 18);
const MAX_FACTS = Number(process.env.MEMORY_MAX_FACTS || 40);
const MAX_SUMMARY_CHARS = Number(process.env.MEMORY_MAX_SUMMARY_CHARS || 2200);

function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Crea tabella memory se manca.
 * Passa l'istanza db (better-sqlite3) che già crei in initDb().
 */
export function memoryInit(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      chat_id TEXT PRIMARY KEY,
      facts_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      turns_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function loadRow(db, chatId) {
  const id = String(chatId);
  const row = db.prepare(`SELECT * FROM memory WHERE chat_id = ?`).get(id);
  if (row) return row;

  db.prepare(`INSERT INTO memory(chat_id) VALUES(?)`).run(id);
  return db.prepare(`SELECT * FROM memory WHERE chat_id = ?`).get(id);
}

function saveRow(db, chatId, { facts, summary, turns }) {
  const id = String(chatId);
  db.prepare(`
    UPDATE memory
       SET facts_json = ?,
           summary = ?,
           turns_json = ?,
           updated_at = datetime('now')
     WHERE chat_id = ?
  `).run(
    JSON.stringify(facts || []),
    summary || "",
    JSON.stringify(turns || []),
    id
  );
}

export function getMemory(db, chatId) {
  const row = loadRow(db, chatId);
  return {
    chatId: String(chatId),
    facts: parseJson(row.facts_json, []),
    summary: row.summary || "",
    turns: parseJson(row.turns_json, []),
    updatedAt: row.updated_at,
  };
}

export function addTurn(db, chatId, { role, text, ts = Date.now() }) {
  const mem = getMemory(db, chatId);

  const clean = normalizeWhitespace(String(text || ""));
  if (!clean) return mem;

  const turns = Array.isArray(mem.turns) ? mem.turns.slice() : [];
  turns.push({ role, text: safeTruncate(clean, 4000), ts });

  const trimmed = turns.slice(-MAX_TURNS);
  saveRow(db, chatId, { facts: mem.facts, summary: mem.summary, turns: trimmed });

  return { ...mem, turns: trimmed };
}

export function setSummary(db, chatId, summary) {
  const mem = getMemory(db, chatId);
  const s = safeTruncate(normalizeWhitespace(String(summary || "")), MAX_SUMMARY_CHARS);

  saveRow(db, chatId, { facts: mem.facts, summary: s, turns: mem.turns });
  return { ...mem, summary: s };
}

export function upsertFacts(db, chatId, newFacts = []) {
  const mem = getMemory(db, chatId);

  const existing = Array.isArray(mem.facts) ? mem.facts : [];
  const incoming = (Array.isArray(newFacts) ? newFacts : [])
    .map((x) => normalizeWhitespace(String(x || "")))
    .filter(Boolean);

  // dedupe case-insensitive
  const map = new Map();
  for (const f of existing) map.set(String(f).toLowerCase(), f);
  for (const f of incoming) map.set(String(f).toLowerCase(), f);

  const facts = Array.from(map.values()).slice(-MAX_FACTS);
  saveRow(db, chatId, { facts, summary: mem.summary, turns: mem.turns });
  return { ...mem, facts };
}

export function resetMemory(db, chatId) {
  const id = String(chatId);
  db.prepare(`
    UPDATE memory
       SET facts_json='[]',
           summary='',
           turns_json='[]',
           updated_at=datetime('now')
     WHERE chat_id=?
  `).run(id);

  return getMemory(db, chatId);
}

/**
 * Confeziona contesto “pronto” per prompt LLM
 */
export function buildLLMContext(db, chatId) {
  const mem = getMemory(db, chatId);

  const parts = [];
  if (mem.summary) parts.push(`CONTEXT SUMMARY:\n${mem.summary}`);

  if (mem.facts?.length) {
    parts.push(`KNOWN FACTS (persisted):\n- ${mem.facts.join("\n- ")}`);
  }

  if (mem.turns?.length) {
    const t = mem.turns.map((x) => `${String(x.role || "").toUpperCase()}: ${x.text}`).join("\n");
    parts.push(`RECENT TURNS:\n${t}`);
  }

  return parts.join("\n\n").trim();
}