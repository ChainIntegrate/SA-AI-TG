// src/services/search.js

const BRAVE_WEB_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

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
  "aziendeitalia.com",
]);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
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

  const items = await searchBrave({ cfg, query, count, country, searchLang });
  return { items }; // ✅ { items: [...] }
}

async function searchBrave({ cfg, query, count, country, searchLang }) {
  if (!cfg.BRAVE_API_KEY) throw new Error("Missing BRAVE_API_KEY");

  const safeCount = Math.max(1, Math.min(20, Number(count || 12)));

  const url = new URL(BRAVE_WEB_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(safeCount));
  url.searchParams.set("country", country);
  url.searchParams.set("search_lang", searchLang);

  console.log("[searchBrave DEBUG] URL:", url.toString());
  console.log("[searchBrave DEBUG] Token start:", cfg.BRAVE_API_KEY?.slice(0, 8), "...");

  const r = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": cfg.BRAVE_API_KEY,
    },
  });

  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    console.error("[searchBrave DEBUG] PARSE JSON ERROR:", e?.message);
    j = {};
  }

  if (!r.ok) {
    const msg = j?.message || j?.error?.message || `${r.status} ${r.statusText}`;
    console.error("[searchBrave DEBUG] HTTP ERROR:", msg);
    throw new Error(`Brave error: ${msg}`);
  }

  const raw = (j?.web?.results || []).map((x) => ({
    title: x?.title || "",
    url: x?.url || "",
    snippet: x?.description || "",
  }));

  console.log("[searchBrave DEBUG] RESULTS LENGTH:", raw.length);

  const items = raw.filter((rr) => rr.url && !isBlocked(rr.url));

  console.log("[searchBrave DEBUG] FILTERED RESULTS LENGTH:", items.length);

  return items; // ✅ array
}