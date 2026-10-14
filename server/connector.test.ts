// The remote connector end to end: discovery, Claude's metadata-document sign-in, dynamic
// registration, consent, tokens and refresh rotation, then real MCP calls over HTTP.
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createSession } from './auth/sessions.ts';
import { createOidc } from './auth/oidc.ts';
import { config, type Config } from './config.ts';
import { openDatabase, type Db } from './db/index.ts';
import { activity, members, oauthGrants, oauthTokens, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';

const ORIGIN = 'https://almanac.test';
const ISSUER = `${ORIGIN}/almanac`;
const MCP_URL = `${ISSUER}/mcp`;
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const testConfig: Config = {
  ...config,
  production: false,
  publicUrl: ISSUER,
  basePath: '/almanac',
  publicOrigin: ORIGIN,
  secureCookies: true,
  adminEmails: ['jon@example.com'],
  allowedEmails: ['jon@example.com', 'alex@example.com'],
  devLogin: false,
  oauthClientHosts: ['claude.ai', 'claude.com'],
  oidc: { ...config.oidc, clientId: '', clientSecret: '' },
};

const claudeDocument = {
  client_id: CLAUDE,
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: [CLAUDE_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
const fetchImpl = (async (url: string | URL | Request) =>
  String(url) === CLAUDE ? Response.json(claudeDocument) : new Response('not found', { status: 404 })) as typeof fetch;

let db: Db;
let jon: Member;
let cookie: string;
let app: ReturnType<typeof createApp>;

const request = (path: string, init: RequestInit = {}) => app.request(path.startsWith('http') ? path : `${ISSUER}${path}`, init);
const signedIn = (path: string, init: RequestInit = {}) =>
  request(path, { ...init, headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...init.headers } });
const form = (body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Runs authorize, consent and token exchange the way Claude and the member's browser would. */
async function connect({ clientId = CLAUDE, redirectUri = CLAUDE_CALLBACK, approve = true } = {}) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'almanac',
    resource: MCP_URL,
  });
  const authorize = await signedIn(`/oauth/authorize?${query}`);
  expect(authorize.status).toBe(302);
  const requestId = authorize.headers.get('location')!.match(/\/almanac\/connect\/(.+)$/)![1]!;
  const consent = await (await signedIn(`/api/oauth/requests/${requestId}`)).json();
  const decided = await signedIn(`/api/oauth/requests/${requestId}`, { method: 'POST', body: JSON.stringify({ approve }) });
  const redirect = new URL((await decided.json()).redirect);
  return { consent, redirect, verifier, clientId, redirectUri };
}

async function tokens(flow: Awaited<ReturnType<typeof connect>>) {
  const res = await request(
    '/oauth/token',
    form({
      grant_type: 'authorization_code',
      code: flow.redirect.searchParams.get('code')!,
      client_id: flow.clientId,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      resource: MCP_URL,
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: 'claude-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  cookie = `almanac_session=${createSession(db, jon.id, 'test')}`;
  app = createApp({ db, config: testConfig, oidc: createOidc(testConfig), fetchImpl });
});

describe('discovery', () => {
  it('answers an unauthenticated MCP call with a 401 that points at the metadata', async () => {
    const res = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate')!;
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/almanac/mcp"`);
    expect(challenge).toContain('scope="almanac"');
  });

  it('serves resource and authorization server metadata at the RFC paths, outside the base path', async () => {
    const prm = await (await request(`${ORIGIN}/.well-known/oauth-protected-resource/almanac/mcp`)).json();
    expect(prm).toMatchObject({ resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ['almanac'] });
    const as = await (await request(`${ORIGIN}/.well-known/oauth-authorization-server/almanac`)).json();
    expect(as).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect((await request('/.well-known/oauth-authorization-server')).status).toBe(200);
  });
});

describe('connecting Claude', () => {
  it('sends a signed-out member through sign-in first', async () => {
    const { challenge } = pkce();
    const res = await request(
      `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLAUDE, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' })}`,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!, ORIGIN);
    expect(location.pathname).toBe('/almanac/auth/login');
    expect(location.searchParams.get('return')).toMatch(/^\/oauth\/authorize\?/);
  });

  it('runs the whole flow and lets Claude use the tools as the member', async () => {
    const flow = await connect();
    expect(flow.consent).toEqual({ clientName: 'Claude', clientHost: 'claude.ai', redirectHost: 'claude.ai', loopback: false });
    expect(flow.redirect.origin + flow.redirect.pathname).toBe(CLAUDE_CALLBACK);
    expect(flow.redirect.searchParams.get('state')).toBe('xyz');
    expect(flow.redirect.searchParams.get('iss')).toBe(ISSUER);

    const { status, body } = await tokens(flow);
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'almanac' });
    expect(body.access_token).toMatch(/^alm_at_/);

    const client = await mcpClient(body.access_token);
    expect((await client.listTools()).tools).toHaveLength(22);
    expect(client.getInstructions()).toContain('acting for Jon Martin');
    const result = (await client.callTool({ name: 'add_tasks', arguments: { tasks: [{ title: 'Renew passport', group: 'Errands' }] } })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject([{ title: 'Renew passport', group: 'Errands', for: 'me' }]);
    await client.close();
    expect(db.select().from(activity).all()).toMatchObject([{ action: 'task.created', via: 'claude', memberId: jon.id }]);

    const listed = await (await signedIn('/api/connections')).json();
    expect(listed).toMatchObject({ mcpUrl: MCP_URL, connections: [{ clientName: 'Claude' }] });
  });

  it('refuses a wrong code verifier, and a code used twice', async () => {
    const flow = await connect();
    const wrong = await tokens({ ...flow, verifier: pkce().verifier });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    // The failed attempt used the code up.
    expect((await tokens(flow)).body.error).toBe('invalid_grant');
  });

  it('returns access_denied when the member cancels', async () => {
    const flow = await connect({ approve: false });
    expect(flow.redirect.searchParams.get('error')).toBe('access_denied');
    expect(flow.redirect.searchParams.get('code')).toBeNull();
  });

  it("won't fetch metadata from hosts that aren't allowed, or send codes to unregistered redirects", async () => {
    const { challenge } = pkce();
    const base = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
    const evil = await signedIn(`/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'https://evil.example/client.json', redirect_uri: 'https://evil.example/cb' })}`);
    expect(evil.status).toBe(400);
    const elsewhere = await signedIn(`/oauth/authorize?${new URLSearchParams({ ...base, client_id: CLAUDE, redirect_uri: 'https://evil.example/cb' })}`);
    expect(elsewhere.status).toBe(400);
  });

  it('rotates refresh tokens, and revokes the connection when an old one is replayed', async () => {
    const first = (await tokens(await connect())).body;
    const refresh = (token: string) => request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: token, client_id: CLAUDE }));

    const second = await (await refresh(first.refresh_token)).json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // Inside the grace window a lost response can be retried.
    expect((await refresh(first.refresh_token)).status).toBe(200);

    // Pretend the first token was rotated ten minutes ago, then replay it.
    db.update(oauthTokens).set({ rotatedAt: new Date(Date.now() - 10 * 60_000) }).run();
    const replay = await refresh(first.refresh_token);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(db.select().from(oauthGrants).all()).toHaveLength(0);
    const after = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${second.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(after.status).toBe(401);
  });

  it('disconnecting from Almanac revokes every token', async () => {
    const issued = (await tokens(await connect())).body;
    const [grant] = (await (await signedIn('/api/connections')).json()).connections;
    expect((await signedIn(`/api/connections/${grant.id}`, { method: 'DELETE' })).status).toBe(204);
    const res = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${issued.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('stops working when the member is removed from the household', async () => {
    const issued = (await tokens(await connect())).body;
    db.delete(members).where(eq(members.id, jon.id)).run();
    const res = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${issued.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('dynamic registration', () => {
  it('registers loopback clients like Claude Code and matches any port', async () => {
    const reg = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Local tool', redirect_uris: ['http://127.0.0.1/callback'] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const flow = await connect({ clientId: client_id, redirectUri: 'http://127.0.0.1:53682/callback' });
    expect(flow.consent).toMatchObject({ clientName: 'Local tool', loopback: true });
    expect((await tokens(flow)).status).toBe(200);
  });

  it('refuses redirects to hosts that are not allowed', async () => {
    const reg = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
    });
    expect(reg.status).toBe(400);
    expect((await reg.json()).error).toBe('invalid_redirect_uri');
  });
});
