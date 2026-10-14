/** The planning day starts at the cutoff hour, so 1am still belongs to "yesterday". */
export function planningDate(now = new Date(), cutoffHour = 4) {
  const d = new Date(now);
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  return d;
}

export function longDate(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function firstName(name: string) {
  return name.split(/\s+/)[0] ?? name;
}
