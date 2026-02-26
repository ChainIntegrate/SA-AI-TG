import { nowIso } from "../utils/time.js";
import { pickRoleTarget, buildLinkedInDraft } from "../prompts/sales.js";
import { getUserPrefs } from "../core/state.js";

export async function addCompanyFromUrl({ cfg, db, chatId, url }) {
  // Placeholder: non faccio scraping qui. Per ora memorizzo URL + nome provvisorio.
  // Poi quando scegli provider di search/scrape, mettiamo estrazione title, segnali, ecc.
  const prefs = getUserPrefs({ db, chatId });

  const name = guessNameFromUrl(url);
  const signals = ["Italia", "Manifatturiero (stimato)"];
  const sizeEst = `${prefs.minDip || 30}-${prefs.maxDip || 120} dip (target)`;
  const sector = "Da classificare";

  // pick role + why (dinamico)
  const { roleTarget, roleWhy } = pickRoleTarget({
    sizeBand: sizeEst,
    signals,
    sector
  });

  const messageDraft = buildLinkedInDraft({
    companyName: name,
    roleTarget,
    sectorHint: sector,
    signals
  });

  const companyId = db.prepare(`
INSERT INTO companies(chat_id, name, website, sector, country, size_est, signals_json, source_urls_json, created_at)
VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    String(chatId),
    name,
    url,
    sector,
    "Italia",
    sizeEst,
    JSON.stringify(signals),
    JSON.stringify([url]),
    nowIso()
  ).lastInsertRowid;

  const company = db.prepare(`SELECT * FROM companies WHERE id=?`).get(companyId);

  return {
    ...company,
    id: companyId,
    name,
    website: url,
    sector,
    country: "Italia",
    sizeEst,
    signals,
    roleTarget,
    roleWhy,
    messageDraft
  };
}

export async function proposeNextCompany({ cfg, db, chatId }) {
  const row = db.prepare(`
SELECT * FROM companies
WHERE chat_id=?
ORDER BY id DESC
LIMIT 1
  `).get(String(chatId));

  if (!row) return null;

  // ricrea proposta su base record
  const signals = safeJson(row.signals_json, []);
  const { roleTarget, roleWhy } = pickRoleTarget({
    sizeBand: row.size_est,
    signals,
    sector: row.sector
  });

  const messageDraft = buildLinkedInDraft({
    companyName: row.name,
    roleTarget,
    sectorHint: row.sector,
    signals
  });

  const company = {
    id: row.id,
    name: row.name,
    website: row.website,
    sector: row.sector,
    country: row.country,
    sizeEst: row.size_est,
    signals,
    roleTarget,
    roleWhy,
    messageDraft
  };

  const deal = {
    roleTarget,
    roleWhy,
    messageDraft
  };

  return { company, deal };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const base = host.split(".")[0];
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return "Azienda";
  }
}
