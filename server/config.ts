import fs from 'node:fs';
import path from 'node:path';

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

function aiEffort(value: string | undefined): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'high' ? value : 'medium';
}

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.ALMANAC_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

if (production && !process.env.ALMANAC_PUBLIC_URL) {
  throw new Error('ALMANAC_PUBLIC_URL is required in production');
}

const adminEmails = list(process.env.ALMANAC_ADMIN_EMAILS);
const oidcIssuer = process.env.OIDC_ISSUER ?? 'https://accounts.google.com';
const oidcClientSecret = secret('OIDC_CLIENT_SECRET');
// Signing in with Google means the same OAuth client can read calendars too.
const signInIsGoogle = new URL(oidcIssuer).hostname === 'accounts.google.com';

export const config = {
  production,
  port,
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl,
  // The path part of the public URL, e.g. "/almanac". Requests may arrive
  // with or without it depending on whether the reverse proxy strips it.
  basePath: new URL(publicUrl).pathname.replace(/\/+$/, ''),
  publicOrigin: new URL(publicUrl).origin,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir: path.resolve(process.env.ALMANAC_DATA_DIR ?? './data'),
  timezone: process.env.ALMANAC_TIMEZONE ?? 'America/Chicago',
  adminEmails,
  allowedEmails: [...new Set([...adminEmails, ...list(process.env.ALMANAC_ALLOWED_EMAILS)])],
  oidc: {
    issuer: oidcIssuer,
    providerName: process.env.OIDC_PROVIDER_NAME ?? 'Google',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: oidcClientSecret,
  },
  // Google Calendar: read each person's calendars so busy days have less room. With Google sign-in
  // it uses that client; with another provider, set a Google OAuth client of its own. Either way
  // the client needs <public URL>/auth/callback as a redirect URI and the Calendar API enabled.
  calendar: {
    clientId: process.env.GOOGLE_CLIENT_ID || (signInIsGoogle ? (process.env.OIDC_CLIENT_ID ?? '') : ''),
    clientSecret: secret('GOOGLE_CLIENT_SECRET', { optional: true }) || (signInIsGoogle ? oidcClientSecret : ''),
  },
  devLogin: !production && process.env.ALMANAC_DEV_LOGIN === '1',
  // Hosts of the apps that may connect to the Claude connector: their client metadata URLs and
  // web redirect URIs must be on one of these. Loopback redirects (Claude Code) are always allowed.
  oauthClientHosts: list(process.env.ALMANAC_OAUTH_CLIENT_HOSTS ?? 'claude.ai,claude.com'),
  // Smart add and the other Haiku features. Without a key they're off and quick add works as typed.
  ai: {
    apiKey: secret('ANTHROPIC_API_KEY', { optional: true }),
    model: process.env.ALMANAC_AI_MODEL ?? 'claude-haiku-5-5',
    effort: aiEffort(process.env.ALMANAC_AI_EFFORT),
    monthlyCapUsd: Number(process.env.ALMANAC_AI_MONTHLY_CAP_USD ?? 10),
  },
};

export type Config = typeof config;
