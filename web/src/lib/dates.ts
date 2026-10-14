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

// Calendar dates travel as YYYY-MM-DD. Parse them at local noon so no timezone shifts the day.
const parse = (iso: string) => new Date(`${iso}T12:00:00`);

export function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayIso() {
  return isoDate(planningDate());
}

export function addDays(iso: string, days: number) {
  const d = parse(iso);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

export function daysFrom(today: string, iso: string) {
  return Math.round((parse(iso).getTime() - parse(today).getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "Thu" (or "Thursday" when long) within the week ahead, otherwise "Oct 21". */
export function dayLabel(iso: string, today: string, long = false) {
  const diff = daysFrom(today, iso);
  if (diff === 0) return long ? 'today' : 'Today';
  if (diff === 1) return long ? 'tomorrow' : 'Tomorrow';
  if (diff === -1) return long ? 'yesterday' : 'Yesterday';
  const d = parse(iso);
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: long ? 'long' : 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function weekdayShort(iso: string) {
  return parse(iso).toLocaleDateString(undefined, { weekday: 'short' });
}

export function dayOfMonth(iso: string) {
  return parse(iso).getDate();
}
