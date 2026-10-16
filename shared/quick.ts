// Reads what someone types into quick add for the parts Amble has fields for, with no AI: a day,
// a deadline, a time of day, a reminder, must-do, a repeat, a #group and an @person. Each part
// keeps where it was in the text, so the app takes out only the words of the parts it uses: a
// part the person overrides with a chip stays in the title as typed. Conservative on purpose: a
// word it isn't sure of ("sat", "sun") is left alone. English for now. Dates are YYYY-MM-DD.
import type { Repeat } from './repeat.ts';

export type QuickTime = 'morning' | 'afternoon' | 'evening';
export type QuickField = 'plannedDate' | 'dueDate' | 'timeOfDay' | 'remindAt' | 'mustDo' | 'repeat' | 'group' | 'person';

export interface QuickParse {
  plannedDate?: string;
  dueDate?: string;
  timeOfDay?: QuickTime;
  /** A local date and minutes after midnight. */
  remindAt?: { date: string; minutes: number };
  mustDo?: true;
  repeat?: Repeat;
  /** The word after #, for the app to match against its groups. */
  group?: string;
  /** The word after @, for the app to match against the household. */
  person?: string;
  /** Where each part was in the text, as [start, end) ranges. */
  spans: Partial<Record<QuickField, [number, number][]>>;
}

const DAY_MS = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDaysIso = (date: string, n: number) => iso(new Date(toDate(date).getTime() + n * DAY_MS));
/** Whether it's a day that exists (no November 31st). */
const real = (date: string) => {
  const t = toDate(date);
  return !Number.isNaN(t.getTime()) && iso(t) === date;
};
/** ISO weekday, 1 (Monday) to 7 (Sunday). */
const weekdayOf = (date: string) => ((toDate(date).getUTCDay() + 6) % 7) + 1;

const WEEKDAYS: [RegExp, number][] = [
  [/^mon(day)?$/, 1],
  [/^tue(s|sday)?$/, 2],
  [/^wed(s|nesday)?$/, 3],
  [/^thu(r|rs|rsday)?$/, 4],
  [/^fri(day)?$/, 5],
  // "sat" and "sun" are words too, so only the whole names.
  [/^saturday$/, 6],
  [/^sunday$/, 7],
];
const DAY_WORD = 'mon(?:day)?|tues?(?:day)?|weds?(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|saturday|sunday';
const weekdayNumber = (word: string) => WEEKDAYS.find(([re]) => re.test(word.toLowerCase()))?.[1];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const monthNumber = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
const amount = (word: string) => NUMBER_WORDS[word.toLowerCase()] ?? Number(word);

/** The next `weekday` from today, today included; with `next`, that weekday in the week after this one. */
function onWeekday(today: string, weekday: number, next: boolean) {
  const now = weekdayOf(today);
  if (!next) return addDaysIso(today, (weekday - now + 7) % 7);
  return addDaysIso(today, 7 - now + weekday);
}

/** A month and day this year, or next year once it's gone by. */
function onMonthDay(today: string, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const d = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!real(d)) return undefined; // February 30th and the like.
    if (d >= today) return d;
  }
  return undefined;
}

interface Found {
  date: string;
  start: number;
  end: number;
  evening?: boolean;
}

/** Every day the text names, with where. */
function findDates(text: string, today: string): Found[] {
  const found: Found[] = [];
  const add = (m: RegExpExecArray, date: string | undefined, extra: Partial<Found> = {}) => {
    if (date) found.push({ date, start: m.index, end: m.index + m[0].length, ...extra });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of text.matchAll(re)) fn(m as RegExpExecArray);
  };
  each(/\b(?:on |for )?today\b/gi, (m) => add(m, today));
  each(/\btonight\b/gi, (m) => add(m, today, { evening: true }));
  each(/\b(?:on |for )?(?:the )?day after tomorrow\b/gi, (m) => add(m, addDaysIso(today, 2)));
  each(/\b(?:on |for )?(?:tomorrow|tmrw|tmr)\b(?! after)/gi, (m) => add(m, addDaysIso(today, 1)));
  each(/\b(?:this |on the )?weekend\b/gi, (m) => add(m, onWeekday(today, 6, false)));
  each(/\bnext weekend\b/gi, (m) => add(m, onWeekday(today, 6, true)));
  each(/\bnext week\b/gi, (m) => add(m, onWeekday(today, 1, true)));
  each(new RegExp(`\\b(?:(on|this|next) )?(${DAY_WORD})\\b`, 'gi'), (m) => {
    const day = weekdayNumber(m[2]!);
    if (day) add(m, onWeekday(today, day, m[1]?.toLowerCase() === 'next'));
  });
  each(/\bin (\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few) (days?|weeks?)\b/gi, (m) => {
    const n = amount(m[1]!.replace(/^a (couple|few) of$/i, '$1'));
    if (Number.isFinite(n) && n > 0) add(m, addDaysIso(today, n * (m[2]!.toLowerCase().startsWith('week') ? 7 : 1)));
  });
  each(new RegExp(`\\b(?:on )?(${MONTH_WORD})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'), (m) => add(m, onMonthDay(today, monthNumber(m[1]!), Number(m[2]))));
  each(new RegExp(`\\b(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTH_WORD})\\b`, 'gi'), (m) => add(m, onMonthDay(today, monthNumber(m[2]!), Number(m[1]))));
  each(/\b(?:on )?(\d{1,2})\/(\d{1,2})\b(?!\/)/g, (m) => add(m, onMonthDay(today, Number(m[1]), Number(m[2]))));
  each(/\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b(?! of)/gi, (m) => {
    // This month's, or next month's once it's gone by.
    const day = String(Number(m[1])).padStart(2, '0');
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const here = `${today.slice(0, 7)}-${day}`;
    const next = month === 12 ? `${year + 1}-01-${day}` : `${year}-${String(month + 1).padStart(2, '0')}-${day}`;
    add(m, [here, next].find((d) => real(d) && d >= today));
  });
  // Overlaps ("on Oct 20" inside a longer match): keep the longest.
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  return found.filter((f, i) => !found.some((g, j) => j !== i && g.start <= f.start && g.end >= f.end && g.end - g.start > f.end - f.start));
}

interface FoundTime {
  minutes: number;
  start: number;
  end: number;
}

/** Clock times: "at 3", "3pm", "at 15:30", "noon". Without am or pm, 1 to 6 is afternoon and 7 to 11 morning. */
function findTimes(text: string): FoundTime[] {
  const found: FoundTime[] = [];
  for (const m of text.matchAll(/\b(?:at |@ ?)?(noon|midday|midnight)\b/gi)) {
    found.push({ minutes: m[1]!.toLowerCase() === 'midnight' ? 0 : 12 * 60, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(/\b(at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\W|$)/gi)) {
    const [, at, h, mm, ap] = m;
    // A bare number is only a time after "at", or with am/pm.
    if (!at && !ap && !mm) continue;
    let hour = Number(h);
    const minute = mm ? Number(mm) : 0;
    if (hour > 23 || minute > 59) continue;
    const pm = ap?.toLowerCase().startsWith('p');
    if (ap) hour = (hour % 12) + (pm ? 12 : 0);
    else if (!mm && hour >= 1 && hour <= 6) hour += 12;
    else if (mm && hour >= 1 && hour <= 6) hour += 12;
    found.push({ minutes: hour * 60 + minute, start: m.index!, end: m.index! + m[0].length });
  }
  return found;
}

const bucket = (minutes: number): QuickTime => (minutes < 12 * 60 ? 'morning' : minutes < 17 * 60 ? 'afternoon' : 'evening');

/** `today` is the person's planning day (it turns over at 4am); `now` the clock, for reminders. */
export function parseQuick(text: string, today: string, now = new Date()): QuickParse {
  const out: QuickParse = { spans: {} };
  const span = (field: QuickField, start: number, end: number) => (out.spans[field] ??= []).push([start, end]);

  // Must do.
  for (const m of text.matchAll(/\b(must[- ]do|urgent|asap)\b|!+(?=\s*$)/gi)) {
    out.mustDo = true;
    span('mustDo', m.index!, m.index! + m[0].length);
  }
  // A #group and an @person.
  const tag = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/u.exec(text);
  if (tag) {
    out.group = tag[1];
    span('group', tag.index + tag[0].indexOf('#'), tag.index + tag[0].length);
  }
  const at = /(?:^|\s)@([\p{L}][\p{L}\p{N}_-]*)/u.exec(text);
  if (at) {
    out.person = at[1];
    span('person', at.index + at[0].indexOf('@'), at.index + at[0].length);
  }

  // Repeats. Whatever a repeat names isn't also a day.
  let repeatSpan: [number, number] | null = null;
  const every = new RegExp(
    `\\b(?:every (other )?(day|week|month|year|weekday|weekend|(?:(?:${DAY_WORD})s?(?:,? (?:and )?)?)+)|(daily|weekly|monthly|yearly|annually))\\b`,
    'i',
  ).exec(text);
  if (every) {
    const [, other, what, adverb] = every;
    const n = other ? 2 : 1;
    const word = (adverb ?? what ?? '').toLowerCase();
    let repeat: Repeat | undefined;
    if (word === 'day' || word === 'daily') repeat = { mode: 'schedule', every: n, unit: 'day' };
    else if (word === 'week' || word === 'weekly') repeat = { mode: 'schedule', every: n, unit: 'week' };
    else if (word === 'month' || word === 'monthly') repeat = { mode: 'schedule', every: n, unit: 'month' };
    else if (word === 'year' || word === 'yearly' || word === 'annually') repeat = { mode: 'schedule', every: n, unit: 'year' };
    else if (word === 'weekday') repeat = { mode: 'schedule', every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] };
    else if (word === 'weekend') repeat = { mode: 'schedule', every: 1, unit: 'week', weekdays: [6, 7] };
    else {
      const days = [...word.matchAll(new RegExp(`(${DAY_WORD})s?`, 'gi'))].map((d) => weekdayNumber(d[1]!)).filter((d): d is number => !!d);
      if (days.length) repeat = { mode: 'schedule', every: n, unit: 'week', weekdays: [...new Set(days)].sort() };
    }
    if (repeat) {
      out.repeat = repeat;
      repeatSpan = [every.index, every.index + every[0].replace(/[,\s]+(?:and)?\s*$/i, '').length];
      span('repeat', ...repeatSpan);
      // A weekly repeat starts on its first day.
      if (repeat.weekdays?.length && !out.plannedDate) out.plannedDate = onWeekday(today, repeat.weekdays.find((d) => d >= weekdayOf(today)) ?? repeat.weekdays[0]!, false);
    }
  }

  // Where the reminder is said: "remind me to X at 5" (all of it is the reminder, and the task goes
  // on that day), or "X Friday, remind me Thursday at 6" (only what follows is).
  const remind = /(?:,\s*)?\bremind me\b(?: to\b)?/i.exec(text);
  const leading = remind != null && text.slice(0, remind.index).trim() === '';
  const inReminder = (start: number) => remind != null && (leading || start >= remind.index);
  const inTask = (start: number) => !remind || leading || start < remind.index;

  const outside = (s: number, e: number) => !repeatSpan || e <= repeatSpan[0] || s >= repeatSpan[1];
  const dates = findDates(text, today).filter((d) => outside(d.start, d.end));
  const times = findTimes(text).filter((t) => outside(t.start, t.end));

  // Deadlines: "by Friday", "due Friday", "before the 20th".
  for (const d of dates) {
    const lead = /\b(by|due|before)\s+$/i.exec(text.slice(Math.max(0, d.start - 8), d.start));
    if (lead && inTask(d.start) && !out.dueDate) {
      out.dueDate = d.date;
      span('dueDate', d.start - lead[0].length, d.end);
    }
  }
  const free = dates.filter((d) => !(out.spans.dueDate ?? []).some(([s, e]) => d.start >= s && d.end <= e));

  // The reminder: the day and time said with it.
  if (remind) {
    span('remindAt', remind.index, remind.index + remind[0].length);
    const day = free.find((d) => inReminder(d.start));
    const time = times.find((t) => inReminder(t.start));
    if (day || time) {
      if (day) span('remindAt', day.start, day.end);
      if (time) span('remindAt', time.start, time.end);
      out.remindAt = { date: day?.date ?? '', minutes: time?.minutes ?? (day?.evening ? 18 * 60 : 9 * 60) };
      if (leading && day) out.plannedDate = day.date;
      if (day?.evening) out.timeOfDay = 'evening';
    }
  }

  // The day it goes on: the first other day named.
  const planned = leading ? undefined : free.find((d) => inTask(d.start));
  if (planned) {
    out.plannedDate = planned.date;
    span('plannedDate', planned.start, planned.end);
    if (planned.evening) out.timeOfDay = 'evening';
  }
  if (out.remindAt && !out.remindAt.date) {
    // A time alone: on the task's day, or today if that's still to come, else tomorrow.
    const later = out.remindAt.minutes > now.getHours() * 60 + now.getMinutes();
    out.remindAt.date = out.plannedDate ?? (later ? today : addDaysIso(today, 1));
  }
  if (out.remindAt) {
    // A reminder can't be in the past. Gone by today, it's tomorrow's; a day that's over (Thursday,
    // said after midnight), the next one.
    const { date, minutes } = out.remindAt;
    const [y, m, d] = date.split('-').map(Number);
    if (new Date(y!, m! - 1, d!, Math.floor(minutes / 60), minutes % 60) <= now) {
      const clockToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const moved = addDaysIso(date, date < clockToday ? 7 : 1);
      if (out.plannedDate === date) out.plannedDate = moved;
      out.remindAt.date = moved;
    }
  }
  if (out.remindAt && !out.plannedDate) out.plannedDate = out.remindAt.date;

  // The time of day: a word for it, or a clock time (which stays in the title, since tasks have no
  // exact times), or the reminder's, when it's on the task's own day.
  const part = /\b(?:in the |this )?(morning|afternoon|evening)\b/i.exec(text);
  if (part && inTask(part.index)) {
    out.timeOfDay = part[1]!.toLowerCase() as QuickTime;
    span('timeOfDay', part.index, part.index + part[0].length);
  } else if (!out.timeOfDay) {
    const time = leading ? undefined : times.find((t) => inTask(t.start));
    if (time) out.timeOfDay = bucket(time.minutes);
    else if (out.remindAt && out.remindAt.date === out.plannedDate) out.timeOfDay = bucket(out.remindAt.minutes);
  }
  return out;
}

/** The title once the words of the parts in `used` are taken out, and loose joining words tidied away. */
export function quickTitle(text: string, parse: QuickParse, used: Iterable<QuickField>): string {
  const cuts = [...used].flatMap((f) => parse.spans[f] ?? []).sort((a, b) => a[0] - b[0]);
  let title = '';
  let at = 0;
  for (const [s, e] of cuts) {
    if (s < at) {
      at = Math.max(at, e);
      continue;
    }
    title += `${text.slice(at, s)} `;
    at = e;
  }
  title += text.slice(at);
  return title
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .replace(/(?:^|\s)(?:on|at|by|for|to|and|in|the)$/i, '')
    .replace(/^(?:and|to)\s+/i, '')
    .replace(/[\s,;:-]+$/g, '')
    .trim();
}
