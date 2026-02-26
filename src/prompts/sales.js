export function pickRoleTarget({ sizeBand, signals, sector }) {
  const s = String(sizeBand || "").toLowerCase();
  const sig = (signals || []).join(" ").toLowerCase();
  const sec = String(sector || "").toLowerCase();

  // euristiche base (poi si migliora con analyzer vero)
  const hasEsg = sig.includes("sosten") || sig.includes("esg");
  const isAuto = sec.includes("automotive") || sig.includes("automotive");

  if (hasEsg) {
    return { roleTarget: "Sustainability/ESG", roleWhy: "presenza segnali sustainability/ESG: ingresso naturale su compliance e dati verificabili" };
  }
  if (isAuto) {
    return { roleTarget: "Responsabile Qualità", roleWhy: "filiera strutturata: audit cliente e certificazioni sono leva primaria" };
  }
  if (s.includes("10-40") || s.includes("10") || s.includes("20") || s.includes("30-")) {
    return { roleTarget: "CEO/Titolare", roleWhy: "azienda piccola: decisione e qualità spesso in mano al titolare" };
  }
  return { roleTarget: "Responsabile Qualità", roleWhy: "azienda PMI: audit e gestione certificazioni sono in area qualità (ingresso C + D)" };
}

export function buildLinkedInDraft({ companyName, roleTarget, sectorHint, signals }) {
  // Tono C + D: qualità/audit + soluzione concreta, no buzzword blockchain
  const obs = buildObservation(signals, sectorHint);

  return `Buongiorno, ${obs}
Sto seguendo progetti che riducono il tempo speso in audit e verifiche documentali, rendendo certificazioni e dati di filiera verificabili tramite QR operativo, senza stravolgere i processi esistenti.
Se ha senso, mi farebbe piacere un confronto di 15 minuti per capire se può portare valore anche a ${companyName}.`;
}

function buildObservation(signals, sectorHint) {
  const s = (signals || []).map(x => String(x)).filter(Boolean);
  if (s.length) {
    return `ho visto alcuni segnali di attenzione a qualità/filiera (${s.slice(0, 2).join(", ")}).`;
  }
  if (sectorHint && sectorHint !== "Da classificare") {
    return `ho visto che operate nel settore ${sectorHint} e lavorate su temi qualità/filiera.`;
  }
  return `ho visto la vostra realtà e i temi di qualità/organizzazione che normalmente emergono in contesti simili.`;
}
