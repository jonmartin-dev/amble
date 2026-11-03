// The secret a server seals what it keeps under: an AI key, Google Drive's lasting access.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';

const known = new Map<string, string>();

/**
 * AMBLE_SECRET if it's set. Otherwise the one this server made for itself, kept beside its
 * database, if it has one; then the sign-in client's secret, which servers set up with a sign-in
 * provider have always used; and failing those, a new one made and kept now. A server that started
 * without a sign-in provider keeps its own even after one is added, so what it sealed stays readable.
 */
export function serverSecret(config: Pick<Config, 'secret' | 'oidc' | 'dataDir'>): string {
  if (config.secret) return config.secret;
  const file = path.join(config.dataDir, 'secret');
  let value = known.get(file);
  if (value) return value;
  try {
    value = fs.readFileSync(file, 'utf8').trim();
  } catch {
    value = '';
  }
  if (!value && config.oidc.clientSecret) return config.oidc.clientSecret;
  if (!value) {
    value = randomBytes(32).toString('base64url');
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, value, { mode: 0o600 });
  }
  known.set(file, value);
  return value;
}
