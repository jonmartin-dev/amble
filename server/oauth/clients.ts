import { randomBytes } from 'node:crypto';
import { and, count, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { oauthClients, oauthGrants, type OAuthClient } from '../db/schema.ts';

/** An OAuth error to send back as `{ error, error_description }`. */
export class OAuthFailure extends Error {
  code: string;
  status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const METADATA_MAX_BYTES = 20_000;
const REGISTRATIONS_PER_HOUR = 50;
const UNUSED_REGISTRATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parse(url: string) {
  return URL.canParse(url) ? new URL(url) : null;
}

export function isLoopback(uri: string) {
  const u = parse(uri);
  return u?.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

/** A redirect URI an allowed app could use: https on an allowed host, or a loopback address. */
function redirectAcceptable(config: Config, uri: string) {
  const u = parse(uri);
  if (!u || u.hash) return false;
  if (u.protocol === 'https:') return config.oauthClientHosts.includes(u.hostname);
  return isLoopback(uri);
}

/**
 * Exact match, except loopback URIs match on any port (RFC 8252 section 7.3). Claude Code
 * declares http://localhost/callback and picks a free port each time it signs in.
 */
export function redirectMatches(registered: string[], requested: string) {
  if (registered.includes(requested)) return true;
  const req = parse(requested);
  if (!req || !isLoopback(requested)) return false;
  return registered.some((r) => {
    const reg = parse(r);
    return (
      reg != null &&
      isLoopback(r) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

/** The host a person should see as the app asking for access. */
export function clientHost(client: OAuthClient) {
  if (client.kind === 'metadata') return new URL(client.id).hostname;
  const first = client.redirectUris[0];
  return first ? (parse(first)?.host ?? 'unknown') : 'unknown';
}

interface MetadataDocument {
  client_id?: unknown;
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
}

/**
 * Finds the client behind a client_id. A URL means a Client ID Metadata Document, fetched (and
 * cached for a day) only from allowed hosts, so this never fetches arbitrary addresses.
 */
export async function resolveClient(db: Db, config: Config, clientId: string, fetchImpl: typeof fetch = fetch) {
  if (!clientId.startsWith('https://')) {
    const client = db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
    if (!client) throw new OAuthFailure('invalid_client', 'Unknown client. Connect again from Claude.', 401);
    return client;
  }

  const url = parse(clientId);
  if (!url || url.hash || url.pathname === '/' || !config.oauthClientHosts.includes(url.hostname)) {
    throw new OAuthFailure('invalid_client', `Apps from ${url?.hostname ?? 'that address'} can't connect to this Almanac.`, 401);
  }
  const cached = db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < METADATA_MAX_AGE_MS) return cached;

  let doc: MetadataDocument;
  try {
    const res = await fetchImpl(clientId, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > METADATA_MAX_BYTES) throw new Error('document too large');
    doc = JSON.parse(text) as MetadataDocument;
  } catch (err) {
    if (cached) return cached;
    console.warn(`Client metadata fetch failed for ${clientId}:`, err instanceof Error ? err.message : err);
    throw new OAuthFailure('invalid_client', "Couldn't read the app's client information. Try again.", 401);
  }

  const redirects = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  const authMethod = doc.token_endpoint_auth_method ?? 'none';
  if (doc.client_id !== clientId || redirects.length === 0 || authMethod !== 'none') {
    throw new OAuthFailure('invalid_client', "The app's client information isn't valid.", 401);
  }
  const values = {
    kind: 'metadata' as const,
    name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : null,
    redirectUris: redirects.filter((u) => redirectAcceptable(config, u)),
    fetchedAt: new Date(),
  };
  return db
    .insert(oauthClients)
    .values({ id: clientId, ...values })
    .onConflictDoUpdate({ target: oauthClients.id, set: values })
    .returning()
    .get();
}

/** RFC 7591 dynamic client registration, for apps that don't use metadata documents. Public clients only. */
export function registerClient(db: Db, config: Config, body: unknown) {
  const meta = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const redirects = meta.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every((u) => typeof u === 'string')) {
    throw new OAuthFailure('invalid_redirect_uri', 'redirect_uris must be a non-empty list of URLs.');
  }
  const refused = redirects.find((u) => !redirectAcceptable(config, u));
  if (refused) throw new OAuthFailure('invalid_redirect_uri', `${refused} isn't an allowed redirect URI.`);
  const grantTypes = (meta.grant_types as string[] | undefined) ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new OAuthFailure('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
  }
  const responseTypes = (meta.response_types as string[] | undefined) ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    throw new OAuthFailure('invalid_client_metadata', 'Only the code response type is supported.');
  }

  const now = Date.now();
  // Registration is unauthenticated, so clear out registrations nobody ever used, and cap the rate.
  db.delete(oauthClients)
    .where(
      and(
        eq(oauthClients.kind, 'registered'),
        lt(oauthClients.createdAt, new Date(now - UNUSED_REGISTRATION_TTL_MS)),
        sql`not exists (select 1 from ${oauthGrants} where ${oauthGrants.clientId} = ${oauthClients.id})`,
      ),
    )
    .run();
  const recent = db
    .select({ n: count() })
    .from(oauthClients)
    .where(and(eq(oauthClients.kind, 'registered'), gte(oauthClients.createdAt, new Date(now - 60 * 60 * 1000)), isNull(oauthClients.fetchedAt)))
    .get();
  if ((recent?.n ?? 0) >= REGISTRATIONS_PER_HOUR) {
    throw new OAuthFailure('temporarily_unavailable', 'Too many registrations. Try again later.', 429);
  }

  const name = typeof meta.client_name === 'string' ? meta.client_name.slice(0, 100) : null;
  const client = db
    .insert(oauthClients)
    .values({ id: `alm_${randomBytes(16).toString('base64url')}`, kind: 'registered', name, redirectUris: redirects })
    .returning()
    .get();
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: name ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
