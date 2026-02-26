import { tgSend } from "../telegram/templates.js";
import { nowIso } from "../utils/time.js";

export async function runFollowupSweep({ cfg, db }) {
  const now = nowIso();

  // tutti i deal in "Contattato" con followup scaduto
  const rows = db.prepare(`
SELECT d.id AS dealId, c.name AS companyName, d.next_followup_at AS nextFollowupAt, d.chat_id AS chatId
FROM deals d
JOIN companies c ON c.id=d.company_id
WHERE d.stage='Contattato'
  AND d.next_followup_at IS NOT NULL
  AND d.next_followup_at <= ?
ORDER BY d.next_followup_at ASC
LIMIT 20
  `).all(now);

  for (const r of rows) {
    await tgSend(cfg, r.chatId,
`Follow-up: ${r.companyName}
Com'è andata?
1) Nessuna risposta
2) Hanno risposto
3) Call fissata
4) Archivia

Rispondi con: /stato ${r.companyName} <fase>  (es: /stato ${r.companyName} Nessuna_risposta)
Oppure aggiungi nota: /nota ${r.companyName} <testo>`);

    // per evitare spam, sposta followup avanti di 2 giorni se non aggiorni stato
    const bump = addDaysIsoFrom(now, 2);
    db.prepare(`UPDATE deals SET next_followup_at=? WHERE id=?`).run(bump, r.dealId);
  }
}

function addDaysIsoFrom(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}
