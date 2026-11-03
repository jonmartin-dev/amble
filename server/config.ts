import fs from 'node:fs';
import path from 'node:path';
import { AI_PROVIDERS, aiProvider, type AiEffort, type AiProviderId } from '../shared/ai.ts';

// Settings were ALMANAC_* before the app was renamed Amble (October 2026): an older .env keeps working.
for (const [key, value] of Object.entries(process.env)) {
  const renamed = `AMBLE_${key.slice('ALMANAC_'.length)}`;
  if (key.startsWith('ALMANAC_') && process.env[renamed] === undefined) process.env[renamed] = value;
}

/** Reads NAME, or the contents of the file named by NAME_FILE (Docker secrets style). */
function secret(name: string, { optional = false } = {}): string {
  const file = process.env[`${name}_FILE`];
  if (file && !(optional && !fs.existsSync(file))) return fs.readFileSync(file, 'utf8').trim();
  return process.env[name] ?? '';
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function aiEffort(value: string | undefined): AiEffort | undefined {
  return value === 'default' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function aiProviderId(value: string | undefined): AiProviderId {
  const id = (value ?? '').trim().toLowerCase();
  if (!id) return 'anthropic';
  if (!aiProvider(id)) throw new Error(`AMBLE_AI_PROVIDER must be one of ${AI_PROVIDERS.map((p) => p.id).join(', ')}`);
  return id as AiProviderId;
}

/** "0.1,0.5": US dollars per million tokens in and out, for a model Amble doesn't know. */
function aiPrices(value: string | undefined): [number, number] | undefined {
  if (!value) return undefined;
  const [input, output] = value.split(',').map((n) => Number(n.trim()));
  if (!Number.isFinite(input) || !Number.isFinite(output)) throw new Error('AMBLE_AI_PRICES must look like 0.1,0.5');
  return [input!, output!];
}

const aiProviderSetting = aiProviderId(process.env.AMBLE_AI_PROVIDER);

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.AMBLE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

if (production && !process.env.AMBLE_PUBLIC_URL) {
  throw new Error('AMBLE_PUBLIC_URL is required in production');
}

const adminEmails = list(process.env.AMBLE_ADMIN_EMAILS);
const oidcIssuer = process.env.OIDC_ISSUER ?? 'https://accounts.google.com';
// Optional: a server without a sign-in provider lets people in with codes instead.
const oidcClientSecret = secret('OIDC_CLIENT_SECRET', { optional: true });
// Signing in with Google means the same OAuth client can reach Google Drive too.
const signInIsGoogle = new URL(oidcIssuer).hostname === 'accounts.google.com';

export const config = {
  production,
  port,
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl,
  // The path part of the public URL, e.g. "/amble". Requests may arrive
  // with or without it depending on whether the reverse proxy strips it.
  basePath: new URL(publicUrl).pathname.replace(/\/+$/, ''),
  // A path the app used to be served under, e.g. "/almanac": requests there go on to the new one.
  redirectFrom: (process.env.AMBLE_REDIRECT_FROM ?? '').replace(/\/+$/, ''),
  publicOrigin: new URL(publicUrl).origin,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir: path.resolve(process.env.AMBLE_DATA_DIR ?? './data'),
  timezone: process.env.AMBLE_TIMEZONE ?? 'America/Chicago',
  // Who to ask about privacy, shown on the public /privacy page. Left out when empty.
  privacyContact: process.env.AMBLE_PRIVACY_CONTACT ?? '',
  adminEmails,
  allowedEmails: [...new Set([...adminEmails, ...list(process.env.AMBLE_ALLOWED_EMAILS)])],
  // What the server seals what it keeps under (an AI key, Google Drive's access); optional, see
  // server/lib/secret.ts for what it uses without.
  secret: secret('AMBLE_SECRET', { optional: true }),
  // A sign-in provider is optional: without one, phones and browsers get in with codes from a
  // device that's already in (server/auth/pairing.ts).
  oidc: {
    issuer: oidcIssuer,
    providerName: process.env.OIDC_PROVIDER_NAME ?? 'Google',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: oidcClientSecret,
  },
  // Google, for syncing the server through Google Drive and renewing browsers' Drive access. With
  // Google sign-in it uses that client; with another provider, set a Google OAuth client of its
  // own. Either way the client needs <public URL>/auth/callback as a redirect URI.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || (signInIsGoogle ? (process.env.OIDC_CLIENT_ID ?? '') : ''),
    clientSecret: secret('GOOGLE_CLIENT_SECRET', { optional: true }) || (signInIsGoogle ? oidcClientSecret : ''),
  },
  // Where else the app is served from (a copy on Cloudflare Pages, say), besides this server's own
  // address: those may sign in here to sync, and use /google/token to stay signed in to Drive (see
  // server/google-token.ts). Like https://amble.example.com, comma-separated. The Android app and
  // copies on this computer (localhost) always may.
  appOrigins: [new URL(publicUrl).origin, ...list(process.env.AMBLE_APP_ORIGINS), ...list(process.env.AMBLE_GOOGLE_TOKEN_ORIGINS)],
  // Files on tasks are kept under <data dir>/files, each at most this big.
  maxFileBytes: Math.round(Number(process.env.AMBLE_MAX_FILE_MB ?? 25) * 1024 * 1024),
  devLogin: !production && process.env.AMBLE_DEV_LOGIN === '1',
  // Hosts of the assistants that may connect to the connector (Claude and ChatGPT by default):
  // their client metadata URLs and web redirect URIs must be on one of these. Loopback redirects
  // (Claude Code and other local tools) are always allowed.
  oauthClientHosts: list(process.env.AMBLE_OAUTH_CLIENT_HOSTS ?? 'claude.ai,claude.com,chatgpt.com'),
  // Smart add, estimates and the planner's wording. An admin can also pick a model in Settings, AI,
  // which wins over these. Without either they're off and quick add works as typed.
  ai: {
    provider: aiProviderSetting,
    apiKey:
      secret('AMBLE_AI_API_KEY', { optional: true }) || (aiProviderSetting === 'anthropic' ? secret('ANTHROPIC_API_KEY', { optional: true }) : ''),
    // Empty for the provider's suggested model.
    model: process.env.AMBLE_AI_MODEL ?? '',
    // Empty for the provider's own address; needed for "custom".
    baseUrl: process.env.AMBLE_AI_BASE_URL ?? '',
    effort: aiEffort(process.env.AMBLE_AI_EFFORT),
    monthlyCapUsd: Number(process.env.AMBLE_AI_MONTHLY_CAP_USD ?? 10),
    prices: aiPrices(process.env.AMBLE_AI_PRICES),
  },
};

export type Config = typeof config;
