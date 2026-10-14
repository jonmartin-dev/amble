/** The planning day starts at the cutoff hour, so 1am still belongs to "yesterday". */
export function planningDate(now = new Date(), cutoffHour = 4) {
  const d = new Date(now);
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  return d;
}

// toLocaleDateString builds a new formatter on every call, which a screen full of dates pays for
// on each render; one formatter per set of options is built once and kept.
const formatters = new Map<string, Intl.DateTimeFormat>();

function format(d: Date, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(undefined, options)));
  return f.format(d);
}

export function longDate(d: Date) {
  return format(d, { weekday: 'long', month: 'short', day: 'numeric' });
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
  if (diff > 1 && diff < 7) return format(d, { weekday: long ? 'long' : 'short' });
  return format(d, { month: 'short', day: 'numeric' });
}

export function weekdayShort(iso: string) {
  return format(parse(iso), { weekday: 'short' });
}

export function dayOfMonth(iso: string) {
  return parse(iso).getDate();
}

/** ISO weekday, 1 (Monday) to 7 (Sunday). */
export function isoWeekday(iso: string) {
  return parse(iso).getDay() || 7;
}

let weekStart: number | undefined;

/** The day this person's weeks start on, from their locale: 7 (Sunday) in the US, 1 (Monday) in most places. */
export function weekStartDay(): number {
  return (weekStart ??= readWeekStart());
}

function readWeekStart(): number {
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
  return format(parse(iso), { month: 'long', year: 'numeric' });
}

/** "Oct" from "2026-10". */
export function monthShort(month: string) {
  return format(parse(`${month}-15`), { month: 'short' });
}

export function shortDate(iso: string) {
  return format(parse(iso), { month: 'short', day: 'numeric' });
}

export function fullDate(iso: string) {
  return format(parse(iso), { weekday: 'long', month: 'long', day: 'numeric' });
}

/** A weekday's name from its ISO number. */
export function weekdayName(day: number, style: 'short' | 'long' | 'narrow' = 'short') {
  // Jan 1, 2024 was a Monday.
  return format(parse(addDays('2024-01-01', day - 1)), { weekday: style });
}

export function timeLabel(at: string | Date) {
  return format(new Date(at), { hour: 'numeric', minute: '2-digit' });
}

/** "6 PM", or "6:30 PM" when it isn't on the hour. */
export function clockLabel(at: string | Date) {
  const d = new Date(at);
  return format(d, d.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
}

/** When a reminder goes off: "Today 6 PM", "Tomorrow 9 AM", "Thu 6 PM", "Oct 21, 9 AM". Plain calendar days, not planning days. */
export function reminderLabel(at: string | Date) {
  const d = new Date(at);
  const diff = daysFrom(isoDate(new Date()), isoDate(d));
  const day =
    diff === 0
      ? 'Today'
      : diff === 1
        ? 'Tomorrow'
        : diff > 1 && diff < 7
          ? format(d, { weekday: 'short' })
          : format(d, d.getFullYear() !== new Date().getFullYear() ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${day}${diff > 1 && diff < 7 ? '' : diff < 0 || diff >= 7 ? ',' : ''} ${clockLabel(d)}`;
}

/** A moment as a datetime-local input wants it: "2026-10-16T18:00", in this device's time. */
export function localInputValue(d: Date) {
  return `${isoDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A reminder time inside a sentence: "today 6 PM", "tomorrow 9 AM", "Thu 6 PM". */
export function reminderPhrase(at: string | Date) {
  return reminderLabel(at).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
}
