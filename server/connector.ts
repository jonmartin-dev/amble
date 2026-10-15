// The remote connector: Amble as its own OAuth 2.1 authorization server, plus the MCP endpoint
// those tokens unlock. Claude (claude.ai, the desktop and mobile apps, Claude Code) and ChatGPT
// find everything from the 401 on /mcp, identify themselves with a Client ID Metadata Document
// (or dynamic registration), and send the member through Amble's normal sign-in and a one-tap
// consent page.
import { createMcpHandler, OAuthError, OAuthErrorCode, requireBearerAuth, type AuthInfo } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { members } from './db/schema.ts';
import type { Assistant } from './domain/household.ts';
import type { Env } from './env.ts';
import { createMcpServer } from './mcp/server.ts';
import {
  assistantFor,
  clientHost,
  isLoopback,
  OAuthFailure,
  redirectMatches,
  registerClient,
  resolveClient,
  sameResource,
} from './oauth/clients.ts';
import { createGrantStore, SCOPE } from './oauth/grants.ts';

const EXPIRED = 'This request has expired. Start connecting again from the assistant.';

function oauthError(c: Context<Env>, err: unknown) {
  if (err instanceof OAuthFailure) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: err.code, error_description: err.message }, err.status as 400);
  }
  console.error('OAuth endpoint failed:', err);
  return c.json({ error: 'server_error', error_description: 'Something went wrong.' }, 500);
}

function errorPage(message: string) {
  const safe = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amble</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#171d1a;background:#f4fbf7">
<h1 style="font-weight:500">Can't connect</h1><p>${safe}</p><p>Start again from the app you were connecting.</p></body>`;
}

async function readBody(c: Context<Env>): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  const raw = type.includes('application/json')
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody();
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** The client_id from HTTP Basic auth, for clients that send it that way even without a secret. */
function basicClientId(header: string | undefined) {
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return decodeURIComponent(decoded.split(':')[0] ?? '') || undefined;
}

export function registerConnector(app: Hono<Env>, { db, config, fetchImpl = fetch }: { db: Db; config: Config; fetchImpl?: typeof fetch }) {
  const base = config.basePath;
  const issuer = config.publicUrl;
  const resource = `${config.publicUrl}/mcp`;
  // RFC 9728 puts the document under the origin's /.well-known with the resource path appended.
  const resourceMetadataUrl = `${config.publicOrigin}/.well-known/oauth-protected-resource${base}/mcp`;
  const store = createGrantStore(db, config);

  const authServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Amble',
  };

  // Everything a client calls directly is open to any origin. None of it uses cookies.
  const open = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    maxAge: 86400,
  });
  for (const path of ['/.well-known/*', '/oauth/token', '/oauth/register', '/oauth/revoke', '/mcp']) app.use(path, open);

  // The proxy may send these with the base path inserted after /.well-known (RFC 8414/9728 style)
  // or under the base path, so answer every variant.
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/*']) {
    app.get(path, (c) => c.json(authServerMetadata));
  }
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*']) {
    app.get(path, (c) => c.json(resourceMetadata));
  }

  app.post('/oauth/register', async (c) => {
    try {
      return c.json(registerClient(db, config, await c.req.json().catch(() => null)), 201);
    } catch (err) {
      return oauthError(c, err);
    }
  });

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    if (!q.client_id) return c.html(errorPage('The request is missing client_id.'), 400);
    let client;
    try {
      client = await resolveClient(db, config, q.client_id, fetchImpl);
    } catch (err) {
      return c.html(errorPage(err instanceof Error ? err.message : 'Unknown app.'), 400);
    }
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      return c.html(errorPage("The app asked to return somewhere it didn't register."), 400);
    }
    // From here on, problems go back to the app (RFC 6749 4.1.2.1), with iss per RFC 9207.
    const back = (params: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (q.state) url.searchParams.set('state', q.state);
      url.searchParams.set('iss', issuer);
      return c.redirect(url.toString());
    };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required.' });
    }
    if (q.resource && !sameResource(q.resource, resource)) {
      return back({ error: 'invalid_target', error_description: `This server only issues tokens for ${resource}.` });
    }

    const member = c.get('member');
    if (!member) {
      const here = `/oauth/authorize?${new URL(c.req.url).searchParams}`;
      return c.redirect(`${base}/auth/login?return=${encodeURIComponent(here)}`);
    }
    const id = store.addRequest({
      memberId: member.id,
      client,
      redirectUri,
      state: q.state,
      codeChallenge: q.code_challenge,
      scope: SCOPE,
      resource,
    });
    return c.redirect(`${base}/connect/${id}`);
  });

  app.post('/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const body = await readBody(c);
      const clientId = body.client_id ?? basicClientId(c.req.header('authorization'));
      // Only public clients are advertised, so a signed client assertion (ChatGPT's preferred
      // private_key_jwt) means the client picked a method this server never offered.
      if (body.client_assertion || body.client_assertion_type) {
        throw new OAuthFailure('invalid_client', 'This server only accepts public clients (token_endpoint_auth_method none).', 401);
      }
      if (body.grant_type === 'authorization_code') {
        if (!clientId) throw new OAuthFailure('invalid_client', 'client_id is required.', 401);
        return c.json(
          store.exchangeCode({
            code: body.code ?? '',
            clientId,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
            resource: body.resource,
          }),
        );
      }
      if (body.grant_type === 'refresh_token') {
        return c.json(store.refresh({ refreshToken: body.refresh_token ?? '', clientId }));
      }
      throw new OAuthFailure('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    } catch (err) {
      return oauthError(c, err);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const body = await readBody(c);
    if (body.token) store.revoke(body.token);
    return c.body(null, 200);
  });

  // ---- MCP ------------------------------------------------------------------------------

  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        const found = store.verify(token);
        if (!found) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid or has expired.');
        return {
          token,
          clientId: found.grant.clientId,
          scopes: found.grant.scope.split(' '),
          expiresAt: Math.floor(found.expiresAt.getTime() / 1000),
          resource: new URL(found.grant.resource),
          extra: { memberId: found.member.id, via: assistantFor(found.client) },
        };
      },
    },
    requiredScopes: [SCOPE],
    resourceMetadataUrl,
    expectedResource: new URL(resource),
  });

  const mcp = createMcpHandler(
    ({ authInfo }) => {
      const memberId = authInfo?.extra?.memberId;
      const member = typeof memberId === 'string' ? db.select().from(members).where(eq(members.id, memberId)).get() : undefined;
      if (!member) throw new Error('Connector request without a member');
      return createMcpServer({ db, member, via: (authInfo?.extra?.via as Assistant | undefined) ?? 'assistant' });
    },
    { onerror: (err) => console.warn('MCP:', err.message) },
  );

  app.all('/mcp', async (c) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    return mcp.fetch(c.req.raw, { authInfo: auth });
  });

  // ---- the app's side: consent and connected apps (signed-in API) -----------------------

  return function registerApi(api: Hono<Env>) {
    api.get('/api/oauth/requests/:id', (c) => {
      const me = c.get('member')!;
      const request = store.getRequest(c.req.param('id'), me.id);
      if (!request) return c.json({ error: EXPIRED }, 404);
      return c.json({
        clientName: request.client.name ?? clientHost(request.client),
        clientHost: clientHost(request.client),
        redirectHost: new URL(request.redirectUri).host,
        loopback: isLoopback(request.redirectUri),
      });
    });

    api.post('/api/oauth/requests/:id', async (c) => {
      const me = c.get('member')!;
      const parsed = z.object({ approve: z.boolean() }).safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Choose Allow or Cancel.' }, 400);
      const decided = store.decide(c.req.param('id'), me.id, parsed.data.approve);
      if (!decided) return c.json({ error: EXPIRED }, 404);
      const url = new URL(decided.request.redirectUri);
      if (decided.code) url.searchParams.set('code', decided.code);
      else url.searchParams.set('error', 'access_denied');
      if (decided.request.state) url.searchParams.set('state', decided.request.state);
      url.searchParams.set('iss', issuer);
      return c.json({ redirect: url.toString() });
    });

    api.get('/api/connections', (c) => {
      const me = c.get('member')!;
      return c.json({
        mcpUrl: resource,
        connections: store.listGrants(me.id).map((g) => ({
          id: g.id,
          clientName: g.clientName,
          createdAt: g.createdAt,
          lastUsedAt: g.lastUsedAt,
        })),
      });
    });

    api.delete('/api/connections/:id', (c) => {
      const me = c.get('member')!;
      if (!store.deleteGrant(c.req.param('id'), me.id)) return c.json({ error: 'Not found.' }, 404);
      return c.body(null, 204);
    });
  };
}
