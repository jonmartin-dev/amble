import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { activity, groups, members, type Group, type Member } from '../db/schema.ts';

/** A mistake in what was asked for, worded so the person (or Claude) can fix it and retry. */
export class DomainError extends Error {}

/** Who is making a change, and from where. Every change lands in Activity with this. */
export interface Actor {
  member: Member;
  via: 'app' | 'claude';
}

export function firstName(member: Pick<Member, 'name'>) {
  return member.name.split(/\s+/)[0] ?? member.name;
}

export function listMembers(db: Db) {
  return db.select().from(members).orderBy(asc(members.createdAt)).all();
}

/** Groups this member can see: everything shared, plus their own private groups. */
export function visibleGroups(db: Db, memberId: string) {
  return db
    .select()
    .from(groups)
    .where(and(isNull(groups.archivedAt), or(isNull(groups.privateTo), eq(groups.privateTo, memberId))))
    .orderBy(asc(groups.sortOrder), asc(groups.createdAt))
    .all();
}

function norm(s: string) {
  return s.trim().toLowerCase();
}

/** Finds a group by id or name (case-insensitive, then unique prefix). */
export function resolveGroup(db: Db, member: Member, ref: string, kind?: Group['kind']): Group {
  const all = visibleGroups(db, member.id).filter((g) => !kind || g.kind === kind);
  const q = norm(ref);
  const match =
    all.find((g) => g.id === ref) ??
    all.find((g) => norm(g.name) === q) ??
    (() => {
      const prefixed = all.filter((g) => norm(g.name).startsWith(q));
      return prefixed.length === 1 ? prefixed[0] : undefined;
    })();
  if (match) return match;
  const noun = kind === 'list' ? 'list' : 'group';
  throw new DomainError(`No ${noun} called "${ref}". Available: ${all.map((g) => g.name).join(', ') || 'none'}.`);
}

/**
 * Resolves who a task is for: "me", a first name, a full name or an email.
 * Returns null for "anyone"/"nobody", meaning the task is shared.
 */
export function resolveMember(db: Db, me: Member, ref: string): Member | null {
  const q = norm(ref);
  if (['me', 'myself', 'i'].includes(q)) return me;
  if (['anyone', 'nobody', 'either', 'unassigned', 'shared', 'none'].includes(q)) return null;
  const all = listMembers(db);
  const match =
    all.find((m) => m.id === ref) ??
    all.find((m) => m.email === q) ??
    all.find((m) => norm(m.name) === q) ??
    (() => {
      const byFirst = all.filter((m) => norm(firstName(m)) === q);
      return byFirst.length === 1 ? byFirst[0] : undefined;
    })();
  if (match) return match;
  throw new DomainError(`No one called "${ref}" in this household. Members: ${all.map((m) => m.name).join(', ')}.`);
}

// Kept in step with GroupIcon and tones in web/src/components/icons.tsx.
export const GROUP_ICONS = ['home', 'directions-car', 'shopping-cart', 'call', 'rocket-launch', 'palette', 'folder'] as const;
export const GROUP_COLORS = ['green', 'teal', 'lime', 'blue', 'violet', 'orange', 'rose'] as const;

export interface NewGroup {
  name: string;
  kind?: Group['kind'];
  icon?: (typeof GROUP_ICONS)[number];
  color?: (typeof GROUP_COLORS)[number];
  /** Only this member sees a private group and its tasks. */
  private?: boolean;
}

export function createGroup(db: Db, actor: Actor, input: NewGroup): Group {
  const name = input.name.trim();
  if (!name) throw new DomainError('A group needs a name.');
  const clash = visibleGroups(db, actor.member.id).find((g) => norm(g.name) === norm(name));
  if (clash) throw new DomainError(`There's already a ${clash.kind === 'list' ? 'list' : 'group'} called ${clash.name}.`);
  const all = db.select({ sortOrder: groups.sortOrder }).from(groups).all();
  const group = db
    .insert(groups)
    .values({
      name,
      kind: input.kind ?? 'tasks',
      icon: input.icon ?? (input.kind === 'list' ? 'shopping-cart' : 'folder'),
      color: input.color ?? GROUP_COLORS[all.length % GROUP_COLORS.length]!,
      privateTo: input.private ? actor.member.id : null,
      sortOrder: Math.max(-1, ...all.map((g) => g.sortOrder)) + 1,
    })
    .returning()
    .get();
  logActivity(db, actor, 'group.created', null, { name, kind: group.kind });
  return group;
}

export function logActivity(
  db: Db,
  actor: Actor,
  action: string,
  taskId: string | null,
  detail?: Record<string, unknown>,
) {
  db.insert(activity)
    .values({ memberId: actor.member.id, via: actor.via, action, taskId, detail: detail ?? null })
    .run();
}
