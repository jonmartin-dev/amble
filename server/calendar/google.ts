// The small part of Google's Calendar API Amble uses, over plain fetch: refreshing an access
// token, listing calendars, reading events, and revoking access when someone disconnects.
import type { Config } from '../config.ts';
import { seal, unseal } from '../lib/seal.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 20_000;

/** Google turned the refresh token down: access was removed, so the person has to reconnect. */
export class GoogleAuthError extends Error {}
/** The sync token is too old; start again with a full read. */
export class SyncTokenGone extends Error {}

export interface GoogleCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
}

interface When {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  iCalUID?: string;
  start?: When;
  end?: When;
  transparency?: 'opaque' | 'transparent';
  eventType?: string;
  htmlLink?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

export interface EventPage {
  items: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface GoogleApi {
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }>;
  calendars(accessToken: string): Promise<GoogleCalendar[]>;
  events(accessToken: string, calendarId: string, params: Record<string, string>): Promise<EventPage>;
  revoke(token: string): Promise<void>;
}

export function createGoogle(config: Config, fetchImpl: typeof fetch = fetch): GoogleApi {
  const call = (url: string, init?: RequestInit) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  async function get<T>(accessToken: string, url: string): Promise<T> {
    const res = await call(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.status === 410) throw new SyncTokenGone('Sync token expired.');
    if (res.status === 401) throw new GoogleAuthError('Google turned the access token down.');
    if (!res.ok) throw new Error(`Google Calendar answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  return {
    async refresh(refreshToken) {
      const res = await call(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.calendar.clientId,
          client_secret: config.calendar.clientSecret,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
      if (body.error === 'invalid_grant') throw new GoogleAuthError('Google no longer lets Amble read this calendar.');
      if (!res.ok || !body.access_token) throw new Error(`Google's token endpoint answered ${res.status} ${body.error ?? ''}`.trim());
      return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    },

    async calendars(accessToken) {
      const out: GoogleCalendar[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: '250', ...(pageToken && { pageToken }) });
        const page = await get<{ items?: GoogleCalendar[]; nextPageToken?: string }>(accessToken, `${API}/users/me/calendarList?${params}`);
        out.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    events(accessToken, calendarId, params) {
      return get<EventPage>(accessToken, `${API}/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams(params)}`);
    },

    async revoke(token) {
      await call(`${REVOKE_URL}?${new URLSearchParams({ token })}`, { method: 'POST' }).catch(() => {});
    },
  };
}

// ---- refresh tokens at rest -------------------------------------------------------------------
// Sealed under the OAuth client secret (see server/lib/seal.ts).

export const sealToken = (secret: string, token: string) => seal(secret, 'calendar refresh tokens', token);

/** Undefined when it can't be opened (the client secret changed), which means reconnecting. */
export const openToken = (secret: string, value: string) => unseal(secret, 'calendar refresh tokens', value);
