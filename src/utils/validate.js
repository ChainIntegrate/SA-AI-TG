// src/utils/validate.js
import { extractUrls, normalizeWhitespace } from "./text.js";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function parseAllowedChatIds(raw) {
  // supporta "123,456" o "123 456"
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[\s,]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function isAllowedChatId(chatId, allowedList) {
  const id = String(chatId);
  if (!Array.isArray(allowedList) || allowedList.length === 0) return true; // se non setti, non blocca
  return allowedList.includes(id);
}

export function assertAllowedChatId(chatId, allowedList) {
  if (!isAllowedChatId(chatId, allowedList)) {
    throw new Error(`Unauthorized chat_id: ${chatId}`);
  }
}

export function validateNonEmptyText(s, { maxLen = 8000 } = {}) {
  const t = normalizeWhitespace(String(s || ""));
  if (!t) throw new Error("Empty text");
  if (t.length > maxLen) throw new Error(`Text too long (${t.length} > ${maxLen})`);
  return t;
}

export function validateUrl(url) {
  const u = String(url || "").trim();
  if (!u) throw new Error("Empty url");
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`Invalid url: ${u}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function pickFirstUrl(text) {
  const urls = extractUrls(text);
  if (!urls.length) return null;
  return validateUrl(urls[0]);
}

export function clampInt(n, { min = 0, max = 1_000_000 } = {}) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

/**
 * Per comandi tipo: /add <url> oppure /note testo...
 */
export function parseCommandArgs(args, { maxLen = 4000 } = {}) {
  const t = normalizeWhitespace(String(args || ""));
  if (!t) return "";
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}