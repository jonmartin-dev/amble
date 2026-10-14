import * as client from 'openid-client';
import type { Config } from '../config.ts';

/** Read access to calendars and events, which is all phase 7 needs. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

interface PendingLogin {
  kind: 'signin' | 'calendar';
  verifier: string;
  nonce: string;
  returnTo: string;
  /** For connecting a calendar: who asked, so the callback can check it's still them. */
  memberId?: string;
  expires: number;
}

export type Finished =
  | { kind: 'signin'; email: string; name?: string; avatarUrl?: string; returnTo: string }
  | {
      kind: 'calendar';
      memberId: string;
      returnTo: string;
      subject: string;
      email: string;
      refreshToken: string | undefined;
      accessToken: string;
      expiresIn: number | undefined;
      scope: string;
    };

const FLOW_TTL_MS = 10 * 60 * 1000;
const GOOGLE = 'https://accounts.google.com';

export function createOidc(config: Config) {
  const discovered = new Map<string, Promise<client.Configuration>>();
  const pending = new Map<string, PendingLogin>();
  const redirectUri = `${config.publicUrl}/auth/callback`;

  function discover(issuer: string, clientId: string, clientSecret: string) {
    const key = `${issuer} ${clientId}`;
    let found = discovered.get(key);
    if (!found) {
      found = client.discovery(new URL(issuer), clientId, clientSecret).catch((err) => {
        discovered.delete(key);
        throw err;
      });
      discovered.set(key, found);
    }
    return found;
  }
  const provider = () => discover(config.oidc.issuer, config.oidc.clientId, config.oidc.clientSecret);
  const google = () => discover(GOOGLE, config.calendar.clientId, config.calendar.clientSecret);

  function sweep(now: number) {
    for (const [state, flow] of pending) if (flow.expires < now) pending.delete(state);
  }

  async function start(flow: Omit<PendingLogin, 'verifier' | 'nonce' | 'expires'>, params: Record<string, string>) {
    const now = Date.now();
    sweep(now);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    pending.set(state, { ...flow, verifier, nonce, expires: now + FLOW_TTL_MS });
    const url = client.buildAuthorizationUrl(await (flow.kind === 'calendar' ? google() : provider()), {
      redirect_uri: redirectUri,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      ...params,
    });
    return { url: url.href, state };
  }

  return {
    enabled: Boolean(config.oidc.clientId && config.oidc.clientSecret),
    calendarEnabled: Boolean(config.calendar.clientId && config.calendar.clientSecret),

    begin(returnTo: string) {
      return start({ kind: 'signin', returnTo }, { scope: 'openid email profile', prompt: 'select_account' });
    },

    /**
     * Asks Google for read access to someone's calendars, offline so syncing works while they're
     * away. `consent` makes Google hand over a refresh token even if they connected before.
     */
    beginCalendar(memberId: string, loginHint: string, returnTo: string) {
      return start(
        { kind: 'calendar', memberId, returnTo },
        {
          scope: `openid email ${CALENDAR_SCOPE}`,
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: 'true',
          login_hint: loginHint,
        },
      );
    },

    /** Exchange the callback for verified claims (and, for a calendar, tokens). `query` is the raw callback query string. */
    async finish(state: string, query: string): Promise<Finished> {
      const flow = pending.get(state);
      pending.delete(state);
      if (!flow || flow.expires < Date.now()) throw new Error('Sign-in expired. Try again.');
      const tokens = await client.authorizationCodeGrant(
        await (flow.kind === 'calendar' ? google() : provider()),
        new URL(`${redirectUri}${query}`),
        { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true },
      );
      const claims = tokens.claims();
      if (!claims || typeof claims.email !== 'string') throw new Error('The provider did not share an email address.');
      if (claims.email_verified === false) throw new Error('That email address is not verified.');
      if (flow.kind === 'calendar') {
        return {
          kind: 'calendar',
          memberId: flow.memberId!,
          returnTo: flow.returnTo,
          subject: claims.sub,
          email: claims.email,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresIn: tokens.expires_in,
          scope: tokens.scope ?? '',
        };
      }
      return {
        kind: 'signin',
        email: claims.email,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
        returnTo: flow.returnTo,
      };
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
