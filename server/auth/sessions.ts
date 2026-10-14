import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { members, sessions, type Member } from '../db/schema.ts';

export const SESSION_COOKIE = 'almanac_session';
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
// Only write last-seen/expiry once a day so every request isn't a write.
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

function hash(token: string) {
  return createHash('sha256').update(token).digest('base64url');
}

export function createSession(db: Db, memberId: string, userAgent: string | undefined, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  db.insert(sessions)
    .values({
      tokenHash: hash(token),
      memberId,
      userAgent: userAgent?.slice(0, 300),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
    })
    .run();
  return token;
}

export function resolveSession(db: Db, token: string, now = Date.now()): Member | null {
  const row = db
    .select({ session: sessions, member: members })
    .from(sessions)
    .innerJoin(members, eq(sessions.memberId, members.id))
    .where(eq(sessions.tokenHash, hash(token)))
    .get();
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= now) {
    db.delete(sessions).where(eq(sessions.id, row.session.id)).run();
    return null;
  }
  if (now - row.session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    db.update(sessions)
      .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.session.id))
      .run();
  }
  return row.member;
}

export function deleteSession(db: Db, token: string) {
  db.delete(sessions).where(eq(sessions.tokenHash, hash(token))).run();
}
