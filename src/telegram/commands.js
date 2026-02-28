
import { tgSend } from "./templates.js";
import { upsertUserPrefs, getUserPrefs } from "../core/state.js";
import { addCompanyFromUrl, proposeNextCompany } from "../services/companyAnalyzer.js";
import { createDealForCompany, setDealStage, addNote, listPipeline, recordOutboundMessage } from "../core/pipeline.js";
import { searchWeb } from "../services/search.js";

export function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return { cmd: "free", args: t };
  const [head, ...rest] = t.split(" ");
  return { cmd: head.toLowerCase(), args: rest.join(" ").trim() };
}

function setFlow(db, chatId, flowState, flowContext = {}) {
  upsertUserPrefs({ db, chatId, patch: { flowState, flowContext } });
}

function getFlow(db, chatId) {
  const p = getUserPrefs({ db, chatId });
  return { uiMode: p.uiMode || "dialog", flowState: p.flowState || "IDLE", flowContext: p.flowContext || {}, prefs: p };
}

function briefCompanyText(company, deal, remaining) {
  // 6–8 righe max
  const lines = [
    `Azienda: ${company.name}`,
    `Link: ${company.website || "-"}`,
    `Perché lei: ${(company.signals || []).slice(0, 2).join(", ") || "segnali qualità/filiera"}`,
    `Ruolo target: ${deal.roleTarget}`,
    `Angolo: Audit/Qualità (no buzzword)`,
    `La teniamo? (Sì/No)`,
  ];
  if (typeof remaining === "number") lines.push(`In coda: ${remaining}`);
  return lines.slice(0, 8).join("\n");
}

function angleMenu() {
  return [
    "Ok. Da che angolo entriamo?",
    "1) Riduzione tempo audit",
    "2) Errori/versioni documenti",
    "3) QR verificabile per clienti esteri",
    "Rispondi 1/2/3"
  ].join("\n");
}

function toneMenu() {
  return [
    "Tono del messaggio?",
    "1) Diretto",
    "2) Bilanciato",
    "3) Più formale",
    "Rispondi 1/2/3"
  ].join("\n");
}

function qrQuestion() {
  return "Nel testo citiamo esplicitamente “QR operativo”? (QR/Senza)";
}

function buildDraftFromChoices({ baseDraft, angleChoice, toneChoice, qrChoice }) {
  // baseDraft viene dal companyAnalyzer (già C + D).
  // Qui facciamo micro-varianti senza LLM, restando industriali.
  let intro = baseDraft;

  // Angolo
  if (angleChoice === "1") {
    intro = intro.replace("riducendo il tempo speso in audit e verifiche documentali", "riducendo tempi e attriti in audit e verifiche documentali");
  } else if (angleChoice === "2") {
    intro = intro.replace("riducendo il tempo speso in audit e verifiche documentali", "riducendo errori, duplicazioni e versioni incoerenti nei documenti di qualità");
  } else if (angleChoice === "3") {
    intro = intro.replace("riducendo il tempo speso in audit e verifiche documentali", "semplificando la verifica per clienti esteri con un accesso rapido e verificabile");
  }

  // QR esplicito / implicito
  if (qrChoice === "QR") {
    if (!/QR/i.test(intro)) {
      intro = intro.replace("verificabili tramite QR operativo", "verificabili tramite QR operativo");
    }
  } else if (qrChoice === "Senza") {
    intro = intro.replace(/tramite QR operativo,?\s*/i, "in modo verificabile, ");
  }

  // Tono (ritocchi)
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
          flowContext: {}
        }
      });
      return tgSend(cfg, chatId, `Ok. Modalità: ${arg}`);
    }

    case "/stop": {
      upsertUserPrefs({ db, chatId, patch: { flowState: "IDLE", flowContext: {} } });
      return tgSend(cfg, chatId, "Ok, stop. Quando vuoi ripartire: scrivi 'cerca' o usa /cerca <query>.");
    }

    case "/start":
      return tgSend(cfg, chatId,
`Ciao! Sono CI Sales Agent.
Comandi:
- /cerca <query>
- /analizza <url>
- /prossima
- /approva
- /ok
- /stato <azienda> <fase>
- /nota <azienda> <testo>
- /pipeline
- /filtri set key=value ...`);

          case "/webhook": {
      // Imposta o mostra info webhook
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

  // Console mode: mantiene output lungo (se vuoi)
  if (uiMode === "console") {
    if (!query) return tgSend(cfg, chatId, "Uso: /cerca <query>");
    const q = `${query} sito azienda`;
    const results = await searchWeb({ cfg, query: q, count: 12, country: "IT", searchLang: "it" });
    if (!results.length) return tgSend(cfg, chatId, "Nessun risultato utile.");

    const queue = results.map(r => r.url).slice(0, 8);
    upsertUserPrefs({ db, chatId, patch: { lastSearchQueue: queue.slice(1), lastSearchQuery: query } });

    const company = await addCompanyFromUrl({ cfg, db, chatId, url: queue[0] });
    const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

    return tgSend(cfg, chatId, renderCompanyProposal(company, deal));
  }

  // Dialog mode
  if (!query) {
    setFlow(db, chatId, "ASK_QUERY", {});
    return tgSend(cfg, chatId, "Ok. Dimmi la ricerca (es: 'meccanica ISO 9001 Lombardia export').");
  }

  // Esegue search Brave e presenta 1 azienda (breve)
  const q = `${query} sito azienda`;
  let results = [];
  try {
    results = await searchWeb({ cfg, query: q, count: 12, country: "IT", searchLang: "it" });
  } catch (e) {
    setFlow(db, chatId, "IDLE", {});
  return tgSend(cfg, chatId, `Errore ricerca: ${e.message}`);
  }

  if (!results.length) {
    setFlow(db, chatId, "IDLE", {});
return tgSend(cfg, chatId, `Errore ricerca: ${e.message}`);
  }

  const queue = results.map(r => r.url).slice(0, 8);
  const firstUrl = queue[0];
  const rest = queue.slice(1);

  const company = await addCompanyFromUrl({ cfg, db, chatId, url: firstUrl });
  const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

  setFlow(db, chatId, "PRESENT_TARGET", {
    queue: rest,
    companyName: company.name,
    companyUrl: company.website,
baseDraft: deal.messageDraft || deal.message || ""
  });

  return tgSend(cfg, chatId, briefCompanyText(company, deal, rest.length));
}

   case "/prossima": {
  const { uiMode, flowState, flowContext, prefs } = getFlow(db, chatId);

  // Dialog: usa coda nello state (prioritaria)
  if (uiMode === "dialog") {
    const queue = Array.isArray(flowContext.queue) ? flowContext.queue : [];
    if (!queue.length) return tgSend(cfg, chatId, "Coda vuota. Scrivi 'cerca' o usa /cerca <query>.");

    const nextUrl = queue[0];
    const rest = queue.slice(1);

    const company = await addCompanyFromUrl({ cfg, db, chatId, url: nextUrl });
    const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

    setFlow(db, chatId, "PRESENT_TARGET", {
      ...flowContext,
      queue: rest,
      companyName: company.name,
      companyUrl: company.website,
      baseDraft: deal.messageDraft
    });

    return tgSend(cfg, chatId, briefCompanyText(company, deal, rest.length));
  }

  // Console: fallback vecchio se lo avevi
  const next = await proposeNextCompany({ cfg, db, chatId });
  if (!next) return tgSend(cfg, chatId, "Non ho altre aziende in coda. Usa /cerca <query> oppure /analizza <url>.");
  return tgSend(cfg, chatId, renderCompanyProposal(next.company, next.deal));
}
    case "/approva":
      // qui puoi marcare come “target scelto” e passare in modalità messaggio
      return tgSend(cfg, chatId, "Ok. Dimmi ora correzioni per il messaggio, oppure scrivi /ok per finalizzare.");

    case "/ok": {
      // per ora: salva “ultimo draft” come outbound (placeholder)
      const lastDraft = prefs?.lastDraftMessage;
      if (!lastDraft?.companyName || !lastDraft?.text) {
        return tgSend(cfg, chatId, "Non ho un messaggio draft da finalizzare. Prima /analizza e poi dammi correzioni.");
      }
      recordOutboundMessage({ db, chatId, companyName: lastDraft.companyName, text: lastDraft.text });
      setDealStage({ db, chatId, companyName: lastDraft.companyName, stage: "Contattato" });
      return tgSend(cfg, chatId, "Fatto ✅ Messaggio salvato come OUTBOUND e stato=Contattato. Follow-up programmato.");
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
      const rows = listPipeline({ db, chatId });
      if (!rows.length) return tgSend(cfg, chatId, "Pipeline vuota.");
      const out = rows.map(r => `- ${r.companyName} | ${r.stage} | next: ${r.nextFollowupAt || "-"}`).join("\n");
      return tgSend(cfg, chatId, `Pipeline:\n${out}`);
    }

    case "free":
default: {
  const txt = String(parsed.args || "").trim();

  const { uiMode, flowState, flowContext } = getFlow(db, chatId);
  if (uiMode !== "dialog") {
    return tgSend(cfg, chatId, "Ok. Usa /cerca oppure /analizza.");
  }

  // shortcut: scrivi "cerca" per avviare
  if (flowState === "IDLE" && /^cerca\b/i.test(txt)) {
    const q = txt.replace(/^cerca\b/i, "").trim();
    if (q) {
      // simula /cerca <query>
      return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/cerca", args: q } });
    }
    setFlow(db, chatId, "ASK_QUERY", {});
    return tgSend(cfg, chatId, "Ok. Dimmi la ricerca (es: 'meccanica ISO 9001 Lombardia export').");
  }

  // ASK_QUERY: l'utente fornisce la query
  if (flowState === "ASK_QUERY") {
    setFlow(db, chatId, "IDLE", {}); // reset, poi chiamiamo /cerca
    return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/cerca", args: txt } });
  }

  // PRESENT_TARGET: attendo Sì/No
  if (flowState === "PRESENT_TARGET") {
    if (/^s[iì]$/i.test(txt) || /^si$/i.test(txt)) {
      setFlow(db, chatId, "ASK_ANGLE", { ...flowContext });
      return tgSend(cfg, chatId, angleMenu());
    }
    if (/^no$/i.test(txt)) {
      // passa alla prossima
      return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
    }
    return tgSend(cfg, chatId, "Rispondi Sì o No.");
  }

  // ASK_ANGLE: attendo 1/2/3
  if (flowState === "ASK_ANGLE") {
    if (!/^[123]$/.test(txt)) return tgSend(cfg, chatId, "Dimmi 1, 2 o 3.");
    setFlow(db, chatId, "ASK_TONE", { ...flowContext, angleChoice: txt });
    return tgSend(cfg, chatId, toneMenu());
  }

  // ASK_TONE: attendo 1/2/3
  if (flowState === "ASK_TONE") {
    if (!/^[123]$/.test(txt)) return tgSend(cfg, chatId, "Dimmi 1, 2 o 3.");
    setFlow(db, chatId, "ASK_QR", { ...flowContext, toneChoice: txt });
    return tgSend(cfg, chatId, qrQuestion());
  }

  // ASK_QR: attendo QR/Senza
  if (flowState === "ASK_QR") {
    const norm = (/^qr$/i.test(txt)) ? "QR" : (/^senza$/i.test(txt) ? "Senza" : "");
    if (!norm) return tgSend(cfg, chatId, "Rispondi: QR oppure Senza.");
    const draft = buildDraftFromChoices({
      baseDraft: flowContext.baseDraft,
      angleChoice: flowContext.angleChoice,
      toneChoice: flowContext.toneChoice,
      qrChoice: norm
    });

    // salva draft in prefs per /ok (come già fai)
    upsertUserPrefs({ db, chatId, patch: { lastDraftMessage: { companyName: flowContext.companyName, text: draft } } });

    setFlow(db, chatId, "FINAL", { ...flowContext, finalDraft: draft });

    return tgSend(cfg, chatId,
`Bozza pronta (LinkedIn DM):
${draft}

Se ti va bene: scrivi OK
Se vuoi modifiche: scrivimi cosa cambiare
Se vuoi saltare: No`);
  }

  // FINAL: OK / No / correzioni libere
  if (flowState === "FINAL") {
    if (/^ok$/i.test(txt)) {
      // chiama il tuo /ok esistente
      setFlow(db, chatId, "IDLE", {});
      return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/ok", args: "" } });
    }
    if (/^no$/i.test(txt)) {
      setFlow(db, chatId, "PRESENT_TARGET", { ...flowContext });
      return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
    }
    // correzioni libere: per ora le appendiamo come nota e chiediamo OK
    // (se vuoi, dopo integriamo LLM per rigenerare davvero)
    const draft2 = (flowContext.finalDraft || "") + `\n\n[Nota utente: ${txt}]`;
    upsertUserPrefs({ db, chatId, patch: { lastDraftMessage: { companyName: flowContext.companyName, text: draft2 } } });
    setFlow(db, chatId, "FINAL", { ...flowContext, finalDraft: draft2 });
    return tgSend(cfg, chatId, "Ricevuto. Vuoi confermare così? (OK) oppure scrivimi un’altra correzione.");
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
  return (
`Azienda: ${company.name}
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

Comandi: /approva | /prossima | (scrivimi correzioni) | /ok`
  );
}
