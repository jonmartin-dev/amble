import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_SCOPE } from '../auth/oidc.ts';
import { config, type Config } from '../config.ts';
import { openDatabase, type Db } from '../db/index.ts';
import { activity, calendarAccounts, calendarEvents, calendarSources, members, tasks, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { busyByDay, listEvents, usualBusy } from '../domain/events.ts';
import { getLoad, learnedCapacity, roomAfterEvents } from '../domain/load.ts';
import { addDays, planningDate } from '../lib/dates.ts';
import { GoogleAuthError, openToken, SyncTokenGone, type GoogleApi, type GoogleCalendar, type GoogleEvent } from './google.ts';
import { createCalendarSync, type CalendarSync } from './sync.ts';

const TZ = 'America/Chicago';
const testConfig: Config = { ...config, calendar: { clientId: 'calendar-client', clientSecret: 'calendar-secret' } };

/** A local time on a date in Chicago, as Google writes it. */
const at = (date: string, time: string) => Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(TZ).toString({ timeZoneName: 'never' });

function timed(id: string, date: string, from: string, to: string, extra: Partial<GoogleEvent> = {}): GoogleEvent {
  return { id, summary: id, iCalUID: `${id}@google.com`, start: { dateTime: at(date, from) }, end: { dateTime: at(date, to) }, ...extra };
}

/** Google, kept in memory: calendars, events with a change log for sync tokens, and a switch to revoke access. */
class FakeGoogle implements GoogleApi {
  calendarList: GoogleCalendar[] = [];
  store = new Map<string, Map<string, GoogleEvent>>();
  log: { calendarId: string; event: GoogleEvent; seq: number }[] = [];
  seq = 0;
  revoked = false;
  revokedTokens: string[] = [];
  expiredTokens = new Set<string>();
  calls: { calendarId: string; params: Record<string, string> }[] = [];
  pageSize = 1000;

  put(calendarId: string, event: GoogleEvent) {
    if (!this.store.has(calendarId)) this.store.set(calendarId, new Map());
    this.store.get(calendarId)!.set(event.id, event);
    this.log.push({ calendarId, event, seq: ++this.seq });
  }

  remove(calendarId: string, id: string) {
    this.store.get(calendarId)?.delete(id);
    this.log.push({ calendarId, event: { id, status: 'cancelled' }, seq: ++this.seq });
  }

  async refresh() {
    if (this.revoked) throw new GoogleAuthError('revoked');
    return { accessToken: 'access', expiresAt: Date.now() + 3600_000 };
  }

  async calendars() {
    return this.calendarList;
  }

  async events(_token: string, calendarId: string, params: Record<string, string>) {
    this.calls.push({ calendarId, params });
    if (params.syncToken) {
      if (this.expiredTokens.has(params.syncToken)) throw new SyncTokenGone('gone');
      const since = Number(params.syncToken.split(':')[1]);
      const items = this.log.filter((l) => l.calendarId === calendarId && l.seq > since).map((l) => l.event);
      return { items, nextSyncToken: `${calendarId}:${this.seq}` };
    }
    const min = Date.parse(params.timeMin!);
    const max = Date.parse(params.timeMax!);
    const all = [...(this.store.get(calendarId)?.values() ?? [])].filter((e) => {
      const s = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);
      const end = Date.parse(e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`);
      return end > min && s < max;
    });
    const offset = Number(params.pageToken ?? 0);
    const items = all.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < all.length;
    return more ? { items, nextPageToken: String(offset + this.pageSize) } : { items, nextSyncToken: `${calendarId}:${this.seq}` };
  }

  async revoke(token: string) {
    this.revokedTokens.push(token);
  }
}

let db: Db;
let jon: Member;
let google: FakeGoogle;
let sync: CalendarSync;
let today: string;

async function connect(member = jon) {
  await sync.connect({
    kind: 'calendar',
    memberId: member.id,
    returnTo: '/settings/calendars',
    subject: `google-${member.id}`,
    email: member.email,
    refreshToken: 'refresh-token',
    accessToken: 'access',
    expiresIn: 3600,
    scope: `openid ${CALENDAR_SCOPE} email`,
  });
  const account = db.select().from(calendarAccounts).where(eq(calendarAccounts.memberId, member.id)).get()!;
  await sync.syncAccount(account.id);
  return account;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: TZ, role: 'admin' }).returning().get();
  google = new FakeGoogle();
  google.calendarList = [
    { id: 'jon@example.com', summary: 'Jon', primary: true, accessRole: 'owner', backgroundColor: '#33aa66' },
    { id: 'family', summary: 'Family', accessRole: 'writer' },
    { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays', accessRole: 'reader' },
    { id: 'team', summary: "Sam's work", accessRole: 'reader' },
    { id: 'busy-only', summary: 'Free/busy', accessRole: 'freeBusyReader' },
  ];
  sync = createCalendarSync({ db, config: testConfig, google });
  today = planningDate(jon);
});

describe('connecting and syncing a Google Calendar', () => {
  it('keeps the refresh token sealed, lists calendars and counts your own and shared ones by default', async () => {
    const account = await connect();
    expect(account.refreshToken).not.toContain('refresh-token');
    expect(openToken('calendar-secret', account.refreshToken)).toBe('refresh-token');
    expect(openToken('another-secret', account.refreshToken)).toBeUndefined();
    const [view] = sync.accounts(jon);
    expect(view!.calendars.map((c) => [c.name, c.counts])).toEqual([
      ['Jon', true],
      ['Family', true],
      ['Holidays', false],
      ["Sam's work", false],
    ]);
  });

  it('copies events, skipping cancelled, declined and working-location ones, and shows a shared meeting once', async () => {
    google.put('jon@example.com', timed('dentist', today, '09:00', '10:00'));
    google.put('jon@example.com', timed('declined', today, '11:00', '12:00', { attendees: [{ self: true, responseStatus: 'declined' }] }));
    google.put('jon@example.com', { id: 'office', eventType: 'workingLocation', start: { date: today }, end: { date: addDays(today, 1) } });
    google.put('jon@example.com', timed('cancelled', today, '13:00', '14:00', { status: 'cancelled' }));
    google.put('family', timed('dentist', today, '09:00', '10:00'));
    google.put('family', { id: 'birthday', summary: "Mom's birthday", start: { date: today }, end: { date: addDays(today, 1) }, transparency: 'transparent' });
    await connect();
    const events = listEvents(db, jon, today, today);
    expect(events.map((e) => [e.title, e.allDay, e.busy])).toEqual([
      ["Mom's birthday", true, false],
      ['dentist', false, true],
    ]);
    expect(events[1]!.start).toBe(new Date(at(today, '09:00')).toISOString());
  });

  it('reads every page of a big calendar', async () => {
    google.pageSize = 2;
    for (let i = 0; i < 5; i++) google.put('jon@example.com', timed(`e${i}`, addDays(today, i), '09:00', '09:30'));
    await connect();
    expect(listEvents(db, jon, today, addDays(today, 6))).toHaveLength(5);
  });

  it('then fetches only changes, and starts over when the sync token has expired', async () => {
    google.put('jon@example.com', timed('standup', today, '09:00', '09:15'));
    google.put('jon@example.com', timed('lunch', today, '12:00', '13:00'));
    const account = await connect();
    google.put('jon@example.com', timed('standup', today, '09:30', '09:45'));
    google.remove('jon@example.com', 'lunch');
    google.put('jon@example.com', timed('dinner', today, '18:00', '20:00'));
    await sync.syncAccount(account.id);
    expect(google.calls.at(-1)!.params.syncToken).toBeDefined();
    expect(listEvents(db, jon, today, today).map((e) => e.title)).toEqual(['standup', 'dinner']);
    expect(listEvents(db, jon, today, today)[0]!.start).toBe(new Date(at(today, '09:30')).toISOString());

    const source = db.select().from(calendarSources).where(eq(calendarSources.calendarId, 'jon@example.com')).get()!;
    google.expiredTokens.add(source.syncToken!);
    google.put('jon@example.com', timed('late', today, '21:00', '22:00'));
    await sync.syncAccount(account.id);
    expect(google.calls.at(-1)!.params.timeMin).toBeDefined();
    expect(listEvents(db, jon, today, today).map((e) => e.title)).toEqual(['standup', 'dinner', 'late']);
  });

  it('drops a calendar\'s events when it stops counting and reads them again when it counts', async () => {
    google.put('family', timed('soccer', today, '17:00', '18:00'));
    await connect();
    const family = sync.accounts(jon)[0]!.calendars.find((c) => c.name === 'Family')!;
    await sync.setCounts(jon, family.id, false);
    expect(listEvents(db, jon, today, today)).toEqual([]);
    expect(db.select().from(calendarEvents).all()).toEqual([]);
    await sync.setCounts(jon, family.id, true);
    expect(listEvents(db, jon, today, today).map((e) => e.title)).toEqual(['soccer']);
  });

  it('asks to reconnect when Google turns the refresh token down, and disconnecting revokes access', async () => {
    const account = await connect();
    google.revoked = true;
    await db.update(calendarAccounts).set({ syncedAt: null }).run();
    // The cached access token is still good, so make it lapse first.
    const fresh = createCalendarSync({ db, config: testConfig, google });
    await fresh.syncAccount(account.id);
    expect(fresh.accounts(jon)[0]).toMatchObject({ status: 'reconnect' });

    await fresh.disconnect(jon, account.id);
    expect(google.revokedTokens).toEqual(['refresh-token']);
    expect(db.select().from(calendarSources).all()).toEqual([]);
  });

  it("won't connect without calendar access", async () => {
    await expect(
      sync.connect({ kind: 'calendar', memberId: jon.id, returnTo: '/', subject: 's', email: 'e', refreshToken: 'r', accessToken: 'a', expiresIn: 1, scope: 'openid email' }),
    ).rejects.toThrow(/leave "See your calendars" ticked/);
  });
});

describe('busy time', () => {
  it('counts overlapping events once, within waking hours, and fills the day for an all-day busy event', async () => {
    const d = addDays(today, 1);
    google.put('jon@example.com', timed('a', d, '09:00', '10:30'));
    google.put('family', timed('b', d, '10:00', '11:00'));
    google.put('jon@example.com', timed('early', d, '05:00', '08:00'));
    google.put('jon@example.com', timed('free', d, '13:00', '15:00', { transparency: 'transparent' }));
    const trip = addDays(today, 2);
    google.put('jon@example.com', { id: 'trip', summary: 'Trip', start: { date: trip }, end: { date: addDays(trip, 2) } });
    await connect();
    const busy = busyByDay(db, jon, d, addDays(today, 4));
    // 9:00-11:00 merged is 120, plus 7:00-8:00 of the early one.
    expect(busy.get(d)).toEqual({ minutes: 180, events: 3 });
    expect(busy.get(trip)).toEqual({ minutes: 900, events: 1 });
    expect(busy.get(addDays(trip, 1))).toEqual({ minutes: 900, events: 1 });
    expect(busy.get(addDays(today, 4))).toEqual({ minutes: 0, events: 0 });
  });
});

describe('load with a calendar', () => {
  it('shrinks the day with its free time compared with a usual one, and leaves a standing weekly meeting alone', async () => {
    // A two-hour meeting on this weekday every week for eight weeks is usual.
    for (let w = 0; w <= 8; w++) google.put('jon@example.com', timed(`weekly-${w}`, addDays(today, 7 * (1 - w)), '13:00', '15:00'));
    // A three-hour party tomorrow is not.
    google.put('jon@example.com', timed('party', addDays(today, 1), '17:00', '20:00'));
    await connect();
    expect(usualBusy(db, jon, today).get(Temporal.PlainDate.from(today).dayOfWeek)).toBe(120);

    const [day, tomorrow] = getLoad(db, jon, jon, today, addDays(today, 1));
    expect(day).toMatchObject({ eventMinutes: 120, usualEventMinutes: 120, capacityMinutes: day!.baseCapacityMinutes });
    expect(tomorrow).toMatchObject({ eventMinutes: 180, usualEventMinutes: 0, events: 1 });
    // 720 of a usual 900 free waking minutes: four fifths of the room.
    expect(tomorrow!.capacityMinutes).toBe(Math.round((tomorrow!.baseCapacityMinutes * 0.8) / 5) * 5);
  });

  it('gives a lighter-than-usual day more room, up to half again, and a day off stays off', () => {
    expect(roomAfterEvents(180, 0, 120)).toBe(210);
    expect(roomAfterEvents(180, 210, 30)).toBe(145);
    expect(roomAfterEvents(180, 0, 900)).toBe(270);
    expect(roomAfterEvents(180, 900, 0)).toBe(0);
    expect(roomAfterEvents(0, 0, 300)).toBe(0);
  });

  it('learns capacity as if busy days had been ordinary ones', async () => {
    // Jon finished 120 minutes on each of the last six of this weekday, and two of those days also
    // had a four-hour event on top of a usually empty calendar.
    const dow = Temporal.PlainDate.from(today).dayOfWeek;
    for (let w = 1; w <= 6; w++) {
      const date = addDays(today, -7 * w);
      const when = new Date(Temporal.PlainDateTime.from(`${date}T12:00`).toZonedDateTime(TZ).epochMilliseconds);
      db.insert(tasks).values({ title: `t${w}`, status: 'done', completedAt: when, completedById: jon.id, estimateMinutes: 120, updatedAt: when }).run();
      db.insert(activity).values({ memberId: jon.id, action: 'task.completed', createdAt: when }).run();
    }
    expect(learnedCapacity(db, jon).find((d) => d.weekday === dow)!.minutes).toBe(120);
    google.put('jon@example.com', timed('conference', addDays(today, -7), '09:00', '13:00'));
    google.put('jon@example.com', timed('workshop', addDays(today, -14), '09:00', '13:00'));
    await connect();
    // Those two had 660 free waking minutes instead of 900, so their 120 counts as about 164, and a
    // good day is the 75th percentile of 120, 120, 120, 120, 164, 164.
    expect(learnedCapacity(db, jon).find((d) => d.weekday === dow)!.minutes).toBe(150);
  });
});

describe('calendars API', () => {
  const ORIGIN = 'https://amble.test';
  const appConfig: Config = { ...testConfig, publicUrl: ORIGIN, basePath: '', publicOrigin: ORIGIN, devLogin: false, ai: { ...config.ai, apiKey: '' } };

  async function client(cfg = appConfig) {
    const { createApp } = await import('../app.ts');
    const { createOidc } = await import('../auth/oidc.ts');
    const { createSession } = await import('../auth/sessions.ts');
    const app = createApp({ db, config: cfg, oidc: createOidc(cfg), calendar: sync });
    const cookie = `almanac_session=${createSession(db, jon.id, 'test')}`;
    return async (method: string, path: string, data?: unknown) => {
      const res = await app.request(`${ORIGIN}${path}`, {
        method,
        redirect: 'manual',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: res.status, location: res.headers.get('location'), json: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
    };
  }

  it('lists accounts and events, changes which calendars count, syncs on open and disconnects', async () => {
    google.put('jon@example.com', timed('dentist', today, '09:00', '10:00'));
    google.put('family', timed('soccer', today, '17:00', '18:00'));
    await connect();
    const call = await client();

    const { json } = await call('GET', '/api/calendars');
    expect(json.enabled).toBe(true);
    expect(json.accounts[0]).toMatchObject({ email: 'jon@example.com', status: 'ok', error: null });
    expect((await call('GET', `/api/events?start=${today}&end=${today}`)).json.events.map((e: { title: string }) => e.title)).toEqual(['dentist', 'soccer']);
    expect((await call('GET', `/api/load?start=${today}&end=${today}`)).json.days[0]).toMatchObject({ eventMinutes: 120, events: 2 });

    const family = json.accounts[0].calendars.find((c: { name: string }) => c.name === 'Family');
    const changed = await call('PATCH', `/api/calendars/${family.id}`, { counts: false });
    expect(changed.json.accounts[0].calendars.find((c: { name: string }) => c.name === 'Family').counts).toBe(false);
    expect((await call('GET', `/api/events?start=${today}&end=${today}`)).json.events.map((e: { title: string }) => e.title)).toEqual(['dentist']);

    // Synced moments ago, so opening the app doesn't sync again.
    expect((await call('POST', '/api/calendars/sync', {})).json).toEqual({ synced: 0 });
    db.update(calendarAccounts).set({ syncedAt: new Date(Date.now() - 3600_000) }).run();
    expect((await call('POST', '/api/calendars/sync', {})).json).toEqual({ synced: 1 });

    expect((await call('PATCH', '/api/calendars/nope', { counts: true })).status).toBe(400);
    expect((await call('DELETE', `/api/calendars/accounts/${json.accounts[0].id}`)).status).toBe(204);
    expect((await call('GET', '/api/calendars')).json.accounts).toEqual([]);
  });

  it('sends people back to the Calendars page when the server has no Google client for calendars', async () => {
    const off: Config = { ...appConfig, calendar: { clientId: '', clientSecret: '' } };
    const call = await client(off);
    const res = await call('GET', '/auth/calendar');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/settings/calendars?error=off');
  });
});
