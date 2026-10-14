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

/** ISO weekday, 1 (Monday) to 7 (Sunday). */
export function isoWeekday(iso: string) {
  return parse(iso).getDay() || 7;
}

/** The day this person's weeks start on, from their locale: 7 (Sunday) in the US, 1 (Monday) in most places. */
export function weekStartDay(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    return locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? 7;
  } catch {
    return 7;
  }
}

export function startOfWeek(iso: string, weekStart = weekStartDay()) {
  return addDays(iso, -((isoWeekday(iso) - weekStart + 7) % 7));
}

export function startOfMonth(iso: string) {
  return `${iso.slice(0, 8)}01`;
}

export function addMonths(iso: string, months: number) {
  const d = parse(startOfMonth(iso));
  d.setMonth(d.getMonth() + months);
  return isoDate(d);
}

/** Whole weeks covering the month, so the grid always starts on the first weekday. */
export function monthGrid(iso: string, weekStart = weekStartDay()) {
  const first = startOfMonth(iso);
  const start = startOfWeek(first, weekStart);
  const last = addDays(addMonths(first, 1), -1);
  const days = daysFrom(start, last) + 1;
  return Array.from({ length: Math.ceil(days / 7) * 7 }, (_, i) => addDays(start, i));
}

export function monthLabel(iso: string) {
  return parse(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function shortDate(iso: string) {
  return parse(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullDate(iso: string) {
  return parse(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** A weekday's name from its ISO number. */
export function weekdayName(day: number, style: 'short' | 'long' | 'narrow' = 'short') {
  // Jan 1, 2024 was a Monday.
  return parse(addDays('2024-01-01', day - 1)).toLocaleDateString(undefined, { weekday: style });
}

export function timeLabel(at: string | Date) {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
