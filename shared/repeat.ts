// Repeat rules for tasks, shared by the server (which schedules the next one) and the app (which
// describes and edits them). Dates are YYYY-MM-DD. Weekdays are ISO: 1 is Monday, 7 is Sunday.

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';

export interface Repeat {
  /** `schedule` follows the calendar; `after` comes back a set time after the last one was done. */
  mode: 'schedule' | 'after';
  /** Every this many units (1 or more). */
  every: number;
  unit: RepeatUnit;
  /** Weekly: which days. Defaults to the weekday of the first one. */
  weekdays?: number[] | null;
  /** Monthly or yearly: day of the month, or -1 for the last day. Defaults to the first one's. */
  day?: number | null;
  /** Monthly: the nth `weekday` of the month (1 to 4, or -1 for the last), e.g. the 2nd Thursday. */
  nth?: number | null;
  weekday?: number | null;
  /** Yearly: the month (1 to 12). Defaults to the first one's. */
  month?: number | null;
  /** Only in these months (1 to 12), for seasonal chores like mowing. */
  months?: number[] | null;
  /** Whether each one goes on that day's list or is due by it. */
  on?: 'planned' | 'due' | null;
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** Which date field a rule's tasks use: scheduled chores land on a day, "after" ones are due by it. */
export function repeatOn(r: Pick<Repeat, 'mode' | 'on'>): 'planned' | 'due' {
  return r.on ?? (r.mode === 'after' ? 'due' : 'planned');
}

// 2024-01-01 was a Monday, which lines ISO weekdays up with real dates for naming them.
const mondayUtc = Date.UTC(2024, 0, 1, 12);

export function weekdayName(day: number, style: 'long' | 'short' = 'long', locale?: string) {
  return new Date(mondayUtc + (day - 1) * 86_400_000).toLocaleDateString(locale, { weekday: style, timeZone: 'UTC' });
}

export function monthName(month: number, style: 'long' | 'short' = 'short', locale?: string) {
  return new Date(Date.UTC(2024, month - 1, 15)).toLocaleDateString(locale, { month: style, timeZone: 'UTC' });
}

export function ordinal(n: number) {
  if (n === -1) return 'last';
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

function joinWords(words: string[]) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** "Apr to Oct" for a run of months (wrapping past December), otherwise a list. */
export function describeMonths(months: number[], locale?: string) {
  const set = [...new Set(months)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
  if (set.length === 0 || set.length === 12) return '';
  // Find a start month such that the run is contiguous, wrapping around the year.
  for (const start of set) {
    const run = Array.from({ length: set.length }, (_, i) => ((start - 1 + i) % 12) + 1);
    if (run.every((m) => set.includes(m))) {
      return set.length === 1 ? `${monthName(start, 'short', locale)} only` : `${monthName(start, 'short', locale)} to ${monthName(run.at(-1)!, 'short', locale)}`;
    }
  }
  return joinWords(set.map((m) => monthName(m, 'short', locale)));
}

/**
 * Plain words for a rule: "Every Sunday", "Weekdays", "Monthly on the 2nd Thursday",
 * "3 months after it's done". `first` fills in days the rule leaves to its first date.
 */
export function describeRepeat(r: Repeat, first?: string | null, locale?: string): string {
  const every = Math.max(1, Math.round(r.every || 1));
  const unitWord = (u: RepeatUnit) => (every === 1 ? u : `${every} ${u}s`);
  const firstDate = first ? new Date(`${first}T12:00:00Z`) : null;
  let text: string;
  if (r.mode === 'after') {
    text = `${every === 1 ? `A ${r.unit}` : `${every} ${r.unit}s`} after it's done`;
  } else if (r.unit === 'day') {
    text = every === 1 ? 'Every day' : `Every ${every} days`;
  } else if (r.unit === 'week') {
    const firstDow = firstDate ? ((firstDate.getUTCDay() + 6) % 7) + 1 : null;
    const days = [...new Set(r.weekdays?.length ? r.weekdays : firstDow ? [firstDow] : [])].sort((a, b) => a - b);
    const key = days.join(',');
    if (every === 1 && key === '1,2,3,4,5') text = 'Weekdays';
    else if (every === 1 && key === '6,7') text = 'Weekends';
    else if (days.length === 7) text = every === 1 ? 'Every day' : `Every ${every} weeks, every day`;
    else {
      const names = joinWords(days.map((d) => weekdayName(d, days.length > 2 ? 'short' : 'long', locale)));
      text = every === 1 ? (names ? `Every ${names}` : 'Weekly') : `Every ${every} weeks${names ? ` on ${names}` : ''}`;
    }
  } else if (r.unit === 'month') {
    const lead = every === 1 ? 'Monthly' : `Every ${unitWord('month')}`;
    if (r.nth && r.weekday) text = `${lead} on the ${ordinal(r.nth)} ${weekdayName(r.weekday, 'long', locale)}`;
    else {
      const day = r.day ?? firstDate?.getUTCDate();
      text = day == null ? lead : day === -1 ? `${lead} on the last day` : `${lead} on the ${ordinal(day)}`;
    }
  } else {
    const month = r.month ?? (firstDate ? firstDate.getUTCMonth() + 1 : null);
    const day = r.day ?? firstDate?.getUTCDate();
    const when = month && day ? ` on ${monthName(month, 'short', locale)} ${day === -1 ? 'last day' : day}` : '';
    text = every === 1 ? `Every year${when}` : `Every ${every} years${when}`;
  }
  const season = r.months?.length ? describeMonths(r.months, locale) : '';
  return season ? `${text}, ${season}` : text;
}
