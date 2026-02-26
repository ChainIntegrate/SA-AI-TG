export function nowIso() {
  return new Date().toISOString();
}

export function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}
