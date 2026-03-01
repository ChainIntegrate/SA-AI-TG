// src/telegram/commands.js
import { tgSend } from "./templates.js";
import { upsertUserPrefs, getUserPrefs } from "../core/state.js";
import { addCompanyFromUrl, proposeNextCompany } from "../services/companyAnalyzer.js";
import {
  createDealForCompany,
  setDealStage,
  addNote,
  listPipeline,
  recordOutboundMessage,
} from "../core/pipeline.js";
import { searchWeb } from "../services/search.js";

export function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return { cmd: "free", args: t };
  const [head, ...rest] = t.split(" ");
  return { cmd: head.toLowerCase(), args: rest.join(" ").trim() };
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

function briefCompanyText(company, deal, remaining) {
  const ev = Array.isArray(company?.analysis?.evidence_map)
    ? company.analysis.evidence_map
    : [];
  const evTop = ev.slice(0, 2);

  const whyShort = evTop.length
    ? evTop.map((x) => x.claim).join(" | ")
    : (company.signals || []).slice(0, 2).join(", ") || "segnali qualità/filiera";

  const angle = company.entryAngle || deal.entryAngle || "Audit/Qualità (no buzzword)";

  const lines = [
    `Azienda: ${company.name}`,
    `Link: ${company.website || "-"}`,
    `Perché lei: ${whyShort}`,
    `Ruolo target: ${deal.roleTarget}`,
    `Angolo: ${angle}`,
    `La teniamo? (Sì/No)`,
  ];

  if (typeof remaining === "number") lines.push(`In coda: ${remaining}`);

  const evLines = evTop.length
    ? "\nFatti (da snippet):\n" +
      evTop.map((x) => `- ${x.claim} (${x.evidence_ref})`).join("\n")
    : "";

  return lines.slice(0, 8).join("\n") + evLines;
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

function channelMenu() {
  return [
    "Perfetto. Su che canale lo invii?",
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

function buildDraftFromChoices({ baseDraft, angleChoice, toneChoice, qrChoice }) {
  let intro = baseDraft;

  // Angolo
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

  // QR esplicito / implicito
  if (qrChoice === "QR") {
    if (!/QR/i.test(intro)) {
      intro = intro.replace(
        "verificabili tramite QR operativo",
        "verificabili tramite QR operativo"
      );
    }
  } else if (qrChoice === "Senza") {
    intro = intro.replace(/tramite QR operativo,?\s*/i, "in modo verificabile, ");
  }

  // Tono (ritocchi)
  if (toneChoice === "1") {
    intro = intro.replace(
      "Mi chiedevo se possa avere senso un confronto di 15 minuti",
      "Se ha senso, ci sentiamo 15 minuti"
    );
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
          flowContext: {},
        },
      });
      return tgSend(cfg, chatId, `Ok. Modalità: ${arg}`);
    }

    case "/stop": {
      upsertUserPrefs({ db, chatId, patch: { flowState: "IDLE", flowContext: {} } });
      return tgSend(
        cfg,
        chatId,
        "Ok, stop. Quando vuoi ripartire: scrivi 'cerca' o usa /cerca <query>."
      );
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
- /filtri set key=value ...`
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

      // console mode
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

      // dialog mode
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

        // coda con candidate object
        if (next && typeof next === "object" && next.url) {
          const idx = Number(flowContext.searchIndex || 1) + 1;
          const total = Number(flowContext.searchTotal || (rest.length + 1));

          setFlow(db, chatId, "PRESENT_LINK", {
            ...flowContext,
            queue: rest,
            candidate: next,
            searchIndex: idx,
            searchTotal: total,
          });

          return tgSend(cfg, chatId, renderCandidate(next, idx, total));
        }

        // fallback vecchio (queue era array di url)
        const nextUrl = String(next || "");
        const company = await addCompanyFromUrl({ cfg, db, chatId, url: nextUrl });
        const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

        setFlow(db, chatId, "PRESENT_TARGET", {
          ...flowContext,
          queue: rest,
          companyName: company.name,
          companyUrl: company.website,
          baseDraft: deal.messageDraft,
        });

        return tgSend(cfg, chatId, briefCompanyText(company, deal, rest.length));
      }

      // console fallback
      const next = await proposeNextCompany({ cfg, db, chatId });
      if (!next) return tgSend(cfg, chatId, "Non ho altre aziende in coda. Usa /cerca <query> oppure /analizza <url>.");
      return tgSend(cfg, chatId, renderCompanyProposal(next.company, next.deal));
    }

    case "/ok": {
      // Ora pretendiamo anche channel + contact
      const lastDraft = prefs?.lastDraftMessage;
      if (!lastDraft?.companyName || !lastDraft?.text) {
        return tgSend(cfg, chatId, "Non ho un messaggio draft da finalizzare. Prima /analizza (o /cerca) e completa il flow.");
      }
      if (!lastDraft?.channel || !lastDraft?.contact) {
        return tgSend(cfg, chatId, "Mi manca il contatto/canale. Completa il flow (canale + contatto) e poi OK.");
      }

      // Persiste OUTBOUND (assumendo che pipeline.js supporti i campi extra; se non li supporta, vedi nota sotto)
      recordOutboundMessage({
        db,
        chatId,
        companyName: lastDraft.companyName,
        text: lastDraft.text,
        channel: lastDraft.channel,
        contact: lastDraft.contact,
      });

      setDealStage({ db, chatId, companyName: lastDraft.companyName, stage: "Contattato" });

      return tgSend(
        cfg,
        chatId,
        `Fatto ✅ Messaggio salvato come OUTBOUND e stato=Contattato.
Canale: ${lastDraft.channel}
Contatto: ${lastDraft.contact}`
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
  const rows = listPipeline({ db, chatId });
  if (!rows.length) return tgSend(cfg, chatId, "Pipeline vuota.");

  const out = rows.map((r) => {
    const stage = r.stage || "-";
    const ch = r.channel || r.lastOutboundChannel || "-";
    const role = r.roleTarget ? ` | target: ${r.roleTarget}` : "";
    const next = ` | next: ${r.nextFollowupAt || "-"}`;

    const contact = r.lastOutboundContact ? ` | contatto: ${r.lastOutboundContact}` : "";

    const lastAt = r.lastOutboundAt ? ` | last OUT: ${r.lastOutboundAt}` : "";
    const preview = r.lastOutboundText
      ? `\n  ↳ "${String(r.lastOutboundText).replace(/\s+/g, " ").trim().slice(0, 140)}${String(r.lastOutboundText).length > 140 ? "…" : ""}"`
      : "";

    return `- ${r.companyName} | ${stage} | ch: ${ch}${role}${contact}${next}${lastAt}${preview}`;
  }).join("\n");

  return tgSend(cfg, chatId, `Pipeline:\n${out}`);
}

    case "free":
    default: {
      const txt = String(parsed.args || "").trim();
      const { uiMode, flowState, flowContext } = getFlow(db, chatId);

      const hasActiveFlow = flowState && flowState !== "IDLE";

      if (!hasActiveFlow && uiMode !== "dialog") {
        return tgSend(cfg, chatId, "Ok. Usa /cerca oppure /analizza.");
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
          const company = await addCompanyFromUrl({ cfg, db, chatId, url: cand.url });
          const deal = createDealForCompany({ cfg, db, chatId, company, channel: "LinkedIn" });

          setFlow(db, chatId, "PRESENT_TARGET", {
            queue,
            companyName: company.name,
            companyUrl: company.website,
            baseDraft: deal.messageDraft || deal.message || "",
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
          setFlow(db, chatId, "ASK_ANGLE", { ...flowContext, queue });
          return tgSend(cfg, chatId, angleMenu());
        }

        if (/^no$/i.test(txt)) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
        }

        return tgSend(cfg, chatId, "Rispondi SÌ o NO (oppure APRI).");
      }

      // ASK_ANGLE
      if (flowState === "ASK_ANGLE") {
        if (!/^[123]$/.test(txt)) return tgSend(cfg, chatId, "Dimmi 1, 2 o 3.");
        setFlow(db, chatId, "ASK_TONE", { ...flowContext, angleChoice: txt });
        return tgSend(cfg, chatId, toneMenu());
      }

      // ASK_TONE
      if (flowState === "ASK_TONE") {
        if (!/^[123]$/.test(txt)) return tgSend(cfg, chatId, "Dimmi 1, 2 o 3.");
        setFlow(db, chatId, "ASK_QR", { ...flowContext, toneChoice: txt });
        return tgSend(cfg, chatId, qrQuestion());
      }

      // ASK_QR
      if (flowState === "ASK_QR") {
        const norm = /^qr$/i.test(txt) ? "QR" : /^senza$/i.test(txt) ? "Senza" : "";
        if (!norm) return tgSend(cfg, chatId, "Rispondi: QR oppure Senza.");

        const draft = buildDraftFromChoices({
          baseDraft: flowContext.baseDraft,
          angleChoice: flowContext.angleChoice,
          toneChoice: flowContext.toneChoice,
          qrChoice: norm,
        });

        setFlow(db, chatId, "FINAL", { ...flowContext, finalDraft: draft });

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

      // FINAL
      if (flowState === "FINAL") {
        if (/^ok$/i.test(txt)) {
          // Ora chiediamo canale prima di salvare
          setFlow(db, chatId, "ASK_CHANNEL", { ...flowContext });
          return tgSend(cfg, chatId, channelMenu());
        }

        if (/^no$/i.test(txt)) {
          return handleCommand({ cfg, db, chatId, user, parsed: { cmd: "/prossima", args: "" } });
        }

        // correzioni libere: append e resta in FINAL
        const draft2 = (flowContext.finalDraft || "") + `\n\n[Nota utente: ${txt}]`;
        setFlow(db, chatId, "FINAL", { ...flowContext, finalDraft: draft2 });
        return tgSend(cfg, chatId, "Ricevuto. Vuoi confermare così? (OK) oppure scrivimi un’altra correzione.");
      }

      // ASK_CHANNEL
      if (flowState === "ASK_CHANNEL") {
        if (!/^[12]$/.test(txt)) return tgSend(cfg, chatId, "Rispondi 1 (LinkedIn) oppure 2 (Email).");
        const channel = txt === "1" ? "LinkedIn" : "Email";
        setFlow(db, chatId, "ASK_CONTACT", { ...flowContext, channel });
        return tgSend(cfg, chatId, contactPrompt(channel));
      }

      // ASK_CONTACT
      if (flowState === "ASK_CONTACT") {
        const channel = flowContext?.channel;
        const contact = String(txt || "").trim();

        if (!contact || contact.length < 4) {
          return tgSend(cfg, chatId, "Contatto non valido. Riprova.");
        }

        // validazione leggera per evitare garbage
        if (channel === "Email" && !looksLikeEmail(contact)) {
          return tgSend(cfg, chatId, "Email non valida. Riprova (es: nome@azienda.it).");
        }
        if (channel === "LinkedIn" && looksLikeLinkedInUrl(contact) === false && contact.length < 6) {
          return tgSend(cfg, chatId, "Per LinkedIn incolla URL oppure scrivi nome+cognome (min 6 caratteri).");
        }

        // salva draft + channel + contact per /ok
        upsertUserPrefs({
          db,
          chatId,
          patch: {
            lastDraftMessage: {
              companyName: flowContext.companyName,
              text: flowContext.finalDraft,
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