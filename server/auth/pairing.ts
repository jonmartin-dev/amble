// Letting a phone, a computer or a browser into a server with a short code instead of a sign-in
// provider, so a household's server needs nothing set up with Google or anyone else. Someone already
// in shows a code (Settings, Your server, Add a phone or computer), or the setup script shows one
// for the first admin; the new device types or scans it. A code for someone signs in as them. An
// invite brings in someone new, or anyone the household already has: a phone moving from Google
// Drive finds its person here by the email it synced with. Codes are short enough to type, so they
// work once (an invite for a household moving from Drive works until it runs out), last minutes,
// and a run of wrong guesses from one place is turned away.
import { createHash, randomInt } from 'node:crypto';
import { and, count, eq, isNull, lt } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { members, pairCodes, type Member } from '../db/schema.ts';
import { isDeviceEmail } from '../local.ts';

/** A code shown on a device lasts this long. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** The setup script's code for the first admin: long enough to finish setting up Tailscale and the phone. */
export const ADMIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;
/** A household moving from Google Drive: its invite stays on the household file this long. */
export const HOUSEHOLD_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Letters and digits that can't be mistaken for each other (no 0/O, 1/I/L), eight of them: about 8.5e11.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 8;
const memberColors = ['green', 'blue', 'orange', 'violet', 'teal', 'rose'];

/** "abcd efgh", "ABCD-EFGH" and "abcdefgh" are the same code. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');
/** As it's shown: ABCD-EFGH. */
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const hash = (code: string) => createHash('sha256').update(normalizeCode(code)).digest('base64url');

export type CodeFor = { kind: 'person'; memberId: string } | { kind: 'invite'; role: 'admin' | 'member'; by: string | null; household?: boolean };

/** Makes a code and returns it as it's shown. Expired codes go as new ones are made. */
export function makeCode(db: Db, what: CodeFor, now = Date.now()): { code: string; expiresAt: Date } {
  db.delete(pairCodes).where(lt(pairCodes.expiresAt, new Date(now))).run();
  const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const ttl = what.kind === 'invite' && what.household ? HOUSEHOLD_CODE_TTL_MS : what.kind === 'invite' && what.role === 'admin' && !what.by ? ADMIN_CODE_TTL_MS : CODE_TTL_MS;
  const expiresAt = new Date(now + ttl);
  db.insert(pairCodes)
    .values({
      codeHash: hash(code),
      kind: what.kind,
      memberId: what.kind === 'person' ? what.memberId : what.by,
      role: what.kind === 'invite' ? what.role : 'member',
      // An invite for a household moving from Drive works for everyone in it.
      usesLeft: what.kind === 'invite' && what.household ? null : 1,
      expiresAt,
    })
    .run();
  return { code: showCode(code), expiresAt };
}

/** A code that still works, without using it up. */
function find(db: Db, code: string, now: number) {
  const row = db.select().from(pairCodes).where(eq(pairCodes.codeHash, hash(code))).get();
  if (!row || row.expiresAt.getTime() <= now || row.usesLeft === 0) return null;
  return row;
}

/** What a code would do, for a device to say so before it's used: who it signs in as, or that it brings someone in. */
export function checkCode(db: Db, code: string, now = Date.now()): { kind: 'person'; name: string } | { kind: 'invite' } | null {
  const row = find(db, code, now);
  if (!row) return null;
  if (row.kind === 'invite') return { kind: 'invite' };
  const member = row.memberId ? db.select().from(members).where(eq(members.id, row.memberId)).get() : undefined;
  return member ? { kind: 'person', name: member.name } : null;
}

/** Who a device or browser is, as far as it knows: its own person, if it has one, or just a name to start with. */
export interface Newcomer {
  id?: string;
  name?: string;
  email?: string;
}

export class NeedsName extends Error {
  constructor() {
    super('Say what Amble should call you.');
  }
}

/**
 * Uses a code: the member it signs in as, or for an invite, the member the newcomer is here (the
 * same id, or the same real email) or becomes. Null when the code doesn't work. Throws NeedsName,
 * leaving the code unused, when an invite brings in someone new with no name to go by.
 */
export function redeemCode(db: Db, config: Config, code: string, who: Newcomer = {}, now = Date.now()): Member | null {
  const row = find(db, code, now);
  if (!row) return null;
  return db.transaction(() => {
    let member: Member | undefined;
    if (row.kind === 'person') {
      member = row.memberId ? db.select().from(members).where(eq(members.id, row.memberId)).get() : undefined;
      if (!member) return null;
    } else {
      member = known(db, who);
      if (!member) {
        const name = who.name?.trim();
        if (!name) throw new NeedsName();
        member = newMember(db, config, { ...who, name }, row.role);
      } else if (row.role === 'admin' && member.role !== 'admin') {
        member = db.update(members).set({ role: 'admin' }).where(eq(members.id, member.id)).returning().get();
      }
    }
    if (row.usesLeft != null) db.update(pairCodes).set({ usesLeft: row.usesLeft - 1 }).where(eq(pairCodes.id, row.id)).run();
    db.update(members).set({ lastLoginAt: new Date(now) }).where(eq(members.id, member.id)).run();
    return member;
  });
}

/** The household's row for a newcomer it already has: the same id, or the same real email. */
function known(db: Db, who: Newcomer): Member | undefined {
  if (who.id) {
    const byId = db.select().from(members).where(eq(members.id, who.id)).get();
    if (byId) return byId;
  }
  const email = who.email?.trim().toLowerCase();
  if (email && !isDeviceEmail(email)) return db.select().from(members).where(eq(members.email, email)).get();
  return undefined;
}

/** Someone new, keeping the id their device made for them, so nothing they made there has to move. */
function newMember(db: Db, config: Config, who: Newcomer & { name: string }, role: 'admin' | 'member'): Member {
  const id = who.id ?? crypto.randomUUID();
  const email = who.email?.trim().toLowerCase();
  const taken = email ? db.select({ id: members.id }).from(members).where(eq(members.email, email)).get() : undefined;
  const [row] = db.select({ n: count() }).from(members).all();
  return db
    .insert(members)
    .values({
      id,
      email: email && !taken ? email : `${id}@device.invalid`,
      name: who.name.slice(0, 80),
      color: memberColors[(row?.n ?? 0) % memberColors.length]!,
      role,
      timezone: config.timezone,
    })
    .returning()
    .get();
}

/** Takes away the invites for a household moving from Google Drive, the only codes that work more than once. */
export function endHouseholdCodes(db: Db) {
  db.delete(pairCodes).where(and(eq(pairCodes.kind, 'invite'), isNull(pairCodes.usesLeft))).run();
}

/**
 * Wrong codes from one place: after this many in a window, it's turned away until the window passes.
 * In memory, so a restart forgets; the codes' own short life does the rest.
 */
export function guessLimit({ max = 10, windowMs = 10 * 60 * 1000 } = {}) {
  const misses = new Map<string, { n: number; until: number }>();
  return {
    blocked(from: string, now = Date.now()) {
      const m = misses.get(from);
      return m != null && m.until > now && m.n >= max;
    },
    missed(from: string, now = Date.now()) {
      const m = misses.get(from);
      if (!m || m.until <= now) misses.set(from, { n: 1, until: now + windowMs });
      else m.n++;
      // Old entries go, so a stream of addresses can't grow this without end.
      if (misses.size > 10_000) for (const [k, v] of misses) if (v.until <= now) misses.delete(k);
    },
  };
}
