// Secrets kept in the database (calendar refresh tokens, an AI provider's key) are sealed with
// AES-256-GCM under a key derived from the OAuth client secret, which lives in the deployment's
// secrets rather than next to the database, so a copy of the database alone (a backup, say)
// doesn't carry anything usable.
import crypto from 'node:crypto';

function key(secret: string, purpose: string) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'almanac', purpose, 32));
}

export function seal(secret: string, purpose: string, value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(secret, purpose), iv);
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')}`;
}

/** Undefined when it can't be opened (the client secret changed). */
export function unseal(secret: string, purpose: string, value: string): string | undefined {
  if (!value.startsWith('v1:')) return undefined;
  try {
    const raw = Buffer.from(value.slice(3), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(secret, purpose), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
