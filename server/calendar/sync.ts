// Keeps a copy of each person's Google Calendar events: a full read of a window around today
// (twelve weeks back, for learning, and six months ahead), then changes only, using Google's sync
// tokens. Once a day the full read runs again so the window moves along with the calendar.
import { and, eq, inArray, lt, or, isNull } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { calendarAccounts, calendarEvents, calendarSources, members, type CalendarAccount, type CalendarSource, type Member } from '../db/schema.ts';
import { CALENDAR_SCOPE, type Finished } from '../auth/oidc.ts';
import { DomainError } from '../domain/household.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import { GoogleAuthError, openToken, sealToken, SyncTokenGone, type GoogleApi, type GoogleCalendar, type GoogleEvent } from './google.ts';

export const PAST_DAYS = 84;
export const FUTURE_DAYS = 180;
const FULL_READ_EVERY_MS = 20 * 60 * 60 * 1000;
export const SYNC_EVERY_MS = 10 * 60 * 1000;
const INSERT_CHUNK = 500;

type Connected = Extract<Finished, { kind: 'calendar' }>;
type EventRow = typeof calendarEvents.$inferInsert;

/** Why connecting didn't work, worded for the Calendars page. */
export class ConnectError extends Error {}

/** Midnight at the start of a date in a timezone, as epoch milliseconds. */
export function startOfDate(date: string, timeZone: string) {
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone }).epochMilliseconds;
}

/** Calendars Almanac counts unless someone says otherwise: their own and ones they help keep, not subscriptions. */
function countsByDefault(c: GoogleCalendar) {
  if (c.primary) return true;
  if (c.id.endsWith('.calendar.google.com') && /#(holiday|contacts|weeknum)@/.test(c.id)) return false;
  return (c.accessRole === 'owner' || c.accessRole === 'writer') && c.selected !== false;
}

/** An event as Almanac keeps it, or null when it shouldn't show or count (cancelled, declined, a working-location marker). */
export function toRow(e: GoogleEvent, source: Pick<CalendarSource, 'id' | 'memberId'>, timeZone: string): EventRow | null {
  if (e.status === 'cancelled' || !e.start || !e.end) return null;
  if (e.eventType === 'workingLocation') return null;
  if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = !!e.start.date;
  let startAt: number;
  let endAt: number;
  try {
    if (allDay) {
      startAt = startOfDate(e.start.date!, timeZone);
      endAt = startOfDate(e.end.date ?? addDays(e.start.date!, 1), timeZone);
    } else {
      startAt = Date.parse(e.start.dateTime ?? '');
      endAt = Date.parse(e.end.dateTime ?? '');
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return null;
  return {
    sourceId: source.id,
    memberId: source.memberId,
    eventId: e.id,
    uid: e.iCalUID ?? null,
    title: e.summary?.trim().slice(0, 300) || null,
    allDay,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    startDate: allDay ? e.start.date! : null,
    endDate: allDay ? (e.end.date ?? addDays(e.start.date!, 1)) : null,
    busy: e.transparency !== 'transparent',
    url: e.htmlLink ?? null,
  };
}

/** Turns Google's error text into something the Calendars page can show. */
function friendly(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(text)) {
    return "The Google Calendar API isn't turned on in this server's Google Cloud project yet.";
  }
  if (/timeout|aborted|fetch failed|ENOTFOUND|ECONNRESET/i.test(text)) return "Couldn't reach Google. Almanac will try again.";
  return "Google Calendar didn't answer as expected. Almanac will try again.";
}

export function createCalendarSync({ db, config, google }: { db: Db; config: Config; google: GoogleApi }) {
  const secret = config.calendar.clientSecret;
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const running = new Map<string, Promise<void>>();

  const memberOf = (id: string) => db.select().from(members).where(eq(members.id, id)).get();
  const sourcesOf = (accountId: string) => db.select().from(calendarSources).where(eq(calendarSources.accountId, accountId)).all();

  function needsReconnect(account: CalendarAccount, message: string) {
    tokens.delete(account.id);
    db.update(calendarAccounts).set({ status: 'reconnect', error: message }).where(eq(calendarAccounts.id, account.id)).run();
  }

  async function accessToken(account: CalendarAccount, fresh = false) {
    const cached = tokens.get(account.id);
    if (!fresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const refresh = openToken(secret, account.refreshToken);
    if (!refresh) throw new GoogleAuthError("This server's Google client changed, so the calendar has to be connected again.");
    const { accessToken: token, expiresAt } = await google.refresh(refresh);
    tokens.set(account.id, { token, expiresAt });
    return token;
  }

  /** Runs a call with the account's access token, getting a new one once if Google says it lapsed. */
  async function withToken<T>(account: CalendarAccount, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await accessToken(account));
    } catch (err) {
      if (!(err instanceof GoogleAuthError) || !tokens.has(account.id)) throw err;
      return fn(await accessToken(account, true));
    }
  }

  function refreshList(account: CalendarAccount, list: GoogleCalendar[]) {
    const readable = list.filter((c) => c.accessRole !== 'freeBusyReader');
    const existing = sourcesOf(account.id);
    db.transaction(() => {
      for (const c of readable) {
        const fields = { name: (c.summaryOverride ?? c.summary ?? c.id).slice(0, 200), color: c.backgroundColor ?? null, primary: !!c.primary };
        const known = existing.find((s) => s.calendarId === c.id);
        if (known) db.update(calendarSources).set(fields).where(eq(calendarSources.id, known.id)).run();
        else db.insert(calendarSources).values({ accountId: account.id, memberId: account.memberId, calendarId: c.id, counts: countsByDefault(c), ...fields }).run();
      }
      const gone = existing.filter((s) => !readable.some((c) => c.id === s.calendarId)).map((s) => s.id);
      if (gone.length) db.delete(calendarSources).where(inArray(calendarSources.id, gone)).run();
    });
  }

  function window(member: Member) {
    const today = planningDate(member);
    return { from: startOfDate(addDays(today, -PAST_DAYS), member.timezone), to: startOfDate(addDays(today, FUTURE_DAYS), member.timezone) };
  }

  async function fullRead(account: CalendarAccount, source: CalendarSource, member: Member) {
    const { from, to } = window(member);
    const rows: EventRow[] = [];
    let pageToken: string | undefined;
    let syncToken: string | undefined;
    do {
      const page = await withToken(account, (t) =>
        google.events(t, source.calendarId, {
          singleEvents: 'true',
          maxResults: '2500',
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          ...(pageToken && { pageToken }),
        }),
      );
      for (const e of page.items ?? []) {
        const row = toRow(e, source, member.timezone);
        if (row) rows.push(row);
      }
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken;
    } while (pageToken);
    db.transaction(() => {
      db.delete(calendarEvents).where(eq(calendarEvents.sourceId, source.id)).run();
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) db.insert(calendarEvents).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoNothing().run();
      db.update(calendarSources)
        .set({ syncToken: syncToken ?? null, fullSyncAt: new Date() })
        .where(eq(calendarSources.id, source.id))
        .run();
    });
  }

  async function changesSince(account: CalendarAccount, source: CalendarSource, member: Member) {
    const { from, to } = window(member);
    const changed: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let syncToken: string | undefined;
    do {
      const page = await withToken(account, (t) =>
        google.events(t, source.calendarId, {
          singleEvents: 'true',
          maxResults: '2500',
          syncToken: source.syncToken!,
          ...(pageToken && { pageToken }),
        }),
      );
      changed.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken;
    } while (pageToken);
    db.transaction(() => {
      for (const e of changed) {
        const row = toRow(e, source, member.timezone);
        // Changes come back from any date; only the window is kept.
        if (!row || row.endAt.getTime() < from || row.startAt.getTime() > to) {
          db.delete(calendarEvents)
            .where(and(eq(calendarEvents.sourceId, source.id), eq(calendarEvents.eventId, e.id)))
            .run();
        } else {
          const { sourceId: _s, eventId: _e, memberId: _m, ...fields } = row;
          db.insert(calendarEvents)
            .values(row)
            .onConflictDoUpdate({ target: [calendarEvents.sourceId, calendarEvents.eventId], set: fields })
            .run();
        }
      }
      if (syncToken) db.update(calendarSources).set({ syncToken }).where(eq(calendarSources.id, source.id)).run();
    });
  }

  async function syncSource(account: CalendarAccount, source: CalendarSource, member: Member, full: boolean) {
    const stale = !source.fullSyncAt || Date.now() - source.fullSyncAt.getTime() > FULL_READ_EVERY_MS;
    if (full || stale || !source.syncToken) return fullRead(account, source, member);
    try {
      await changesSince(account, source, member);
    } catch (err) {
      if (!(err instanceof SyncTokenGone)) throw err;
      await fullRead(account, source, member);
    }
  }

  async function run(accountId: string, full: boolean) {
    const account = db.select().from(calendarAccounts).where(eq(calendarAccounts.id, accountId)).get();
    if (!account || account.status !== 'ok') return;
    const member = memberOf(account.memberId);
    if (!member) return;
    try {
      const sources = sourcesOf(account.id);
      const listDue = full || sources.length === 0 || sources.some((s) => s.counts && (!s.fullSyncAt || Date.now() - s.fullSyncAt.getTime() > FULL_READ_EVERY_MS));
      if (listDue) refreshList(account, await withToken(account, (t) => google.calendars(t)));
      for (const source of sourcesOf(account.id).filter((s) => s.counts)) await syncSource(account, source, member, full);
      db.update(calendarAccounts).set({ syncedAt: new Date(), error: null }).where(eq(calendarAccounts.id, account.id)).run();
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        needsReconnect(account, err.message);
        return;
      }
      console.warn(`Calendar sync for ${account.email} failed:`, err instanceof Error ? err.message : err);
      // Still counts as a try, so the scheduler waits its turn before the next one.
      db.update(calendarAccounts).set({ syncedAt: new Date(), error: friendly(err) }).where(eq(calendarAccounts.id, account.id)).run();
    }
  }

  /** One sync at a time per account; a second ask while one runs waits for it. */
  function syncAccount(accountId: string, { full = false } = {}) {
    const busy = running.get(accountId);
    if (busy) return busy;
    const job = run(accountId, full).finally(() => running.delete(accountId));
    running.set(accountId, job);
    return job;
  }

  function ownSource(member: Member, sourceId: string) {
    const source = db
      .select()
      .from(calendarSources)
      .where(and(eq(calendarSources.id, sourceId), eq(calendarSources.memberId, member.id)))
      .get();
    if (!source) throw new DomainError('No such calendar.');
    return source;
  }

  return {
    enabled: Boolean(config.calendar.clientId && config.calendar.clientSecret),

    /** Saves a newly connected Google account and reads its calendar list; events follow in the background. */
    async connect(result: Connected) {
      if (!result.scope.split(/\s+/).includes(CALENDAR_SCOPE)) {
        throw new ConnectError('Google didn\'t share your calendars. Try again and leave "See your calendars" ticked.');
      }
      if (!result.refreshToken) throw new ConnectError("Google didn't give Almanac lasting access. Try connecting again.");
      const values = {
        memberId: result.memberId,
        subject: result.subject,
        email: result.email,
        refreshToken: sealToken(secret, result.refreshToken),
        scope: result.scope,
        status: 'ok' as const,
        error: null,
      };
      const account = db
        .insert(calendarAccounts)
        .values(values)
        .onConflictDoUpdate({ target: [calendarAccounts.memberId, calendarAccounts.subject], set: values })
        .returning()
        .get();
      tokens.set(account.id, { token: result.accessToken, expiresAt: Date.now() + (result.expiresIn ?? 3600) * 1000 });
      try {
        refreshList(account, await google.calendars(result.accessToken));
      } catch (err) {
        console.warn('Reading the calendar list failed:', err instanceof Error ? err.message : err);
        db.update(calendarAccounts).set({ error: friendly(err) }).where(eq(calendarAccounts.id, account.id)).run();
      }
      void syncAccount(account.id, { full: true });
      return account;
    },

    syncAccount,

    /** Syncs this person's calendars if they haven't been for a while; for when the app opens. */
    async syncMember(member: Member, maxAgeMs: number) {
      const cutoff = new Date(Date.now() - maxAgeMs);
      const due = db
        .select()
        .from(calendarAccounts)
        .where(and(eq(calendarAccounts.memberId, member.id), eq(calendarAccounts.status, 'ok'), or(isNull(calendarAccounts.syncedAt), lt(calendarAccounts.syncedAt, cutoff))))
        .all();
      for (const a of due) await syncAccount(a.id);
      return due.length;
    },

    /** Every account whose last sync is older than the interval; the scheduler calls this. */
    async syncDue() {
      const cutoff = new Date(Date.now() - SYNC_EVERY_MS);
      const due = db
        .select({ id: calendarAccounts.id })
        .from(calendarAccounts)
        .where(and(eq(calendarAccounts.status, 'ok'), or(isNull(calendarAccounts.syncedAt), lt(calendarAccounts.syncedAt, cutoff))))
        .all();
      for (const a of due) await syncAccount(a.id);
    },

    /** Whether a calendar counts. Turning one off drops its events; turning one on reads it in full. */
    async setCounts(member: Member, sourceId: string, counts: boolean) {
      const source = ownSource(member, sourceId);
      db.update(calendarSources)
        .set(counts ? { counts } : { counts, syncToken: null, fullSyncAt: null })
        .where(eq(calendarSources.id, source.id))
        .run();
      if (!counts) {
        db.delete(calendarEvents).where(eq(calendarEvents.sourceId, source.id)).run();
        return;
      }
      await syncAccount(source.accountId);
    },

    /** Forgets an account and its events, and tells Google to drop Almanac's access. */
    async disconnect(member: Member, accountId: string) {
      const account = db
        .select()
        .from(calendarAccounts)
        .where(and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.memberId, member.id)))
        .get();
      if (!account) throw new DomainError('No such calendar account.');
      const refresh = openToken(secret, account.refreshToken);
      tokens.delete(account.id);
      db.delete(calendarAccounts).where(eq(calendarAccounts.id, account.id)).run();
      if (refresh) await google.revoke(refresh);
    },

    /** The Calendars page: each connected account and its calendars. */
    accounts(member: Member) {
      const accounts = db.select().from(calendarAccounts).where(eq(calendarAccounts.memberId, member.id)).all();
      const sources = db.select().from(calendarSources).where(eq(calendarSources.memberId, member.id)).all();
      return accounts.map((a) => ({
        id: a.id,
        email: a.email,
        status: a.status,
        error: a.error,
        syncedAt: a.syncedAt,
        calendars: sources
          .filter((s) => s.accountId === a.id)
          .sort((x, y) => Number(y.primary) - Number(x.primary) || x.name.localeCompare(y.name))
          .map((s) => ({ id: s.id, name: s.name, color: s.color, primary: s.primary, counts: s.counts })),
      }));
    },
  };
}

export type CalendarSync = ReturnType<typeof createCalendarSync>;
