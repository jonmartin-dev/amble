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

/** A sign-in the provider finished but Almanac can't accept; `code` picks the message the sign-in page shows. */
export class SignInError extends Error {
  readonly code: 'no-email' | 'unverified';
  constructor(code: SignInError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** One line for the log: openid-client's message plus what the provider or the network said. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err instanceof client.ResponseBodyError) {
    return `${err.message}: ${err.error}${err.error_description ? ` (${err.error_description})` : ''}`;
  }
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

export function createOidc(config: Config) {
  const discovered = new Map<string, Promise<client.Configuration>>();
  const pending = new Map<string, PendingLogin>();
  const redirectUri = `${config.publicUrl}/auth/callback`;

  async function configure(issuer: string, clientId: string, clientSecret: string) {
    const server = (await client.discovery(new URL(issuer), clientId, clientSecret)).serverMetadata();
    // Basic is the spec's default, and Authelia refuses anything else unless the client is set up
    // for it. Post only for a provider that says it can't do Basic.
    const methods = server.token_endpoint_auth_methods_supported;
    const post = methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post');
    const auth = post ? client.ClientSecretPost(clientSecret) : client.ClientSecretBasic(clientSecret);
    return new client.Configuration(server, clientId, clientSecret, auth);
  }

  function discover(issuer: string, clientId: string, clientSecret: string) {
    const key = `${issuer} ${clientId}`;
    let found = discovered.get(key);
    if (!found) {
      found = configure(issuer, clientId, clientSecret).catch((err) => {
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

    async begin(returnTo: string) {
      // Google's account chooser helps on a phone signed in to several accounts. Other providers
      // only get it when they say they support it, since some refuse the request (GitLab does).
      const server = (await provider()).serverMetadata();
      const prompts = server.prompt_values_supported;
      const chooser = new URL(server.issuer).origin === GOOGLE || (Array.isArray(prompts) && prompts.includes('select_account'));
      return start({ kind: 'signin', returnTo }, { scope: 'openid email profile', ...(chooser && { prompt: 'select_account' }) });
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
      const configuration = await (flow.kind === 'calendar' ? google() : provider());
      const tokens = await client.authorizationCodeGrant(configuration, new URL(`${redirectUri}${query}`), {
        pkceCodeVerifier: flow.verifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const idToken = tokens.claims()!;
      let claims: Record<string, unknown> & { sub: string } = idToken;
      // Authelia (since 4.39) and some others keep the ID token minimal and share the email only
      // from the userinfo endpoint.
      if (typeof claims.email !== 'string') {
        claims = { ...idToken, ...(await client.fetchUserInfo(configuration, tokens.access_token, idToken.sub)) };
      }
      if (typeof claims.email !== 'string') throw new SignInError('no-email', 'The provider did not share an email address.');
      // A few providers send it as a string.
      if (claims.email_verified === false || claims.email_verified === 'false') {
        throw new SignInError('unverified', `The provider says ${claims.email} is not verified.`);
      }
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
