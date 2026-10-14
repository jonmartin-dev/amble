// Calendar dates are plain YYYY-MM-DD strings in the member's timezone.

export interface Clock {
  timezone: string;
  dayCutoffHour: number;
}

/** The member's planning day: before the cutoff hour (4am by default) it's still yesterday. */
export function planningDate(clock: Clock, now: Temporal.Instant = Temporal.Now.instant()): string {
  const local = now.toZonedDateTimeISO(clock.timezone);
  const day = local.hour < clock.dayCutoffHour ? local.subtract({ days: 1 }) : local;
  return day.toPlainDate().toString();
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function daysBetween(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'days' }).days;
}

export function weekday(date: string): string {
  return Temporal.PlainDate.from(date).toLocaleString('en-US', { weekday: 'short' });
}

export function isWeekend(date: string): boolean {
  return Temporal.PlainDate.from(date).dayOfWeek >= 6;
}

/** Every date from start to end, inclusive. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** When a planning day begins: its date at the cutoff hour, in the member's timezone. */
export function planningDayStart(clock: Clock, date: string): Date {
  const start = Temporal.PlainDate.from(date).toZonedDateTime({
    timeZone: clock.timezone,
    plainTime: { hour: clock.dayCutoffHour },
  });
  return new Date(start.epochMilliseconds);
}

/** The planning date a moment fell on, for completion timestamps. */
export function dateOf(clock: Clock, at: Date): string {
  return planningDate(clock, Temporal.Instant.fromEpochMilliseconds(at.getTime()));
}
