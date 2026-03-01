// src/utils/text.js

export function normalizeWhitespace(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function safeTruncate(s, maxChars = 2000, suffix = "…") {
  const str = String(s ?? "");
  if (str.length <= maxChars) return str;
  const cut = Math.max(0, maxChars - suffix.length);
  return str.slice(0, cut) + suffix;
}

export function stripCodeFences(s) {
  const str = String(s ?? "");
  return str.replace(/```[\s\S]*?```/g, "").trim();
}

export function extractUrls(s) {
  const str = String(s ?? "");
  const re = /\bhttps?:\/\/[^\s<>()]+/gi;
  const matches = str.match(re) || [];
  // normalizza e dedupe
  const out = [];
  const seen = new Set();
  for (const u of matches) {
    const cleaned = u.replace(/[),.!?]+$/g, "");
    const k = cleaned.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(cleaned);
    }
  }
  return out;
}

export function toBullets(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .map((x) => `- ${x}`)
    .join("\n");
}

export function compactJoin(parts = [], sep = "\n\n") {
  return (Array.isArray(parts) ? parts : [])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(sep)
    .trim();
}

/**
 * Spezza un testo in chunk “morbidi” (utile per prompt lunghi)
 */
export function chunkText(s, { maxLen = 3500 } = {}) {
  const text = normalizeWhitespace(s);
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const paras = text.split("\n\n");
  const chunks = [];
  let cur = "";

  for (const p of paras) {
    const cand = cur ? `${cur}\n\n${p}` : p;
    if (cand.length <= maxLen) {
      cur = cand;
      continue;
    }
    if (cur) chunks.push(cur);
    // se il paragrafo è gigantesco, splittalo duro
    if (p.length > maxLen) {
      for (let i = 0; i < p.length; i += maxLen) {
        chunks.push(p.slice(i, i + maxLen));
      }
      cur = "";
    } else {
      cur = p;
    }
  }
  if (cur) chunks.push(cur);

  return chunks;
}