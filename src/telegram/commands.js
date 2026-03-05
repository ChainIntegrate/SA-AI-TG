// src/telegram/commands.js
import { tgSend, tgAction, tgSendOne, tgEdit, tgDelete } from "./templates.js";
import { upsertUserPrefs, getUserPrefs } from "../core/state.js";
import { addCompanyFromUrl, proposeNextCompany, draftOutboundWithLLM } from "../services/companyAnalyzer.js";
import {
  createDealForCompany,
  setDealStage,
  addNote,
  listPipeline,
  recordOutboundMessage,
  purgeAllForChat,
  purgeForChat,
  deleteCompanyCascade,
  pruneDealsKeepLastN,
} from "../core/pipeline.js";
import { searchWeb } from "../services/search.js";

export function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return { cmd: "free", args: t };
  const [head, ...rest] = t.split(" ");
  return { cmd: head.toLowerCase(), args: rest.join(" ").trim() };
}

// typing indicator
// typing indicator (robusto)
async function withTyping(cfg, chatId, fn, {
  action = "typing",
  progressText = "⏳ Sto elaborando…",
  showProgressMessage = true,
} = {}) {
  let timer = null;
  let stopped = false;

  // (1) messaggio “progress” visibile al 100%
  let progressMsg = null;
  if (showProgressMessage) {
    try {
      progressMsg = await tgSendOne(cfg, chatId, progressText);
    } catch (e) {
      console.error("[tgSendOne progress]", e?.message || e);
    }
  }

  // (2) typing best-effort
  const tick = async () => {
    if (stopped) return;
    try { await tgAction(cfg, chatId, action); } catch (e) {
      // IMPORTANT: loggalo, sennò non capisci mai se Telegram sta rifiutando
      console.error("[tgAction]", e?.message || e);
    }
  };

  await tick();
  timer = setInterval(() => { tick(); }, 4000);

  try {
    const res = await fn();

    // chiudi progress (edit in “✅ Fatto” oppure lo cancelli)
    if (progressMsg?.message_id) {
      try {
        await tgEdit(cfg, chatId, progressMsg.message_id, "✅ Pronto.");
        // opzionale: cancellalo dopo un attimo
        setTimeout(() => {
          tgDelete(cfg, chatId, progressMsg.message_id).catch(() => {});
        }, 1200);
      } catch (e) {
        console.error("[tgEdit/tgDelete]", e?.message || e);
      }
    }

    return res;
  } finally {
    stopped = true;
    if (timer) clearInterval(timer);
  }
}

function normalizeCandidates(resultsObj, limit = 8) {
  const list = Array.isArray(resultsObj?.items) ? resultsObj.items : [];
  return list
    .map((r) => ({
      url: String(r?.url || "").trim(),
      title: String(r?.title || "").trim(),
      snippet: String(r?.snippet || "").trim(),
    }))
    .filter((x) => x.url)
    .slice(0, limit);
}

function renderCandidate(cand, idx, total) {
  const lines = [
    `Trovato ${idx}/${total}:`,
    cand.title ? `Titolo: ${cand.title}` : null,
    `Link: ${cand.url}`,
    cand.snippet ? `Snippet: ${cand.snippet}` : null,
    "",
    `Vuoi analizzare questa azienda con AI? (SI/NO)`,
    `Extra: scrivi APRI per rimandare il link`,
  ].filter(Boolean);

  return lines.join("\n");
}

function setFlow(db, chatId, flowState, flowContext = {}) {
  upsertUserPrefs({ db, chatId, patch: { flowState, flowContext } });
}

function getFlow(db, chatId) {
  const p = getUserPrefs({ db, chatId });
  return {
    uiMode: p.uiMode || "dialog",
    flowState: p.flowState || "IDLE",
    flowContext: p.flowContext || {},
    prefs: p,
  };
}

function renderDraftChoices(draftPack) {
  const drafts = Array.isArray(draftPack?.drafts) ? draftPack.drafts : [];
  const lines = [];

  lines.push("Bozze AI pronte ✅");
  lines.push("Scegli: 1 / 2 / 3");
  lines.push("Oppure: RIGENERA  |  NO (salta)\n");

  for (const d of drafts) {
    lines.push(`(${d.id}) [${d.tone} | ${d.angle}]`);

    // ✅ Email subject visible when present
    if (d.subject && String(d.subject).trim()) {
      lines.push(`OGGETTO: ${String(d.subject).trim()}`);
    }

    lines.push(d.text);
    lines.push("");
  }

  if (draftPack?.followup_question) {
    lines.push(`Domanda rapida: ${draftPack.followup_question}`);
  }

  return lines.join("\n").trim();
}

function briefCompanyText(company, deal, remaining) {
  const a = company?.analysis || {};

  const signals = Array.isArray(company?.signals) ? company.signals : [];
  const pains = Array.isArray(company?.painPoints) ? company.painPoints : [];

  const ev = Array.isArray(a?.evidence_map) ? a.evidence_map : [];
  const evTop = ev.slice(0, 8);

  const conf = a?.confidence || {};
  const ch = company?.contactHint || null;

  const role = deal?.roleTarget || company?.roleTarget || "-";
  const roleWhy = deal?.roleWhy || company?.roleWhy || "-";
  const angle = company?.entryAngle || deal?.entryAngle || "-";

  const lines = [];

  lines.push(`Azienda: ${company?.name || "-"}`);
  lines.push(`Link: ${company?.website || "-"}`);
  lines.push(
    `Settore: ${company?.sector || "-"} | Paese: ${company?.country || "-"} | Size: ${
      company?.sizeEst || "-"
    }`
  );

  const cm = typeof conf.company_match === "number" ? conf.company_match : "-";
  const cs = typeof conf.sector === "number" ? conf.sector : "-";
  const cz = typeof conf.size_est === "number" ? conf.size_est : "-";
  lines.push(`Confidence: match ${cm} | settore ${cs} | size ${cz}`);

  if (ch && ch.channel && ch.channel !== "NONE") {
    if (ch.channel === "EMAIL") {
      lines.push(
        `Contatto (hint): EMAIL ${ch.email || "-"} (ref ${ch.evidence_ref || "-"}) conf=${
          ch.confidence ?? "-"
        }`
      );
    } else if (ch.channel === "LINKEDIN") {
      lines.push(
        `Contatto (hint): LINKEDIN ${ch.url || "-"} (ref ${ch.evidence_ref || "-"}) conf=${
          ch.confidence ?? "-"
        }`
      );
    }
  } else {
    lines.push(`Contatto (hint): non trovato`);
  }

  lines.push("");

  lines.push(`Ruolo target: ${role}`);
  lines.push(`Perché: ${roleWhy}`);
  lines.push(`Angolo: ${angle}`);
  if (company?.whyNow) lines.push(`Why now: ${company.whyNow}`);
  if (company?.icebreaker) lines.push(`Icebreaker: ${company.icebreaker}`);

  if (signals.length) {
    lines.push("");
    lines.push(`Segnali (top ${Math.min(signals.length, 10)}):`);
    signals.slice(0, 10).forEach((s) => lines.push(`- ${s}`));
  }

  if (pains.length) {
    lines.push("");
    lines.push(`Pain points (top ${Math.min(pains.length, 8)}):`);
    pains.slice(0, 8).forEach((p) => lines.push(`- ${p}`));
  }

  if (evTop.length) {
    lines.push("");
    lines.push(`Fatti da snippet (${evTop.length}):`);
    evTop.forEach((x) => lines.push(`- ${x.claim} (${x.evidence_ref})`));
  }

  lines.push("");
  lines.push(`La teniamo? (Sì/No)`);
  lines.push(`Extra: scrivi APRI per rimandare il link`);
  if (typeof remaining === "number") lines.push(`In coda: ${remaining}`);

  return lines.join("\n");
}

function angleMenu() {
  return [
    "Ok. Da che angolo entriamo?",
    "1) Riduzione tempo audit",
    "2) Errori/versioni documenti",
    "3) QR verificabile per clienti esteri",
    "Rispondi 1/2/3",
  ].join("\n");
}

function toneMenu() {
  return [
    "Tono del messaggio?",
    "1) Diretto",
    "2) Bilanciato",
    "3) Più formale",
    "Rispondi 1/2/3",
  ].join("\n");
}

function qrQuestion() {
  return "Nel testo citiamo esplicitamente “QR operativo”? (QR/Senza)";
}

function outboundChannelMenu() {
  return [
    "Perfetto. Prima cosa: su che canale lo invii?",
    "1) LinkedIn",
    "2) Email",
    "Rispondi 1/2",
  ].join("\n");
}

function contactPrompt(channel) {
  if (channel === "LinkedIn") {
    return "Ok. Incolla l’URL del profilo LinkedIn del contatto (oppure nome+cognome se non lo hai).";
  }
  return "Ok. Scrivi l’email del contatto.";
}

function looksLikeEmail(s) {
  const t = String(s || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function looksLikeLinkedInUrl(s) {
  const t = String(s || "").trim().toLowerCase();
  return t.includes("linkedin.com/");
}

/**
 * Mini-questionario per arricchire le bozze.
 * Salviamo in flowContext.enrich:
 * - cta: call_15 | find_decider | get_info | demo
 * - pain: audit | docs | export_verify | trace_ncr
 * - proof: case_real | qr_demo | zero_change | iso_mindset
 * - constraints: stringa tipo "ACD" oppure ""
 * - hook: testo libero (opzionale)
 */
function enrichQuestions() {
  return [
    {
      key: "cta",
      text: [
        "Obiettivo del primo contatto?",
        "1) Call 10-15 min",
        "2) Capire chi decide (ruolo/nome) + chiedere intro",
        "3) Ottenere info su come gestiscono oggi (domanda operativa)",
        "4) Proporre mini-demo / esempio",
        "Rispondi 1/2/3/4",
      ].join("\n"),
      validate: (t) => /^[1-4]$/.test(t),
      map: (t) => ({ "1": "call_15", "2": "find_decider", "3": "get_info", "4": "demo" }[t]),
    },
    {
      key: "pain",
      text: [
        "Angolo/pain principale?",
        "1) Audit/ISO: tempi e attriti",
        "2) Documenti: versioni/duplicati/errori",
        "3) Clienti esteri: verifica rapida & fiducia",
        "4) Lotti/NCR/reclami: tracciabilità operativa",
        "Rispondi 1/2/3/4",
      ].join("\n"),
      validate: (t) => /^[1-4]$/.test(t),
      map: (t) => ({ "1": "audit", "2": "docs", "3": "export_verify", "4": "trace_ncr" }[t]),
    },
    {
      key: "proof",
      text: [
        "Che prova/credibilità usiamo (1 scelta)?",
        "1) Caso reale (esperienza su lotti/produzione)",
        "2) Demo con QR verificabile (senza buzzword)",
        "3) Approccio 'zero-change' (non stravolgi ERP)",
        "4) Approccio qualità/ISO (pragmatico)",
        "Rispondi 1/2/3/4",
      ].join("\n"),
      validate: (t) => /^[1-4]$/.test(t),
      map: (t) => ({ "1": "case_real", "2": "qr_demo", "3": "zero_change", "4": "iso_mindset" }[t]),
    },
    {
      key: "constraints",
      text: [
        "Vincoli: cosa EVITARE? (scrivi lettere, es: ACD — oppure 0 per nessuno)",
        "A) Non dire 'blockchain'",
        "B) Non dire 'NFT'",
        "C) Non parlare di prezzi",
        "D) Max 500 caratteri (LinkedIn)",
        "E) Super formale",
        "Rispondi: 0 oppure combinazione (es: ACD)",
      ].join("\n"),
      validate: (t) => /^0$|^[A-E]{1,5}$/i.test(t),
      map: (t) => (t === "0" ? "" : t.toUpperCase()),
    },
    {
      key: "hook",
      text: "Extra (opzionale): incolla un aggancio/contesto (oppure scrivi SKIP).",
      validate: (_) => true,
      map: (t) => (/^skip$/i.test(t) ? "" : String(t || "").trim()),
    },
  ];
}

function buildDraftFromChoices({ baseDraft, angleChoice, toneChoice, qrChoice }) {
  let intro = baseDraft;

  if (angleChoice === "1") {
    intro = intro.replace(
      "riducendo il tempo speso in audit e verifiche documentali",
      "riducendo tempi e attriti in audit e verifiche documentali"
    );
  } else if (angleChoice === "2") {
    intro = intro.replace(
      "riducendo il tempo speso in audit e verifiche documentali",
      "riducendo errori, duplicazioni e versioni incoerenti nei documenti di qualità"
    );
  } else if (angleChoice === "3") {
    intro = intro.replace(
      "riducendo il tempo speso in audit e verifiche documentali",
      "semplificando la verifica per clienti esteri con un accesso rapido e verificabile"
    );
  }

  if (qrChoice === "QR") {
    if (!/QR/i.test(intro)) {
      intro = intro.replace("verificabili tramite QR operativo", "verificabili tramite QR operativo");
    }
  } else if (qrChoice === "Senza") {
    intro = intro.replace(/tramite QR operativo,?\s*/i, "in modo verificabile, ");
  }

  if (toneChoice === "1") {
    intro = intro.replace("Mi chiedevo se possa avere senso un confronto di 15 minuti", "Se ha senso, ci sentiamo 15 minuti");
  } else if (toneChoice === "3") {
    intro = intro.replace("Mi chiedevo se possa avere senso", "Le chiedo se possa avere senso");
  }

  return intro;
}

export async function handleCommand({ cfg, db, chatId, user, parsed }) {
  const prefs = getUserPrefs({ db, chatId });

  switch (parsed.cmd) {
    case "/db": {
      const arg = String(parsed.args || "").trim();

      if (!arg || /^help$/i.test(arg)) {
        return tgSend(
          cfg,
          chatId,
          [
            "🧹 Comandi DB:",
            "/db purge_all               (RESET TOTALE per questo chatId)",
            "/db purge messages|notes|deals|companies",
            "/db del <nome_azienda>      (cancella azienda + storico)",
            "/db prune <N>               (tieni ultimi N deals, cancella il resto)",
            "",
            "⚠️ Attenzione: purge_all è irreversibile.",
          ].join("\n")
        );
      }

      if (/^purge_all$/i.test(arg)) {
        purgeAllForChat({ db, chatId });
        upsertUserPrefs({ db, chatId, patch: { flowState: "IDLE", flowContext: {}, lastDraftMessage: null } });
        return tgSend(cfg, chatId, "Fatto ✅ DB pulito (tutto) per questo chatId.");
      }

      if (/^purge\s+/i.test(arg)) {
        const what = arg.replace(/^purge\s+/i, "").trim().toLowerCase();

        const flags = {
          messages: what === "messages",
          notes: what === "notes",
          deals: what === "deals",
          companies: what === "companies",
        };

        if (!flags.messages && !flags.notes && !flags.deals && !flags.companies) {
          return tgSend(cfg, chatId, "Uso: /db purge messages|notes|deals|companies");
        }

        if (flags.companies) {
          purgeAllForChat({ db, chatId });
          upsertUserPrefs({ db, chatId, patch: { flowState: "IDLE", flowContext: {}, lastDraftMessage: null } });
          return tgSend(cfg, chatId, "Fatto ✅ cancellate companies (e cascata completa) per questo chatId.");
        }

        purgeForChat({ db, chatId, flags });
        return tgSend(cfg, chatId, `Fatto ✅ purge ${what}.`);
      }

      if (/^del\s+/i.test(arg)) {
        const name = arg.replace(/^del\s+/i, "").trim();
        const res = deleteCompanyCascade({ db, chatId, companyName: name });
        if (!res.ok) {
          if (res.reason === "not_found") return tgSend(cfg, chatId, `Non trovo "${name}" nel DB.`);
          return tgSend(cfg, chatId, "Nome azienda mancante. Uso: /db del <nome_azienda>");
        }
        return tgSend(cfg, chatId, `Fatto ✅ eliminata: ${res.deletedCompanyName} (id ${res.deletedCompanyId}).`);
      }

      if (/^prune\s+/i.test(arg)) {
        const n = Number(arg.replace(/^prune\s+/i, "").trim());
        if (!Number.isFinite(n) || n < 0) return tgSend(cfg, chatId, "Uso: /db prune <N>  (es: /db prune 50)");
        pruneDealsKeepLastN({ db, chatId, keep: n });
        return tgSend(cfg, chatId, `Fatto ✅ tenuti ultimi ${n} deals (cancellato il resto).`);
      }

      return tgSend(cfg, chatId, "Comando non riconosciuto. Scrivi /db help.");
    }

    case "/modo": {
      const arg = (parsed.args || "").trim().toLowerCase();
      if (arg !== "dialogo" && arg !== "console") {
        return tgSend(cfg, chatId, "Uso: /modo dialogo  oppure  /modo console");
      }
      upsertUserPrefs({
        db,
        chatId,
        patch: {
          uiMode: arg === "dialogo" ? "dialog" : "console",
          flowState: "IDLE",
          flowContext: {},
        },
      });
      return tgSend(cfg, chatId, `Ok. Modalità: ${arg}`);
    }

    case "/stop": {
      upsertUserPrefs({ db, chatId, patch: { flowState: "IDLE", flowContext: {} } });
      return tgSend(cfg, chatId, "Ok, stop. Quando vuoi ripartire: scrivi 'cerca' o usa /cerca <query>.");
    }

    case "/start":
      return tgSend(
        cfg,
        chatId,
        `Ciao! Sono CI Sales Agent.
Comandi:
- /cerca <query>
- /analizza <url>
- /prossima
- /ok
- /stato <azienda> <fase>
- /nota <azienda> <testo>
- /pipeline
- /filtri set key=value
- /db help   (gestione e pulizia database)`
      );

    case "/webhook": {
      const { tgSetWebhook, tgGetWebhookInfo } = await import("./templates.js");

      if (parsed.args?.toLowerCase() === "info") {
        const info = await tgGetWebhookInfo(cfg);
        return tgSend(cfg, chatId, `Webhook info:\n${JSON.stringify(info, null, 2)}`);
      }

      const resp = await tgSetWebhook(cfg);
      return tgSend(cfg, chatId, `Webhook impostato ✅\n${JSON.stringify(resp, null, 2)}`);
    }

    case "/filtri": {
      if (!parsed.args.startsWith("set ")) {
        return tgSend(cfg, chatId, `Filtri attuali:\n${JSON.stringify(prefs, null, 2)}`);
      }
      const kvs = parsed.args.replace(/^set\s+/i, "").split(" ").filter(Boolean);
      const patch = {};
      for (const kv of kvs) {
        const [k, ...vv] = kv.split("=");
        patch[k] = vv.join("=");
      }
      upsertUserPrefs({ db, chatId, patch });
      const p2 = getUserPrefs({ db, chatId });
      return tgSend(cfg, chatId, `Ok, filtri aggiornati:\n${JSON.stringify(p2, null, 2)}`);
    }

    case "/analizza": {
      const url = parsed.args;
      if (!url) return tgSend(cfg, chatId, "Mi serve un URL. Esempio: /analizza https://www.azienda.it");
      const company = await addCompanyFromUrl({ cfg, db, chatId, url });
      const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });
      return tgSend(cfg, chatId, renderCompanyProposal(company, deal));
    }

    case "/cerca": {
      const { uiMode } = getFlow(db, chatId);
      const query = (parsed.args || "").trim();

      if (uiMode === "console") {
        if (!query) return tgSend(cfg, chatId, "Uso: /cerca <query>");

        const q = `${query} sito azienda`;
        let resultsObj;
        try {
          resultsObj = await searchWeb({ cfg, query: q, count: 12, country: "IT", searchLang: "it" });
        } catch (err) {
          return tgSend(cfg, chatId, `Errore Brave Search: ${err.message}`);
        }

        const candidates = normalizeCandidates(resultsObj, 8);
        if (!candidates.length) return tgSend(cfg, chatId, "Nessun risultato trovato per la query.");

        const [first, ...rest] = candidates;

        upsertUserPrefs({
          db,
          chatId,
          patch: {
            lastSearchQueue: rest.map((c) => c.url),
            lastSearchQuery: query,
          },
        });

        setFlow(db, chatId, "PRESENT_LINK", {
          queue: rest,
          candidate: first,
          searchQuery: query,
          searchTotal: candidates.length,
          searchIndex: 1,
        });

        return tgSend(cfg, chatId, renderCandidate(first, 1, candidates.length));
      }

      if (!query) {
        setFlow(db, chatId, "ASK_QUERY", {});
        return tgSend(cfg, chatId, "Ok. Dimmi la ricerca (es: 'meccanica ISO 9001 Lombardia export').");
      }

      const q = `${query} sito azienda`;
      let resultsObj;
      try {
        resultsObj = await searchWeb({ cfg, query: q, count: 12, country: "IT", searchLang: "it" });
      } catch (err) {
        setFlow(db, chatId, "IDLE", {});
        return tgSend(cfg, chatId, `Errore Brave Search: ${err.message}`);
      }

      const candidates = normalizeCandidates(resultsObj, 8);
      if (!candidates.length) {
        setFlow(db, chatId, "IDLE", {});
        return tgSend(cfg, chatId, "Nessun risultato trovato. Prova una query più specifica.");
      }

      const [first, ...rest] = candidates;

      setFlow(db, chatId, "PRESENT_LINK", {
        queue: rest,
        candidate: first,
        searchQuery: query,
        searchTotal: candidates.length,
        searchIndex: 1,
      });

      return tgSend(cfg, chatId, renderCandidate(first, 1, candidates.length));
    }

    case "/prossima": {
      const { uiMode, flowContext } = getFlow(db, chatId);

      if (uiMode === "dialog") {
        const queue = Array.isArray(flowContext.queue) ? flowContext.queue : [];
        if (!queue.length) return tgSend(cfg, chatId, "Coda vuota. Scrivi 'cerca' o usa /cerca <query>.");

        const next = queue[0];
        const rest = queue.slice(1);

        if (next && typeof next === "object" && next.url) {
          const idx = Number(flowContext.searchIndex || 1) + 1;
          const total = Number(flowContext.searchTotal || rest.length + 1);

          setFlow(db, chatId, "PRESENT_LINK", {
            ...flowContext,
            queue: rest,
            candidate: next,
            searchIndex: idx,
            searchTotal: total,
          });

          return tgSend(cfg, chatId, renderCandidate(next, idx, total));
        }

        const nextUrl = String(next || "");
        const company = await addCompanyFromUrl({ cfg, db, chatId, url: nextUrl });
        const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

        setFlow(db, chatId, "PRESENT_TARGET", {
          ...flowContext,
          queue: rest,
          companyName: company.name,
          companyUrl: company.website,
          baseDraft: deal.messageDraft,
          analysis: company.analysis,
        });

        return tgSend(cfg, chatId, briefCompanyText(company, deal, rest.length));
      }

      const next = await proposeNextCompany({ cfg, db, chatId });
      if (!next) return tgSend(cfg, chatId, "Non ho altre aziende in coda. Usa /cerca <query> oppure /analizza <url>.");
      return tgSend(cfg, chatId, renderCompanyProposal(next.company, next.deal));
    }

    case "/ok": {
      const lastDraft = prefs?.lastDraftMessage;
      if (!lastDraft?.companyName || !lastDraft?.text) {
        return tgSend(cfg, chatId, "Non ho un messaggio draft da finalizzare. Prima /analizza (o /cerca) e completa il flow.");
      }
      if (!lastDraft?.channel || !lastDraft?.contact) {
        return tgSend(cfg, chatId, "Mi manca il contatto/canale. Completa il flow (canale + contatto) e poi OK.");
      }

      // ✅ se Email, includi OGGETTO nel testo persistito (così non dipendi dal DB)
      const savedText =
        lastDraft.channel === "Email" && lastDraft.subject
          ? `OGGETTO: ${lastDraft.subject}\n\n${lastDraft.text}`
          : lastDraft.text;

      recordOutboundMessage({
        db,
        chatId,
        companyName: lastDraft.companyName,
        text: savedText,
        channel: lastDraft.channel,
        contact: lastDraft.contact,
        // opzionale: se pipeline.js non lo supporta, non cambia nulla.
        subject: lastDraft.subject || null,
      });

      setDealStage({ db, chatId, companyName: lastDraft.companyName, stage: "Contattato" });

      return tgSend(
        cfg,
        chatId,
        `Fatto ✅ Messaggio salvato come OUTBOUND e stato=Contattato.
Canale: ${lastDraft.channel}
Contatto: ${lastDraft.contact}${
          lastDraft.channel === "Email" && lastDraft.subject ? `\nOggetto: ${lastDraft.subject}` : ""
        }`
      );
    }

    case "/stato": {
      const [companyName, stageRaw] = split2(parsed.args);
      if (!companyName || !stageRaw) return tgSend(cfg, chatId, "Uso: /stato <azienda> <fase>");
      setDealStage({ db, chatId, companyName, stage: stageRaw });
      return tgSend(cfg, chatId, `Ok. ${companyName} → ${stageRaw}`);
    }

    case "/nota": {
      const [companyName, noteText] = split2(parsed.args);
      if (!companyName || !noteText) return tgSend(cfg, chatId, "Uso: /nota <azienda> <testo>");
      addNote({ db, chatId, companyName, text: noteText });
      return tgSend(cfg, chatId, `Nota salvata per ${companyName}.`);
    }

    case "/pipeline": {
      const arg = String(parsed.args || "").trim();

      if (arg) {
        const rows = listPipeline({ db, chatId });
        if (!rows.length) return tgSend(cfg, chatId, "Pipeline vuota.");

        const n = Number(arg);
        let picked = null;

        if (Number.isFinite(n) && n >= 1 && n <= rows.length) {
          picked = rows[n - 1];
        } else {
          const q = arg.toLowerCase();
          picked = rows.find((r) => String(r.companyName || "").toLowerCase().includes(q));
        }

        if (!picked) {
          return tgSend(cfg, chatId, `Non trovo "${arg}". Usa /pipeline per vedere la lista e scegliere il numero.`);
        }

        const stage = picked.stage || "-";
        const role = picked.roleTarget || "-";
        const why = picked.roleWhy || "-";
        const ch = picked.channel || picked.lastOutboundChannel || "-";
        const contact = picked.lastOutboundContact || "-";
        const next = picked.nextFollowupAt || "-";
        const lastAt = picked.lastOutboundAt || "-";
        const msg = picked.lastOutboundText ? String(picked.lastOutboundText).trim() : "(nessun messaggio OUTBOUND salvato)";

        const detail = [
          `📌 *${picked.companyName}*`,
          `Stato: ${stage}`,
          `Canale: ${ch}`,
          `Contatto: ${contact}`,
          `Next followup: ${next}`,
          "",
          `Target: ${role}`,
          `Perché: ${why}`,
          "",
          `Ultimo OUT (${lastAt}):`,
          msg.length > 3500 ? msg.slice(0, 3500) + "…" : msg,
        ].join("\n");

        return tgSend(cfg, chatId, detail);
      }

      const rows = listPipeline({ db, chatId });
      if (!rows.length) return tgSend(cfg, chatId, "Pipeline vuota.");

      setFlow(db, chatId, "PIPELINE_LIST", {
        pipelineList: rows.map((r) => ({
          companyName: r.companyName,
          stage: r.stage,
          channel: r.channel,
          nextFollowupAt: r.nextFollowupAt,
          lastOutboundAt: r.lastOutboundAt,
          lastOutboundChannel: r.lastOutboundChannel,
          lastOutboundContact: r.lastOutboundContact,
          lastOutboundText: r.lastOutboundText,
          roleTarget: r.roleTarget,
          roleWhy: r.roleWhy,
        })),
      });

      const lines = [];
      lines.push("📋 *Pipeline*");
      lines.push("Rispondi con un numero per aprire il dettaglio (es: 3).");
      lines.push("Oppure: /pipeline <numero>  |  /stop");
      lines.push("");

      rows.slice(0, 30).forEach((r, i) => {
        const idx = i + 1;
        const stage = r.stage || "-";
        const ch = r.channel || r.lastOutboundChannel || "-";
        const contact = r.lastOutboundContact ? ` · ${r.lastOutboundContact}` : "";
        const next = r.nextFollowupAt ? ` · next ${r.nextFollowupAt}` : "";
        const last = r.lastOutboundAt ? ` · last ${r.lastOutboundAt}` : "";
        lines.push(`${idx}) ${r.companyName} — ${stage} — ${ch}${contact}${next}${last}`);
      });

      if (rows.length > 30) lines.push(`\n(visualizzate 30 su ${rows.length})`);

      return tgSend(cfg, chatId, lines.join("\n"));
    }

    case "free":
    default: {
      const txt = String(parsed.args || "").trim();
      const { uiMode, flowState, flowContext } = getFlow(db, chatId);

      const hasActiveFlow = flowState && flowState !== "IDLE";

      if (!hasActiveFlow && uiMode !== "dialog") {
        return tgSend(cfg, chatId, "Ok. Usa /cerca oppure /analizza.");
      }

      // PIPELINE_LIST quick open
      if (flowState === "PIPELINE_LIST") {
        const list = Array.isArray(flowContext.pipelineList) ? flowContext.pipelineList : [];
        const n = Number(txt);

        if (!Number.isFinite(n) || n < 1 || n > list.length) {
          return tgSend(cfg, chatId, "Scrivi un numero valido della lista (es: 1, 2, 3) oppure /stop.");
        }

        const picked = list[n - 1];

        setFlow(db, chatId, "IDLE", {});

        const stage = picked.stage || "-";
        const ch = picked.channel || picked.lastOutboundChannel || "-";
        const contact = picked.lastOutboundContact || "-";
        const next = picked.nextFollowupAt || "-";
        const lastAt = picked.lastOutboundAt || "-";
        const role = picked.roleTarget || "-";
        const why = picked.roleWhy || "-";
        const msg = picked.lastOutboundText ? String(picked.lastOutboundText).trim() : "(nessun OUTBOUND)";

        const detail = [
          `📌 *${picked.companyName}*`,
          `Stato: ${stage}`,
          `Canale: ${ch}`,
          `Contatto: ${contact}`,
          `Next followup: ${next}`,
          "",
          `Target: ${role}`,
          `Perché: ${why}`,
          "",
          `Ultimo OUT (${lastAt}):`,
          msg.length > 3500 ? msg.slice(0, 3500) + "…" : msg,
        ].join("\n");

        return tgSend(cfg, chatId, detail);
      }

      // shortcut: "cerca ..."
      if (flowState === "IDLE" && /^cerca\b/i.test(txt)) {
        const q = txt.replace(/^cerca\b/i, "").trim();
        if (q) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/cerca", args: q } });
        }
        setFlow(db, chatId, "ASK_QUERY", {});
        return tgSend(cfg, chatId, "Ok. Dimmi la ricerca (es: 'meccanica ISO 9001 Lombardia export').");
      }

      // ASK_QUERY
      if (flowState === "ASK_QUERY") {
        setFlow(db, chatId, "IDLE", {});
        return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/cerca", args: txt } });
      }

      // PRESENT_LINK
      if (flowState === "PRESENT_LINK") {
        const cand = flowContext?.candidate;
        const queue = Array.isArray(flowContext.queue) ? flowContext.queue : [];

        if (!cand?.url) {
          setFlow(db, chatId, "IDLE", {});
          return tgSend(cfg, chatId, "Ops, candidato non valido. Rifai /cerca.");
        }

        if (/^apri$/i.test(txt)) {
          return tgSend(cfg, chatId, cand.url);
        }

        if (/^s[iì]$/i.test(txt) || /^si$/i.test(txt)) {
          const company = await withTyping(
  cfg,
  chatId,
  () => addCompanyFromUrl({ cfg, db, chatId, url: cand.url }),
  { progressText: "⏳ Analizzo l’azienda (snippet + AI)…" }
);
          const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

          setFlow(db, chatId, "PRESENT_TARGET", {
            queue,
            companyName: company.name,
            companyUrl: company.website,
            baseDraft: deal.messageDraft || deal.message || "",
            analysis: company.analysis,
            searchQuery: flowContext.searchQuery,
            searchIndex: flowContext.searchIndex,
            searchTotal: flowContext.searchTotal,
          });

          return tgSend(cfg, chatId, briefCompanyText(company, deal, queue.length));
        }

        if (/^no$/i.test(txt)) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
        }

        return tgSend(cfg, chatId, "Rispondi SI o NO (oppure APRI).");
      }

      // PRESENT_TARGET
      if (flowState === "PRESENT_TARGET") {
        const companyUrl = flowContext?.companyUrl;
        const queue = Array.isArray(flowContext.queue) ? flowContext.queue : [];

        if (/^apri$/i.test(txt)) {
          return tgSend(cfg, chatId, companyUrl || "Link non disponibile.");
        }

        if (/^s[iì]$/i.test(txt) || /^si$/i.test(txt)) {
          const llmOn =
            String(cfg?.LLM_PROVIDER || "").toLowerCase() === "openai" &&
            String(cfg?.LLM_API_KEY || "").trim().length > 0;

          if (!llmOn) {
            // fallback menu standard legacy
            setFlow(db, chatId, "ASK_ANGLE", { ...flowContext, queue });
            return tgSend(cfg, chatId, angleMenu());
          }

          // ✅ nuovo: canale all'inizio
          setFlow(db, chatId, "ASK_OUTBOUND_CHANNEL", { ...flowContext, queue });
          return tgSend(cfg, chatId, outboundChannelMenu());
        }

        if (/^no$/i.test(txt)) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
        }

        return tgSend(cfg, chatId, "Rispondi SÌ o NO (oppure APRI).");
      }

      // ASK_OUTBOUND_CHANNEL (NEW)
      if (flowState === "ASK_OUTBOUND_CHANNEL") {
        if (!/^[12]$/.test(txt)) return tgSend(cfg, chatId, "Rispondi 1 (LinkedIn) oppure 2 (Email).");

        const channel = txt === "1" ? "LinkedIn" : "Email";
        const qs = enrichQuestions();

        setFlow(db, chatId, "ASK_ENRICH", {
          ...flowContext,
          channel,
          enrich: {},
          enrichQIndex: 0,
        });

        return tgSend(cfg, chatId, qs[0].text);
      }

      // ASK_ENRICH (NEW)
      if (flowState === "ASK_ENRICH") {
        const qs = enrichQuestions();
        const idx = Number(flowContext.enrichQIndex || 0);
        const q = qs[idx];

        if (!q) {
          // safety fallback
          setFlow(db, chatId, "IDLE", {});
          return tgSend(cfg, chatId, "Ops, stato non valido. Riparti con /cerca oppure /analizza.");
        }

        const raw = String(txt || "").trim();
        if (q.validate && !q.validate(raw)) {
          return tgSend(cfg, chatId, "Risposta non valida. Riprova.\n\n" + q.text);
        }

        const enrich = { ...(flowContext.enrich || {}) };
        enrich[q.key] = q.map ? q.map(raw) : raw;

        const nextIdx = idx + 1;

        if (nextIdx >= qs.length) {
          try {
            const draftPack = await withTyping(
  cfg,
  chatId,
  () => draftOutboundWithLLM({
    cfg,
    company: {
      name: flowContext.companyName,
      website: flowContext.companyUrl,
      analysis: flowContext.analysis,
    },
    channel: flowContext.channel || "LinkedIn",
    enrich,
  }),
  { progressText: "⏳ Genero le bozze (AI)…" }
);

            setFlow(db, chatId, "PICK_DRAFT", {
              ...flowContext,
              draftPack,
              enrich,
            });

            return tgSend(cfg, chatId, renderDraftChoices(draftPack));
          } catch (e) {
            // fallback legacy
            setFlow(db, chatId, "ASK_ANGLE", { ...flowContext });
            return tgSend(cfg, chatId, `Draft AI non disponibile (${e.message}). Vado con menu standard.\n\n${angleMenu()}`);
          }
        }

        setFlow(db, chatId, "ASK_ENRICH", { ...flowContext, enrich, enrichQIndex: nextIdx });
        return tgSend(cfg, chatId, qs[nextIdx].text);
      }

      // Legacy fallback flow (non-LLM)
      if (flowState === "ASK_ANGLE") {
        if (!/^[123]$/.test(txt)) return tgSend(cfg, chatId, "Dimmi 1, 2 o 3.");
        setFlow(db, chatId, "ASK_TONE", { ...flowContext, angleChoice: txt });
        return tgSend(cfg, chatId, toneMenu());
      }

      if (flowState === "ASK_TONE") {
        if (!/^[123]$/.test(txt)) return tgSend(cfg, chatId, "Dimmi 1, 2 o 3.");
        setFlow(db, chatId, "ASK_QR", { ...flowContext, toneChoice: txt });
        return tgSend(cfg, chatId, qrQuestion());
      }

      if (flowState === "ASK_QR") {
        const norm = /^qr$/i.test(txt) ? "QR" : /^senza$/i.test(txt) ? "Senza" : "";
        if (!norm) return tgSend(cfg, chatId, "Rispondi: QR oppure Senza.");

        const draft = buildDraftFromChoices({
          baseDraft: flowContext.baseDraft,
          angleChoice: flowContext.angleChoice,
          toneChoice: flowContext.toneChoice,
          qrChoice: norm,
        });

        setFlow(db, chatId, "FINAL", { ...flowContext, finalDraft: draft, channel: "LinkedIn" });

        return tgSend(
          cfg,
          chatId,
          `Bozza pronta (LinkedIn/Email):
${draft}

Se ti va bene: scrivi OK
Se vuoi modifiche: scrivimi cosa cambiare
Se vuoi saltare: No`
        );
      }

      if (flowState === "FINAL") {
        if (/^ok$/i.test(txt)) {
          // in legacy qui chiedevamo canale: ora diamo per LinkedIn
          setFlow(db, chatId, "ASK_CONTACT", { ...flowContext, channel: flowContext.channel || "LinkedIn" });
          return tgSend(cfg, chatId, contactPrompt(flowContext.channel || "LinkedIn"));
        }

        if (/^no$/i.test(txt)) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
        }

        const draft2 = (flowContext.finalDraft || "") + `\n\n[Nota utente: ${txt}]`;
        setFlow(db, chatId, "FINAL", { ...flowContext, finalDraft: draft2 });
        return tgSend(cfg, chatId, "Ricevuto. Vuoi confermare così? (OK) oppure scrivimi un’altra correzione.");
      }

      // PICK_DRAFT (LLM)
      if (flowState === "PICK_DRAFT") {
        const pack = flowContext?.draftPack || {};
        const drafts = Array.isArray(pack?.drafts) ? pack.drafts : [];
        const queue = Array.isArray(flowContext.queue) ? flowContext.queue : [];
        const channel = flowContext.channel || "LinkedIn";
        const enrich = flowContext.enrich || null;

        if (/^no$/i.test(txt)) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
        }

        if (/^rigenera$/i.test(txt)) {
          try {
            const newPack = await withTyping(cfg, chatId, () =>
              draftOutboundWithLLM({
                cfg,
                company: {
                  name: flowContext.companyName,
                  website: flowContext.companyUrl,
                  analysis: flowContext.analysis,
                },
                channel,
                enrich,
              })
            );

            setFlow(db, chatId, "PICK_DRAFT", { ...flowContext, queue, draftPack: newPack, enrich });
            return tgSend(cfg, chatId, renderDraftChoices(newPack));
          } catch (e) {
            return tgSend(cfg, chatId, `Errore rigenerazione: ${e.message}`);
          }
        }

        const pick = String(txt || "").trim();
        const chosen = drafts.find((d) => d.id === pick);
        if (!chosen) {
          return tgSend(cfg, chatId, "Rispondi 1/2/3 oppure RIGENERA oppure NO.");
        }

        setFlow(db, chatId, "ASK_CONTACT", {
          ...flowContext,
          queue,
          finalDraft: chosen.text,
          finalSubject: chosen.subject || null,
          channel,
        });

        return tgSend(cfg, chatId, contactPrompt(channel));
      }

      // ASK_CONTACT (final)
      if (flowState === "ASK_CONTACT") {
        const channel = flowContext?.channel || "LinkedIn";
        const contact = String(txt || "").trim();

        if (!contact || contact.length < 4) {
          return tgSend(cfg, chatId, "Contatto non valido. Riprova.");
        }

        if (channel === "Email" && !looksLikeEmail(contact)) {
          return tgSend(cfg, chatId, "Email non valida. Riprova (es: nome@azienda.it).");
        }
        if (channel === "LinkedIn" && looksLikeLinkedInUrl(contact) === false && contact.length < 6) {
          return tgSend(cfg, chatId, "Per LinkedIn incolla URL oppure scrivi nome+cognome (min 6 caratteri).");
        }

        upsertUserPrefs({
          db,
          chatId,
          patch: {
            lastDraftMessage: {
              companyName: flowContext.companyName,
              text: flowContext.finalDraft,
              subject: flowContext.finalSubject || null,
              channel,
              contact,
            },
          },
        });

        setFlow(db, chatId, "IDLE", {});
        return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/ok", args: "" } });
      }

      return tgSend(cfg, chatId, "Scrivi 'cerca' per iniziare, oppure /cerca <query>.");
    }
  }
}

function split2(s) {
  const t = String(s || "").trim();
  const i = t.indexOf(" ");
  if (i < 0) return [t, ""];
  return [t.slice(0, i).trim(), t.slice(i + 1).trim()];
}

function renderCompanyProposal(company, deal) {
  return `Azienda: ${company.name}
Sito: ${company.website || "-"}
Settore: ${company.sector || "-"}
Dimensione stimata: ${company.sizeEst || "-"}
Segnali: ${(company.signals || []).join(", ") || "-"}

Ruolo target: ${deal.roleTarget} (motivazione: ${deal.roleWhy})

Strategia ingresso (C+D):
- Qualità/audit: riduzione attrito verifiche
- Soluzione concreta: QR verificabile / dati coerenti
- Niente buzzword blockchain nel primo contatto

Bozza LinkedIn (v1):
${deal.messageDraft}

Comandi: /prossima | (scrivimi correzioni) | OK`;
}