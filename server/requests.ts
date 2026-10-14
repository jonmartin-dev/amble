// Writes from the app's outbox. The app keeps changes made offline and sends them in order once
// it's back online, each with a key. If an answer gets lost and the app sends a change again, the
// first answer is replayed instead of applying it twice.
import { and, eq, lt } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { Db } from './db/index.ts';
import { appliedRequests } from './db/schema.ts';
import type { Env } from './env.ts';

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Older than this, a change still counts as sent late but no earlier than this long ago. */
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** Younger than this, a change counts as made now: it was sent straight away. */
const LATE_AFTER_MS = 2000;

/**
 * When a change was made, from the `Almanac-Age` header (milliseconds since the person made it).
 * Using an age rather than a timestamp keeps a phone's wrong clock out of it.
 */
export function madeAt(header: string | undefined, now = Date.now()): Date | undefined {
  const age = Number(header);
  if (!Number.isFinite(age) || age < LATE_AFTER_MS) return undefined;
  return new Date(now - Math.min(age, MAX_AGE_MS));
}

export function queuedWrites(db: Db): MiddlewareHandler<Env> {
  let prunedAt = 0;
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const member = c.get('member')!;
    // A change made while someone else was signed in on this phone isn't this person's to send.
    const madeBy = c.req.header('almanac-member');
    if (madeBy && madeBy !== member.id) {
      return c.json({ error: 'That change was made while someone else was signed in.', code: 'other-member' }, 409);
    }
    const key = c.req.header('idempotency-key');
    if (!key) return next();
    if (key.length > 100) return c.json({ error: 'That request key is too long.' }, 400);

    if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      db.delete(appliedRequests).where(lt(appliedRequests.createdAt, new Date(Date.now() - KEEP_MS))).run();
    }
    const where = and(eq(appliedRequests.memberId, member.id), eq(appliedRequests.key, key));
    const claimed = db.insert(appliedRequests).values({ memberId: member.id, key }).onConflictDoNothing().run();
    if (claimed.changes === 0) {
      const seen = db.select().from(appliedRequests).where(where).get();
      if (seen?.status == null) return c.json({ error: 'Still saving that change.', code: 'in-progress' }, 409);
      const headers = { 'Idempotent-Replayed': 'true', ...(seen.body && { 'Content-Type': 'application/json' }) };
      return new Response(seen.status === 204 ? null : seen.body, { status: seen.status, headers });
    }

    await next();
    if (c.res.status >= 500) {
      // Nothing was saved, so a retry should run it again.
      db.delete(appliedRequests).where(where).run();
      return;
    }
    const body = c.res.status === 204 ? null : await c.res.clone().text();
    db.update(appliedRequests).set({ status: c.res.status, body }).where(where).run();
  };
}
