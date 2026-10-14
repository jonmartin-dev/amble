import { count, eq } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { members, type Member } from '../db/schema.ts';

const memberColors = ['green', 'blue', 'orange', 'violet', 'teal', 'rose'];

export const DEV_FALLBACK_EMAIL = 'dev@almanac.local';

export function allowedEmails(config: Config): string[] {
  if (config.allowedEmails.length === 0 && config.devLogin) return [DEV_FALLBACK_EMAIL];
  return config.allowedEmails;
}

export function isAllowed(config: Config, email: string) {
  return allowedEmails(config).includes(email.toLowerCase());
}

interface Identity {
  email: string;
  name?: string;
  avatarUrl?: string;
}

/** Find or create the member for a signed-in identity. Caller checks the allowlist first. */
export function upsertMember(db: Db, config: Config, identity: Identity, now = Date.now()): Member {
  const email = identity.email.toLowerCase();
  const role = config.adminEmails.includes(email) || email === DEV_FALLBACK_EMAIL ? 'admin' : 'member';
  const existing = db.select().from(members).where(eq(members.email, email)).get();
  if (existing) {
    // Replace the placeholder name (email local part) once the provider gives a real one.
    const placeholder = existing.name === email.split('@')[0];
    return db
      .update(members)
      .set({
        role,
        name: placeholder && identity.name?.trim() ? identity.name.trim() : existing.name,
        avatarUrl: identity.avatarUrl ?? existing.avatarUrl,
        lastLoginAt: new Date(now),
      })
      .where(eq(members.id, existing.id))
      .returning()
      .get();
  }
  const [row] = db.select({ n: count() }).from(members).all();
  return db
    .insert(members)
    .values({
      email,
      name: identity.name?.trim() || email.split('@')[0]!,
      avatarUrl: identity.avatarUrl,
      color: memberColors[(row?.n ?? 0) % memberColors.length]!,
      role,
      timezone: config.timezone,
      lastLoginAt: new Date(now),
    })
    .returning()
    .get();
}
