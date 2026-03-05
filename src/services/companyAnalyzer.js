// src/services/companyAnalyzer.js
import { nowIso } from "../utils/time.js";
import { pickRoleTarget, buildLinkedInDraft } from "../prompts/sales.js";
import { getUserPrefs } from "../core/state.js";
import { searchWeb } from "./search.js";
import { llmJSON } from "./llm.js";
import { normalizeWhitespace, safeTruncate } from "../utils/text.js";

export async function addCompanyFromUrl({ cfg, db, chatId, url }) {
  const prefs = getUserPrefs({ db, chatId });
  const baseName = guessNameFromUrl(url);

  if (!isLLMEnabled(cfg)) {
    return addCompanyFallback({ cfg, db, chatId, url, prefs, baseName });
  }

  // 1) Search base
  let searchPack = await buildSearchPack({ cfg, url, baseName });

  // 2) Heuristic contact extraction (cheap, deterministic)
  const heuristicHint = extractContactHintHeuristic(searchPack);

  // 3) If we still have nothing, do a second targeted search (cheap, small)
  if (!heuristicHint || heuristicHint.channel === "NONE") {
    const extra = await buildContactSearchPack({ cfg, url, baseName });
    if (extra?.items?.length) {
      // merge (keep max 12 items total)
      searchPack = mergeSearchPacks(searchPack, extra, 12);
    }
  }

  // 4) LLM analysis (now it can also output contact_hint backed by evidence)
  const analysis = await analyzeWithLLM({
    cfg,
    prefs,
    baseName,
    url,
    searchPack,
    heuristicHint,
  });

  const createdAt = nowIso();

  // prefer LLM contact_hint if present + non-empty, else fallback heuristic
  const contactHint = normalizeContactHint(analysis?.contact_hint) || heuristicHint || null;

  const signalsObject = {
    version: 2,
    inputs: {
      url,
      baseName,
      userPrefs: {
        minDip: prefs.minDip || null,
        maxDip: prefs.maxDip || null,
        country: prefs.country || null,
      },
    },
    evidence: {
      query: searchPack.query,
      items: searchPack.items,
    },
    analysis,
    contact_hint: contactHint,
  };

  const companyId = db
    .prepare(
      `
INSERT INTO companies(
  chat_id, name, website, sector, country, size_est,
  signals_json, source_urls_json, contact_hint_json, created_at
)
VALUES(?,?,?,?,?,?,?,?,?,?)
`
    )
    .run(
      String(chatId),
      analysis.company_name || baseName,
      url,
      analysis.sector || "Da classificare",
      analysis.country || "Italia",
      analysis.size_est || estimateSizeFromPrefs(prefs),
      JSON.stringify(signalsObject),
      JSON.stringify(searchPack.sourceUrls),
      contactHint ? JSON.stringify(contactHint) : null,
      createdAt
    ).lastInsertRowid;

  const row = db.prepare(`SELECT * FROM companies WHERE id=?`).get(companyId);

  return {
    ...row,
    id: companyId,
    name: analysis.company_name || baseName,
    website: url,
    sector: analysis.sector || "Da classificare",
    country: analysis.country || "Italia",
    sizeEst: analysis.size_est || estimateSizeFromPrefs(prefs),

    signals: analysis.signals || [],
    analysis,

    roleTarget: analysis.role_target,
    roleWhy: analysis.role_why,
    messageDraft: analysis.linkedin_draft,

    entryAngle: analysis.entry_angle,
    painPoints: analysis.pain_points || [],
    whyNow: analysis.why_now,
    icebreaker: analysis.icebreaker_line,

    // NEW: contact hint
    contactHint,

    // NEW: raw evidence snippets (for rich Telegram output)
    evidenceItems: Array.isArray(searchPack?.items) ? searchPack.items : [],
    evidenceQuery: searchPack?.query || null,
    sourceUrls: Array.isArray(searchPack?.sourceUrls) ? searchPack.sourceUrls : [],
  };
}

export async function proposeNextCompany({ cfg, db, chatId }) {
  const row = db
    .prepare(
      `
SELECT * FROM companies
WHERE chat_id=?
ORDER BY id DESC
LIMIT 1
`
    )
    .get(String(chatId));

  if (!row) return null;

  const prefs = getUserPrefs({ db, chatId });

  const signalsParsed = safeJson(row.signals_json, null);
  const contactHint = safeJson(row.contact_hint_json, null) || (signalsParsed?.contact_hint ?? null);

  if (signalsParsed && typeof signalsParsed === "object" && signalsParsed.analysis) {
    const a = signalsParsed.analysis;

    const company = {
      id: row.id,
      name: row.name,
      website: row.website,
      sector: row.sector,
      country: row.country,
      sizeEst: row.size_est,
      signals: a.signals || [],
      analysis: a,
      roleTarget: a.role_target,
      roleWhy: a.role_why,
      messageDraft: a.linkedin_draft,
      entryAngle: a.entry_angle,
      painPoints: a.pain_points || [],
      whyNow: a.why_now,
      icebreaker: a.icebreaker_line,
      contactHint,
    };

    const deal = {
      roleTarget: a.role_target,
      roleWhy: a.role_why,
      messageDraft: a.linkedin_draft,
      entryAngle: a.entry_angle,
      painPoints: a.pain_points || [],
      whyNow: a.why_now,
      icebreaker: a.icebreaker_line,
      contactHint,
    };

    return { company, deal };
  }

  const signals = Array.isArray(signalsParsed) ? signalsParsed : [];
  const { roleTarget, roleWhy } = pickRoleTarget({
    sizeBand: row.size_est || estimateSizeFromPrefs(prefs),
    signals,
    sector: row.sector || "Da classificare",
  });

  const messageDraft = buildLinkedInDraft({
    companyName: row.name,
    roleTarget,
    sectorHint: row.sector || "Da classificare",
    signals,
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
    messageDraft,
    contactHint,
  };

  return { company, deal: { roleTarget, roleWhy, messageDraft, contactHint } };
}

/* ----------------------------- helpers ----------------------------- */

function isLLMEnabled(cfg) {
  const p = String(cfg?.LLM_PROVIDER || "none").toLowerCase();
  const k = String(cfg?.LLM_API_KEY || "").trim();
  return p === "openai" && !!k;
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
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

function estimateSizeFromPrefs(prefs) {
  const min = prefs?.minDip || 30;
  const max = prefs?.maxDip || 120;
  return `${min}-${max} dip (target)`;
}

async function buildSearchPack({ cfg, url, baseName }) {
  const host = hostOf(url);

  const q = [
    `"${baseName}"`,
    host ? `"${host}"` : "",
    "officina OR industria OR produzione",
    "ISO 9001",
    "azienda",
    "settore",
  ]
    .filter(Boolean)
    .join(" ");

  const res = await searchWeb({ cfg, query: q, count: 8, country: "IT", searchLang: "it" });
  return normalizeSearchResults({ url, res, query: q, maxItems: 8 });
}

async function buildContactSearchPack({ cfg, url, baseName }) {
  const host = hostOf(url);

  const q = [
    `"${baseName}"`,
    host ? `site:${host}` : "",
    "(contatti OR contatto OR email OR mailto OR commerciale OR vendite)",
    "linkedin",
  ]
    .filter(Boolean)
    .join(" ");

  const res = await searchWeb({ cfg, query: q, count: 6, country: "IT", searchLang: "it" });
  return normalizeSearchResults({ url, res, query: q, maxItems: 6 });
}

function normalizeSearchResults({ url, res, query, maxItems }) {
  const list = Array.isArray(res?.items) ? res.items : [];

  const items = list
    .slice(0, maxItems)
    .map((r) => ({
      title: safeTruncate(String(r.title || ""), 140),
      snippet: safeTruncate(normalizeWhitespace(String(r.snippet || "")), 260),
      url: String(r.url || ""),
    }))
    .filter((x) => x.url);

  const sourceUrls = dedupeUrls([url, ...items.map((i) => i.url)]).slice(0, 12);

  const evidenceText = items
    .map((it, idx) => `#${idx + 1}\nTITLE: ${it.title}\nURL: ${it.url}\nSNIPPET: ${it.snippet}`)
    .join("\n\n");

  return {
    query,
    items,
    sourceUrls,
    evidenceText: safeTruncate(evidenceText, 12000),
  };
}

function mergeSearchPacks(a, b, maxItems = 12) {
  const items = dedupeByUrl([...(a.items || []), ...(b.items || [])]).slice(0, maxItems);
  const sourceUrls = dedupeUrls([...(a.sourceUrls || []), ...(b.sourceUrls || [])]).slice(0, 12);

  const evidenceText = items
    .map((it, idx) => `#${idx + 1}\nTITLE: ${it.title}\nURL: ${it.url}\nSNIPPET: ${it.snippet}`)
    .join("\n\n");

  return {
    query: `${a.query} | ${b.query}`,
    items,
    sourceUrls,
    evidenceText: safeTruncate(evidenceText, 12000),
  };
}

function dedupeByUrl(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const u = String(it?.url || "").trim();
    if (!u) continue;
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function dedupeUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    const s = String(u || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Estrazione deterministica (prima dell'LLM) da snippet/URL:
 * - Email
 * - LinkedIn URL (company/person)
 */
function extractContactHintHeuristic(searchPack) {
  const items = Array.isArray(searchPack?.items) ? searchPack.items : [];
  if (!items.length) return { channel: "NONE", confidence: 0, evidence_ref: null };

  // 1) email
  for (let i = 0; i < items.length; i++) {
    const text = `${items[i].title}\n${items[i].snippet}\n${items[i].url}`;
    const email = findFirstEmail(text);
    if (email) {
      return {
        channel: "EMAIL",
        email,
        url: items[i].url || null,
        name: null,
        role: null,
        evidence_ref: `#${i + 1}`,
        confidence: 70,
      };
    }
  }

  // 2) linkedin url
  for (let i = 0; i < items.length; i++) {
    const text = `${items[i].title}\n${items[i].snippet}\n${items[i].url}`;
    const li = findFirstLinkedInUrl(text);
    if (li) {
      const isCompany = /linkedin\.com\/company\//i.test(li);
      return {
        channel: "LINKEDIN",
        url: li,
        email: null,
        name: null,
        role: isCompany ? "Company Page" : null,
        evidence_ref: `#${i + 1}`,
        confidence: isCompany ? 65 : 55,
      };
    }
  }

  return { channel: "NONE", confidence: 0, evidence_ref: null };
}

function findFirstEmail(text) {
  const t = String(text || "");
  const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function findFirstLinkedInUrl(text) {
  const t = String(text || "");
  const m =
    t.match(/https?:\/\/(www\.)?linkedin\.com\/[^\s)"']+/i) ||
    t.match(/(www\.)?linkedin\.com\/[^\s)"']+/i);
  if (!m) return null;
  let u = m[0];
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^www\./i, "www.")}`;
  return u;
}

function normalizeContactHint(h) {
  if (!h || typeof h !== "object") return null;

  const channel = String(h.channel || "NONE").toUpperCase();
  const out = {
    channel: ["EMAIL", "LINKEDIN", "NONE"].includes(channel) ? channel : "NONE",
    name: h.name ? String(h.name).trim() : null,
    role: h.role ? String(h.role).trim() : null,
    url: h.url ? String(h.url).trim() : null,
    email: h.email ? String(h.email).trim() : null,
    evidence_ref: h.evidence_ref ? String(h.evidence_ref).trim() : null,
    confidence: typeof h.confidence === "number" ? h.confidence : 0,
  };

  if (out.channel === "EMAIL" && !out.email) out.channel = "NONE";
  if (out.channel === "LINKEDIN" && !out.url) out.channel = "NONE";
  if (out.channel === "NONE") {
    out.name = null;
    out.role = null;
    out.url = null;
    out.email = null;
    out.evidence_ref = null;
    out.confidence = 0;
  }
  return out;
}

async function analyzeWithLLM({ cfg, prefs, baseName, url, searchPack, heuristicHint }) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      company_name: { type: "string" },
      country: { type: "string" },
      sector: { type: "string" },
      size_est: { type: "string" },

      signals: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 12 },
      pain_points: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 },

      entry_angle: { type: "string" },
      role_target: { type: "string" },
      role_why: { type: "string" },
      why_now: { type: "string" },
      icebreaker_line: { type: "string" },
      linkedin_draft: { type: "string" },

      contact_hint: {
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string", enum: ["EMAIL", "LINKEDIN", "NONE"] },
          name: { type: ["string", "null"] },
          role: { type: ["string", "null"] },
          url: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          evidence_ref: { type: ["string", "null"], pattern: "^#([1-9]|[1-9][0-9])$" },
          confidence: { type: "number" },
        },
        required: ["channel", "name", "role", "url", "email", "evidence_ref", "confidence"],
      },

      evidence_map: {
        type: "array",
        minItems: 2,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            claim: { type: "string", minLength: 6, maxLength: 220 },
            evidence_ref: { type: "string", pattern: "^#([1-9]|[1-9][0-9])$" },
          },
          required: ["claim", "evidence_ref"],
        },
      },

      confidence: {
        type: "object",
        additionalProperties: false,
        properties: {
          company_match: { type: "number" },
          sector: { type: "number" },
          size_est: { type: "number" },
        },
        required: ["company_match", "sector", "size_est"],
      },
    },
    required: [
      "company_name",
      "country",
      "sector",
      "size_est",
      "signals",
      "pain_points",
      "entry_angle",
      "role_target",
      "role_why",
      "why_now",
      "icebreaker_line",
      "linkedin_draft",
      "contact_hint",
      "evidence_map",
      "confidence",
    ],
  };

  const minDip = prefs?.minDip || 30;
  const maxDip = prefs?.maxDip || 120;

  const system = `
Sei un sales research analyst B2B per soluzioni di tracciabilità/qualità (ChainIntegrate).

Devi analizzare un'azienda partendo SOLO dalle evidenze fornite (snippet/URL).
Output: JSON conforme allo schema.

REGOLE FORTI:
1) Non inventare: qualsiasi fatto/claim specifico DEVE essere supportato da una evidence line (#1, #2, ...).
2) evidence_map: 2-8 claim con evidence_ref.
3) linkedin_draft:
   - 5-8 righe, italiano professionale, non spam.
   - NON usare placeholder.
   - Usa SOLO claim presenti in evidence_map.
   - Non citare "blockchain" nel primo messaggio.
4) contact_hint:
   - Se nelle evidenze compare una EMAIL o un link LinkedIn, valorizza contact_hint con evidence_ref.
   - Se NON compare, imposta channel="NONE" e tutti gli altri campi null (confidence=0).
   - Vietato inventare email, nomi o link.
5) confidence: 0-100. Se evidenze deboli, abbassa.

LINEE GUIDA:
- sector: breve (es. "Meccanica di precisione", "Automazione industriale", "Carpenteria metallica").
- size_est: range tipo "50-200 dip" o "200-500 dip", compatibile col target ${minDip}-${maxDip}.
- role_target: Quality Manager / Operations / Plant / Supply Chain / CTO.
- icebreaker_line: domanda breve legata ad un claim di evidence_map.
`.trim();

  const input = `
TARGET URL: ${url}
BASE NAME GUESS: ${baseName}
USER TARGET SIZE: ${minDip}-${maxDip} dip

HEURISTIC CONTACT (optional, may be NONE):
${JSON.stringify(heuristicHint || { channel: "NONE" })}

EVIDENCE (search snippets):
${searchPack.evidenceText}
`.trim();

  const out = await llmJSON({
    input,
    system,
    schema,
    model: cfg.LLM_MODEL || undefined,
    temperature: 0.1,
    maxOutputTokens: 950,
    metadata: { feature: "company_analysis", url },
  });

  const a = out.data || {};

  if (!Array.isArray(a.evidence_map) || a.evidence_map.length < 2) {
    a.evidence_map = Array.isArray(a.evidence_map) ? a.evidence_map : [];
    a.confidence = { company_match: 40, sector: 40, size_est: 30 };
  }

  a.contact_hint = normalizeContactHint(a.contact_hint) || { channel: "NONE", confidence: 0, evidence_ref: null };

  const badPlaceholders = /\[(nome|tuo nome|name)\]|\{(nome|name)\}|<nome>/i;
  if (badPlaceholders.test(a.linkedin_draft || "")) {
    a.linkedin_draft = safeTruncate(
      normalizeWhitespace(
        `
Buongiorno, sto contattando aziende in ambito qualità/tracciabilità.
Dal vostro sito emerge: ${a.evidence_map?.[0]?.claim || "attività in ambito manifatturiero"}.
Se ha senso, mi piacerebbe capire come gestite oggi tracciabilità e versioni documentali nei processi.
Possiamo sentirci 10-15 minuti questa settimana?
`.trim()
      ),
      1200
    );
  }

  a.linkedin_draft = safeTruncate(normalizeWhitespace(String(a.linkedin_draft || "")), 1200);
  a.entry_angle = safeTruncate(normalizeWhitespace(String(a.entry_angle || "")), 500);
  a.role_why = safeTruncate(normalizeWhitespace(String(a.role_why || "")), 500);
  a.why_now = safeTruncate(normalizeWhitespace(String(a.why_now || "")), 500);
  a.icebreaker_line = safeTruncate(normalizeWhitespace(String(a.icebreaker_line || "")), 240);

  a.signals = (Array.isArray(a.signals) ? a.signals : [])
    .map((x) => normalizeWhitespace(String(x || "")))
    .filter(Boolean)
    .slice(0, 12);

  a.pain_points = (Array.isArray(a.pain_points) ? a.pain_points : [])
    .map((x) => normalizeWhitespace(String(x || "")))
    .filter(Boolean)
    .slice(0, 8);

  a.evidence_map = (Array.isArray(a.evidence_map) ? a.evidence_map : [])
    .map((x) => ({
      claim: normalizeWhitespace(String(x?.claim || "")),
      evidence_ref: String(x?.evidence_ref || "").trim(),
    }))
    .filter((x) => x.claim && x.evidence_ref)
    .slice(0, 8);

  return a;
}

/* --------------------------- OUTBOUND DRAFT --------------------------- */

export async function draftOutboundWithLLM({ cfg, company, channel = "LinkedIn", enrich = null }) {
  if (!company?.analysis) throw new Error("Missing company.analysis for drafting");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      drafts: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ["1", "2", "3"] },
            angle: { type: "string" }, // audit / docs / verify
            tone: { type: "string" }, // diretto / bilanciato / formale
            subject: { type: ["string", "null"] }, // ✅ Email only, LinkedIn => null
            text: { type: "string" }, // 5-9 righe
          },
          required: ["id", "angle", "tone", "subject", "text"],
        },
      },
      suggested_channel: { type: "string", enum: ["LinkedIn", "Email"] },
      followup_question: { type: "string" },
    },
    required: ["drafts", "suggested_channel", "followup_question"],
  };

  const a = company.analysis;
  const ev = Array.isArray(a.evidence_map) ? a.evidence_map : [];

  const enr = normalizeEnrich(enrich);

  const constraints = parseConstraintFlags(enr.constraints);

  const cta = enr.cta || "call_15";
  const pain = enr.pain || "docs";
  const proof = enr.proof || "zero_change";
  const hook = enr.hook || "";

  const maxChars = constraints.max500 ? 500 : channel === "LinkedIn" ? 900 : 2000;

  const system = `
Sei una sales assistant B2B per ChainIntegrate (qualità/tracciabilità).

REGOLE DURE:
1) Non inventare nulla: usa SOLO i claim presenti in evidence_map.
2) Vietato "blockchain" nel primo messaggio.
3) Vietati placeholder (es: [Nome], <azienda>, ecc.).
4) 5-9 righe max, professionale, non spam.
5) Chiudi con CTA coerente con CTA_MODE.
6) Se CHANNEL=Email: ogni bozza DEVE avere subject (max 70 caratteri). Se CHANNEL=LinkedIn: subject=null.
7) QR: puoi citarlo SOLO se serve e senza insistere (max 1 volta).

VINCOLI ATTIVI:
- NO_BLOCKCHAIN: ${constraints.noBlockchain ? "SI" : "NO"}
- NO_NFT: ${constraints.noNFT ? "SI" : "NO"}
- NO_PRICING: ${constraints.noPricing ? "SI" : "NO"}
- MAX_500_CHARS: ${constraints.max500 ? "SI" : "NO"}
- SUPER_FORMAL: ${constraints.superFormal ? "SI" : "NO"}

CTA_MODE:
- call_15: proponi call 10-15 min
- find_decider: chiedi a chi conviene parlarne internamente
- get_info: fai una domanda operativa su come gestiscono oggi
- demo: proponi mini-demo / esempio pratico

PAIN_MODE:
- audit: audit/ISO, tempi, attriti
- docs: versioni documenti, duplicati, errori
- export_verify: clienti esteri, verifica rapida e fiducia
- trace_ncr: tracciabilità lotti, NCR, reclami

PROOF_MODE:
- case_real: riferimento a esperienza/caso reale (senza dettagli inventati)
- qr_demo: offri demo con QR verificabile (senza buzzword)
- zero_change: “si integra senza stravolgere l’ERP”
- iso_mindset: “approccio qualità/ISO, pragmatismo operativo”
`.trim();

  const input = `
CHANNEL: ${channel}
COMPANY: ${company.name}
WEBSITE: ${company.website}

CTA_MODE: ${cta}
PAIN_MODE: ${pain}
PROOF_MODE: ${proof}
HOOK (optional): ${hook ? hook : "(none)"}
MAX_CHARS: ${maxChars}

EVIDENCE_MAP (usa solo questi claim):
${ev.map((x, i) => `- (${x.evidence_ref || "#" + (i + 1)}) ${x.claim}`).join("\n")}
`.trim();

  const out = await llmJSON({
    input,
    system,
    schema,
    model: cfg.LLM_MODEL || undefined,
    temperature: 0.35,
    maxOutputTokens: 800,
    metadata: { feature: "outbound_draft", company: company.name, channel, cta, pain, proof },
  });

  const data = out.data || {};
  data.drafts = (Array.isArray(data.drafts) ? data.drafts : [])
    .slice(0, 3)
    .map((d, idx) => {
      let text = String(d?.text || "").trim();
      let subject = d?.subject === null ? null : String(d?.subject || "").trim();

      text = stripPlaceholders(text);

      // hard constraints scrubbing
      if (constraints.noBlockchain) text = scrubWord(text, "blockchain");
      if (constraints.noNFT) text = scrubWord(text, "nft");
      if (constraints.noPricing) text = scrubPricingHints(text);

      if (maxChars && text.length > maxChars) text = text.slice(0, maxChars - 1).trimEnd() + "…";

      if (constraints.superFormal) text = enforceFormalItalian(text);

      // subject rules
      if (channel === "LinkedIn") {
        subject = null;
      } else {
        // Email: subject required
        if (!subject) {
          subject = buildSubjectFallback(company, ev, pain);
        }
        subject = safeTruncate(normalizeWhitespace(subject), 70);
      }

      return {
        id: String(d?.id || String(idx + 1)),
        angle: String(d?.angle || "").trim().slice(0, 80),
        tone: String(d?.tone || "").trim().slice(0, 80),
        subject,
        text: text.slice(0, 1800),
      };
    });

  data.followup_question = normalizeFollowupQuestion(String(data.followup_question || ""), cta);
  if (constraints.max500) data.suggested_channel = "LinkedIn";

  return data;
}

/* ---------------------- enrich helpers (new) ---------------------- */

function normalizeEnrich(enrich) {
  if (!enrich || typeof enrich !== "object") return {};
  return {
    cta: enrich.cta ? String(enrich.cta).trim() : "",
    pain: enrich.pain ? String(enrich.pain).trim() : "",
    proof: enrich.proof ? String(enrich.proof).trim() : "",
    constraints: enrich.constraints ? String(enrich.constraints).trim() : "",
    hook: enrich.hook ? String(enrich.hook).trim() : "",
  };
}

function parseConstraintFlags(s) {
  const t = String(s || "").toUpperCase();
  return {
    noBlockchain: t.includes("A"),
    noNFT: t.includes("B"),
    noPricing: t.includes("C"),
    max500: t.includes("D"),
    superFormal: t.includes("E"),
  };
}

function stripPlaceholders(text) {
  return String(text || "")
    .replace(/\[(.*?)\]|\<(.*?)\>|\{(.*?)\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function scrubWord(text, word) {
  const re = new RegExp(`\\b${word}\\b`, "ig");
  return String(text || "").replace(re, "").replace(/\s{2,}/g, " ").trim();
}

function scrubPricingHints(text) {
  return String(text || "")
    .replace(/\b(prezzo|costo|tariffa|preventivo|offerta economica|quotazione)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function enforceFormalItalian(text) {
  let t = String(text || "");
  t = t.replace(/\bCiao\b/gi, "Buongiorno");
  t = t.replace(/\bti\b/gi, "Le");
  t = t.replace(/\btuo\b/gi, "Suo");
  t = t.replace(/\bti va\b/gi, "Le sarebbe comodo");
  return t;
}

function normalizeFollowupQuestion(q, cta) {
  const qq = String(q || "").trim();
  if (qq.length >= 8) return qq;

  if (cta === "find_decider") return "A chi conviene parlarne internamente (Qualità / Operations / Supply Chain)?";
  if (cta === "get_info") return "Oggi come gestite versioni documentali e tracciabilità tra fornitori/produzione?";
  if (cta === "demo") return "Preferisce una mini-demo (5 minuti) o un esempio concreto via messaggio?";
  return "Va bene una call di 10-15 minuti questa settimana?";
}

function buildSubjectFallback(company, ev, pain) {
  const base = company?.name ? `Info ${company.name}` : "Info";
  const hint =
    pain === "audit"
      ? "ridurre attriti audit"
      : pain === "docs"
      ? "versioni documenti qualità"
      : pain === "export_verify"
      ? "verifica rapida per clienti"
      : pain === "trace_ncr"
      ? "tracciabilità lotti / NCR"
      : "qualità e tracciabilità";

  // usa un claim se disponibile, senza inventare
  const claim = Array.isArray(ev) && ev[0]?.claim ? safeTruncate(normalizeWhitespace(String(ev[0].claim)), 42) : "";
  const tail = claim ? ` — ${claim}` : "";

  return safeTruncate(`${base}: ${hint}${tail}`, 70);
}

function addCompanyFallback({ cfg, db, chatId, url, prefs, baseName }) {
  const name = baseName;
  const signals = ["Italia", "Manifatturiero (stimato)"];
  const sizeEst = estimateSizeFromPrefs(prefs);
  const sector = "Da classificare";

  const { roleTarget, roleWhy } = pickRoleTarget({
    sizeBand: sizeEst,
    signals,
    sector,
  });

  const messageDraft = buildLinkedInDraft({
    companyName: name,
    roleTarget,
    sectorHint: sector,
    signals,
  });

  const companyId = db
    .prepare(
      `
INSERT INTO companies(chat_id, name, website, sector, country, size_est, signals_json, source_urls_json, contact_hint_json, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?)
`
    )
    .run(String(chatId), name, url, sector, "Italia", sizeEst, JSON.stringify(signals), JSON.stringify([url]), null, nowIso())
    .lastInsertRowid;

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
    messageDraft,
    contactHint: null,
  };
}