// src/services/search.js
// Brave Web Search API: GET https://api.search.brave.com/res/v1/web/search?q=...
// Auth: X-Subscription-Token header
// Docs: api-dashboard.search.brave.com (Web Search) :contentReference[oaicite:2]{index=2}

const BRAVE_WEB_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Blocchiamo directory/social (aggiungine quando vuoi)
const BLOCK_HOSTS = new Set([
  "paginegialle.it",
  "paginebianche.it",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "wikipedia.org",
  "ufficiocamerale.it",
  "registroimprese.it",
  "aziendeitalia.com"
]);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}
function isBlocked(url) {
  const h = hostOf(url);
  if (!h) return true;
  if (BLOCK_HOSTS.has(h)) return true;
  for (const b of BLOCK_HOSTS) if (h.endsWith("." + b)) return true;
  return false;
}

export async function searchWeb({ cfg, query, count = 12, country = "IT", searchLang = "it" }) {
  const provider = String(cfg.SEARCH_PROVIDER || "none").toLowerCase();
  if (provider !== "brave") {
    throw new Error(`SEARCH_PROVIDER non supportato: ${provider}. Imposta SEARCH_PROVIDER=brave`);
  }
  return searchBrave({ cfg, query, count, country, searchLang });
}

async function searchBrave({ cfg, query, count, country, searchLang }) {
  if (!cfg.BRAVE_API_KEY) throw new Error("Missing BRAVE_API_KEY");

  // Brave: count max 20, offset max 9 (pagination) :contentReference[oaicite:3]{index=3}
  const safeCount = Math.max(1, Math.min(20, Number(count || 12)));

  const url = new URL(BRAVE_WEB_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(safeCount));
  url.searchParams.set("country", country);
  url.searchParams.set("search_lang", searchLang);

  const r = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": cfg.BRAVE_API_KEY
    }
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.message || j?.error?.message || `${r.status} ${r.statusText}`;
    throw new Error(`Brave error: ${msg}`);
  }

  // Response: web.results[] :contentReference[oaicite:4]{index=4}
  const raw = (j?.web?.results || []).map(x => ({
    title: x?.title || x?.profile?.name || "",
    url: x?.url || "",
    snippet: x?.description || ""
  })).filter(x => x.url && !isBlocked(x.url));

  // Dedup per host
  const seen = new Set();
  const out = [];
  for (const it of raw) {
    const h = hostOf(it.url);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(it);
  }
  return out;
}