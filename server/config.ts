import fs from 'node:fs';
import path from 'node:path';

/** Reads NAME, or the contents of the file named by NAME_FILE (Docker secrets style). */
function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return process.env[name] ?? '';
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.ALMANAC_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

if (production && !process.env.ALMANAC_PUBLIC_URL) {
  throw new Error('ALMANAC_PUBLIC_URL is required in production');
}

const adminEmails = list(process.env.ALMANAC_ADMIN_EMAILS);

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
    issuer: process.env.OIDC_ISSUER ?? 'https://accounts.google.com',
    providerName: process.env.OIDC_PROVIDER_NAME ?? 'Google',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: secret('OIDC_CLIENT_SECRET'),
  },
  devLogin: !production && process.env.ALMANAC_DEV_LOGIN === '1',
  // Hosts of the apps that may connect to the Claude connector: their client metadata URLs and
  // web redirect URIs must be on one of these. Loopback redirects (Claude Code) are always allowed.
  oauthClientHosts: list(process.env.ALMANAC_OAUTH_CLIENT_HOSTS ?? 'claude.ai,claude.com'),
};

export type Config = typeof config;
