import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';
import type { Config } from '../config.ts';
import { isAllowed } from '../auth/members.ts';
import type { Db } from '../db/index.ts';
import { members, oauthClients, oauthGrants, oauthTokens, type Member, type OAuthClient } from '../db/schema.ts';
import { clientHost, OAuthFailure, sameResource } from './clients.ts';

export const SCOPE = 'almanac';
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
// A refresh token that was just rotated still works briefly, in case the response carrying its
// replacement got lost. Reuse after that means it leaked, so the whole connection is revoked.
const ROTATION_GRACE_MS = 2 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 15 * 60 * 1000;
const LAST_USED_EVERY_MS = 10 * 60 * 1000;

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const newToken = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

/** An authorization request waiting on the member's Allow or Cancel. */
export interface PendingRequest {
  memberId: string;
  client: OAuthClient;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface IssuedCode {
  memberId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export function createGrantStore(db: Db, config: Config) {
  // Both live only for minutes, so memory is enough. A restart just means connecting again.
  const requests = new Map<string, PendingRequest>();
  const codes = new Map<string, IssuedCode>();

  function sweep(now = Date.now()) {
    for (const [k, v] of requests) if (v.expiresAt < now) requests.delete(k);
    for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
  }

  function memberFor(id: string): Member {
    const member = db.select().from(members).where(eq(members.id, id)).get();
    if (!member || !isAllowed(db, config, member.email)) {
      throw new OAuthFailure('invalid_grant', 'This account can no longer use Almanac.');
    }
    return member;
  }

  function issue(grantId: string, now = Date.now()): TokenResponse {
    const access = newToken('alm_at_');
    const refresh = newToken('alm_rt_');
    db.insert(oauthTokens)
      .values([
        { grantId, kind: 'access', tokenHash: hash(access), expiresAt: new Date(now + ACCESS_TTL_MS) },
        { grantId, kind: 'refresh', tokenHash: hash(refresh), expiresAt: new Date(now + REFRESH_TTL_MS) },
      ])
      .run();
    // Drop this connection's dead tokens as we go.
    db.delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.grantId, grantId),
          or(
            lt(oauthTokens.expiresAt, new Date(now)),
            and(isNotNull(oauthTokens.rotatedAt), lt(oauthTokens.rotatedAt, new Date(now - ROTATION_GRACE_MS))),
          ),
        ),
      )
      .run();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  return {
    addRequest(request: Omit<PendingRequest, 'expiresAt'>) {
      sweep();
      const id = randomBytes(18).toString('base64url');
      requests.set(id, { ...request, expiresAt: Date.now() + REQUEST_TTL_MS });
      return id;
    },

    /** The pending request, only for the member it was made for. */
    getRequest(id: string, memberId: string) {
      sweep();
      const request = requests.get(id);
      return request && request.memberId === memberId ? request : undefined;
    },

    /** Settles a request: approving returns a single-use code for the redirect. */
    decide(id: string, memberId: string, approve: boolean) {
      const request = this.getRequest(id, memberId);
      if (!request) return undefined;
      requests.delete(id);
      if (!approve) return { request, code: undefined };
      const code = randomBytes(32).toString('base64url');
      codes.set(hash(code), {
        memberId,
        clientId: request.client.id,
        clientName: request.client.name ?? clientHost(request.client),
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scope: request.scope,
        resource: request.resource,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      return { request, code };
    },

    exchangeCode(params: { code: string; clientId: string; redirectUri?: string; codeVerifier?: string; resource?: string }) {
      sweep();
      const key = hash(params.code);
      const code = codes.get(key);
      codes.delete(key);
      if (!code) throw new OAuthFailure('invalid_grant', 'That authorization code is invalid or has expired.');
      if (code.clientId !== params.clientId) throw new OAuthFailure('invalid_grant', 'That code was issued to another client.');
      if (params.redirectUri !== code.redirectUri) throw new OAuthFailure('invalid_grant', 'redirect_uri does not match.');
      const verifier = params.codeVerifier ?? '';
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new OAuthFailure('invalid_grant', 'A valid code_verifier is required.');
      const expected = Buffer.from(code.codeChallenge);
      const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new OAuthFailure('invalid_grant', 'code_verifier does not match.');
      }
      if (params.resource && !sameResource(params.resource, code.resource)) throw new OAuthFailure('invalid_target', 'Unknown resource.');
      memberFor(code.memberId);
      const grant = db
        .insert(oauthGrants)
        .values({
          memberId: code.memberId,
          clientId: code.clientId,
          clientName: code.clientName,
          scope: code.scope,
          resource: code.resource,
          lastUsedAt: new Date(),
        })
        .returning()
        .get();
      return issue(grant.id);
    },

    refresh(params: { refreshToken: string; clientId?: string }) {
      const now = Date.now();
      const row = db
        .select({ token: oauthTokens, grant: oauthGrants })
        .from(oauthTokens)
        .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
        .where(and(eq(oauthTokens.tokenHash, hash(params.refreshToken)), eq(oauthTokens.kind, 'refresh')))
        .get();
      if (!row || row.token.expiresAt.getTime() < now) throw new OAuthFailure('invalid_grant', 'The refresh token is invalid or has expired.');
      if (params.clientId && params.clientId !== row.grant.clientId) throw new OAuthFailure('invalid_grant', 'That token belongs to another client.');
      if (row.token.rotatedAt && now - row.token.rotatedAt.getTime() > ROTATION_GRACE_MS) {
        db.delete(oauthGrants).where(eq(oauthGrants.id, row.grant.id)).run();
        console.warn(`Revoked connection ${row.grant.id}: an old refresh token was reused`);
        throw new OAuthFailure('invalid_grant', 'The refresh token was already used. Connect again.');
      }
      memberFor(row.grant.memberId);
      if (!row.token.rotatedAt) db.update(oauthTokens).set({ rotatedAt: new Date(now) }).where(eq(oauthTokens.id, row.token.id)).run();
      db.update(oauthGrants).set({ lastUsedAt: new Date(now) }).where(eq(oauthGrants.id, row.grant.id)).run();
      return issue(row.grant.id, now);
    },

    /** Checks an access token for the MCP endpoint. Returns undefined when it isn't valid. */
    verify(token: string) {
      const now = Date.now();
      const row = db
        .select({ token: oauthTokens, grant: oauthGrants, client: oauthClients, member: members })
        .from(oauthTokens)
        .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .innerJoin(members, eq(oauthGrants.memberId, members.id))
        .where(and(eq(oauthTokens.tokenHash, hash(token)), eq(oauthTokens.kind, 'access')))
        .get();
      if (!row || row.token.expiresAt.getTime() < now || !isAllowed(db, config, row.member.email)) return undefined;
      if (!row.grant.lastUsedAt || now - row.grant.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
        db.update(oauthGrants).set({ lastUsedAt: new Date(now) }).where(eq(oauthGrants.id, row.grant.id)).run();
      }
      return { member: row.member, grant: row.grant, client: row.client, expiresAt: row.token.expiresAt };
    },

    /** RFC 7009: a refresh token ends the whole connection, an access token just itself. */
    revoke(token: string) {
      const row = db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash(token))).get();
      if (!row) return;
      if (row.kind === 'refresh') db.delete(oauthGrants).where(eq(oauthGrants.id, row.grantId)).run();
      else db.delete(oauthTokens).where(eq(oauthTokens.id, row.id)).run();
    },

    listGrants(memberId: string) {
      return db.select().from(oauthGrants).where(eq(oauthGrants.memberId, memberId)).orderBy(desc(oauthGrants.createdAt)).all();
    },

    deleteGrant(id: string, memberId: string) {
      return db.delete(oauthGrants).where(and(eq(oauthGrants.id, id), eq(oauthGrants.memberId, memberId))).run().changes > 0;
    },
  };
}

export type GrantStore = ReturnType<typeof createGrantStore>;
