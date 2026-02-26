import { tgSend } from "./templates.js";
import { upsertUserPrefs, getUserPrefs } from "../core/state.js";
import { addCompanyFromUrl, proposeNextCompany } from "../services/companyAnalyzer.js";
import { createDealForCompany, setDealStage, addNote, listPipeline, recordOutboundMessage } from "../core/pipeline.js";

export function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return { cmd: "free", args: t };
  const [head, ...rest] = t.split(" ");
  return { cmd: head.toLowerCase(), args: rest.join(" ").trim() };
}

export async function handleCommand({ cfg, db, chatId, user, parsed }) {
  const prefs = getUserPrefs({ db, chatId });

  switch (parsed.cmd) {
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
      const query = parsed.args;
      if (!query) return tgSend(cfg, chatId, "Mi serve una query. Esempio: /cerca manifatturiero ISO 9001 Lombardia export");
      // TODO: integrare search provider
      return tgSend(cfg, chatId,
`Ricerca avviata (placeholder).
Per ora: incollami 1 URL con /analizza oppure dimmi che provider search vuoi usare.
Query ricevuta: "${query}"`);
    }

    case "/prossima": {
      const next = await proposeNextCompany({ cfg, db, chatId });
      if (!next) return tgSend(cfg, chatId, "Non ho altre aziende in coda. Usa /analizza <url> oppure /cerca <query>.");
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
    default:
      return tgSend(cfg, chatId, "Ok. Usa /cerca oppure /analizza. Se vuoi, dimmi settore/area e ti imposto i filtri.");
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
