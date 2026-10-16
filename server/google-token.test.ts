import { describe, expect, it } from 'vitest';
import worker from '../deploy/google-token-worker/index.ts';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { config, type Config } from './config.ts';
import { openDatabase } from './db/index.ts';
import { googleToken } from './google-token.ts';

const APP = 'https://amble.example.com';
const sent: { url: string; form: Record<string, string> }[] = [];

/** Google's token endpoint, as far as these calls go. */
const google: typeof fetch = async (input, init) => {
  const url = String(input);
  const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
  sent.push({ url, form });
  if (form.client_secret !== 'shh') return Response.json({ error: 'invalid_client' }, { status: 401 });
  if (form.grant_type === 'refresh_token' && form.refresh_token === 'gone') return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
  return Response.json({ access_token: 'ya29.new', expires_in: 3599, scope: 'drive.file', token_type: 'Bearer', id_token: 'not-for-the-page', ...(form.grant_type === 'authorization_code' && { refresh_token: '1//refresh' }) });
};

const options = { clientId: 'client.apps.googleusercontent.com', clientSecret: 'shh', origins: [APP], fetchImpl: google };
const call = (body: unknown, origin = APP, method = 'POST') =>
  googleToken(new Request('https://server.example.com/google/token', { method, headers: { origin, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), options);

describe('the Google token endpoint for a web app', () => {
  it('trades a code for tokens with the secret added, and passes on only the tokens', async () => {
    sent.length = 0;
    const res = await call({ grant: 'code', code: '4/abc', code_verifier: 'v'.repeat(64), redirect_uri: `${APP}/google-return` });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(await res.json()).toEqual({ access_token: 'ya29.new', expires_in: 3599, scope: 'drive.file', token_type: 'Bearer', refresh_token: '1//refresh' });
    expect(sent[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/token',
      form: { grant_type: 'authorization_code', code: '4/abc', client_id: options.clientId, client_secret: 'shh', redirect_uri: `${APP}/google-return` },
    });
  });

  it('refreshes, and says so when Google has let the token go', async () => {
    expect(await (await call({ grant: 'refresh', refresh_token: '1//refresh' })).json()).toMatchObject({ access_token: 'ya29.new' });
    const gone = await call({ grant: 'refresh', refresh_token: 'gone' });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it("answers only the web app's own pages, and only to its own return page", async () => {
    const elsewhere = await call({ grant: 'refresh', refresh_token: '1//refresh' }, 'https://evil.example.com');
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
    const redirected = await call({ grant: 'code', code: '4/abc', code_verifier: 'v'.repeat(64), redirect_uri: 'https://evil.example.com/google-return' });
    expect(redirected.status).toBe(400);
    expect((await call({ grant: 'revoke', token: '1//refresh' })).status).toBe(400);
  });

  it('lets the page ask first (CORS), and nothing but POST after that', async () => {
    const preflight = await call(null, APP, 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    expect((await call(null, 'https://evil.example.com', 'OPTIONS')).status).toBe(403);
    expect((await call(null, APP, 'GET')).status).toBe(405);
  });

  it('runs as a Cloudflare Worker at /google/token, for the origins it was given', async () => {
    const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'shh', ALLOWED_ORIGINS: `${APP}, http://localhost:5174` };
    const at = (path: string, origin: string) => worker.fetch(new Request(`https://tokens.example.workers.dev${path}`, { method: 'OPTIONS', headers: { origin } }), env);
    expect((await at('/google/token', 'http://localhost:5174')).status).toBe(204);
    expect((await at('/google/token', 'https://evil.example.com')).status).toBe(403);
    expect((await at('/', APP)).status).toBe(404);
  });

  it("is on an Amble server at /google/token, for the server's own pages and the ones it lists", async () => {
    const server: Config = {
      ...config,
      production: false,
      publicUrl: 'https://server.example.com/amble',
      basePath: '/amble',
      publicOrigin: 'https://server.example.com',
      oidc: { ...config.oidc, clientId: '', clientSecret: '' },
      google: { clientId: 'client', clientSecret: 'shh' },
      appOrigins: ['https://server.example.com', APP],
    };
    const app = createApp({ db: openDatabase(':memory:'), config: server, oidc: createOidc(server), fetchImpl: google });
    const res = await app.request('https://server.example.com/amble/google/token', {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json' },
      body: JSON.stringify({ grant: 'refresh', refresh_token: '1//refresh' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ access_token: 'ya29.new' });
  });
});
