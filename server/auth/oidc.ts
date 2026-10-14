import * as client from 'openid-client';
import type { Config } from '../config.ts';

interface PendingLogin {
  verifier: string;
  nonce: string;
  returnTo: string;
  expires: number;
}

const FLOW_TTL_MS = 10 * 60 * 1000;

export function createOidc(config: Config) {
  let discovered: Promise<client.Configuration> | undefined;
  const pending = new Map<string, PendingLogin>();
  const redirectUri = `${config.publicUrl}/auth/callback`;

  function provider() {
    discovered ??= client
      .discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret)
      .catch((err) => {
        discovered = undefined;
        throw err;
      });
    return discovered;
  }

  function sweep(now: number) {
    for (const [state, flow] of pending) if (flow.expires < now) pending.delete(state);
  }

  return {
    enabled: Boolean(config.oidc.clientId && config.oidc.clientSecret),

    async begin(returnTo: string) {
      const now = Date.now();
      sweep(now);
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      pending.set(state, { verifier, nonce, returnTo, expires: now + FLOW_TTL_MS });
      const url = client.buildAuthorizationUrl(await provider(), {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        prompt: 'select_account',
      });
      return { url: url.href, state };
    },

    /** Exchange the callback for verified identity claims. `query` is the raw callback query string. */
    async finish(state: string, query: string) {
      const flow = pending.get(state);
      pending.delete(state);
      if (!flow || flow.expires < Date.now()) throw new Error('Sign-in expired. Try again.');
      const tokens = await client.authorizationCodeGrant(await provider(), new URL(`${redirectUri}${query}`), {
        pkceCodeVerifier: flow.verifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.email !== 'string') throw new Error('The provider did not share an email address.');
      if (claims.email_verified === false) throw new Error('That email address is not verified.');
      return {
        email: claims.email,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
        returnTo: flow.returnTo,
      };
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
