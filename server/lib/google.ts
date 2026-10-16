// Renewing a Google access token with a refresh token the server keeps, over plain fetch: how a
// server stays connected to Google Drive to sync while nobody's using it.
import type { Config } from '../config.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 20_000;

/** Google turned the refresh token down: access was removed, so the person has to reconnect. */
export class GoogleAuthError extends Error {}

export interface GoogleApi {
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }>;
}

export function createGoogle(config: Config, fetchImpl: typeof fetch = fetch): GoogleApi {
  return {
    async refresh(refreshToken) {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
      if (body.error === 'invalid_grant') throw new GoogleAuthError('Google no longer lets Amble in. Connect it again.');
      if (!res.ok || !body.access_token) throw new Error(`Google's token endpoint answered ${res.status} ${body.error ?? ''}`.trim());
      return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    },
  };
}
