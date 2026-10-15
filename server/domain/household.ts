import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { listTemplate, LIST_TEMPLATES } from '../../shared/templates.ts';
import { activity, groups, listItems, members, tasks, type Group, type Member } from '../db/schema.ts';

/** A mistake in what was asked for, worded so the person (or Claude) can fix it and retry. */
export class DomainError extends Error {}

/** The assistant behind a change made through the connector. `assistant` is one Almanac can't name. */
export type Assistant = 'claude' | 'chatgpt' | 'assistant';

/** Who is making a change, and from where. Every change lands in Activity with this. */
export interface Actor {
  member: Member;
  via: 'app' | Assistant;
  /**
   * When the change was made, for one the app queued offline and is sending later. Activity and
   * completion times use it, and fields someone changed after it are left as they are.
   */
  at?: Date;
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
export const GROUP_ICONS = [
  'home',
  'directions-car',
  'shopping-cart',
  'call',
  'rocket-launch',
  'palette',
  'folder',
  'checklist',
  'shopping-bag',
  'luggage',
  'redeem',
  'location-on',
  'dinner-dining',
  'hardware',
  'movie',
  'map',
  'repeat',
] as const;
export const GROUP_COLORS = ['green', 'teal', 'lime', 'blue', 'violet', 'orange', 'rose'] as const;

export interface NewGroup {
  name: string;
  kind?: Group['kind'];
  icon?: (typeof GROUP_ICONS)[number];
  color?: (typeof GROUP_COLORS)[number];
  /** Only this member sees a private group and its tasks. */
  private?: boolean;
  /** Lists only: which kind of list, from shared/templates.ts. */
  template?: string;
  /** Lists only: which of the template's starter kits to fill it with, or null for none. The first by default. */
  kit?: string | null;
}

export function createGroup(db: Db, actor: Actor, input: NewGroup): Group {
  const name = input.name.trim();
  if (!name) throw new DomainError('A group needs a name.');
  const clash = visibleGroups(db, actor.member.id).find((g) => norm(g.name) === norm(name));
  if (clash) throw new DomainError(`There's already a ${clash.kind === 'list' ? 'list' : 'group'} called ${clash.name}.`);
  if (input.template && !LIST_TEMPLATES.some((t) => t.id === input.template)) throw new DomainError(`There's no "${input.template}" list template.`);
  const template = input.kind === 'list' ? listTemplate(input.template) : null;
  // The kit asked for, the template's first when nobody said, or none when they said none.
  const kits = template?.kits ?? [];
  const kit = input.kit === null ? undefined : input.kit ? kits.find((k) => k.name.toLowerCase() === input.kit!.toLowerCase()) : kits[0];
  if (input.kit && !kit) throw new DomainError(`${template?.name ?? 'That'} list has no "${input.kit}" kit.`);
  const all = db.select({ sortOrder: groups.sortOrder }).from(groups).all();
  return db.transaction(() => {
    const group = db
      .insert(groups)
      .values({
        name,
        kind: input.kind ?? 'tasks',
        template: template?.id ?? null,
        icon: input.icon ?? (template ? (template.icon as (typeof GROUP_ICONS)[number]) : 'folder'),
        // A plain checklist takes the next color in turn; the other templates have their own.
        color: input.color ?? (template && template.id !== 'default' ? template.color : GROUP_COLORS[all.length % GROUP_COLORS.length]!),
        privateTo: (input.private ?? template?.private) ? actor.member.id : null,
        sortOrder: Math.max(-1, ...all.map((g) => g.sortOrder)) + 1,
      })
      .returning()
      .get();
    if (kit?.items.length) {
      db.insert(listItems)
        .values(kit.items.map((it, i) => ({ groupId: group.id, name: it.name, section: it.section ?? null, quantity: it.quantity ?? null, addedById: actor.member.id, sortOrder: i })))
        .run();
    }
    logActivity(db, actor, 'group.created', null, { groupId: group.id, name, kind: group.kind });
    return group;
  });
}

export interface GroupPatch {
  name?: string;
  icon?: (typeof GROUP_ICONS)[number];
  color?: (typeof GROUP_COLORS)[number];
}

export function updateGroup(db: Db, actor: Actor, ref: string, patch: GroupPatch): Group {
  const group = resolveGroup(db, actor.member, ref);
  const fields: Partial<Group> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new DomainError('A group needs a name.');
    const clash = visibleGroups(db, actor.member.id).find((g) => g.id !== group.id && norm(g.name) === norm(name));
    if (clash) throw new DomainError(`There's already a ${clash.kind === 'list' ? 'list' : 'group'} called ${clash.name}.`);
    fields.name = name;
  }
  if (patch.icon) fields.icon = patch.icon;
  if (patch.color) fields.color = patch.color;
  const updated = db.update(groups).set(fields).where(eq(groups.id, group.id)).returning().get();
  if (fields.name && fields.name !== group.name) {
    logActivity(db, actor, 'group.renamed', null, { groupId: group.id, from: group.name, name: fields.name, kind: group.kind });
  }
  return updated;
}

/** Puts the given groups first, in this order. Groups not named keep their order after them. */
export function reorderGroups(db: Db, member: Member, ids: string[]) {
  const visible = visibleGroups(db, member.id);
  const known = new Set(visible.map((g) => g.id));
  const unknown = ids.find((id) => !known.has(id));
  if (unknown) throw new DomainError(`No group with id ${unknown}.`);
  const order = [...ids, ...visible.map((g) => g.id).filter((id) => !ids.includes(id))];
  db.transaction(() => {
    order.forEach((id, i) => db.update(groups).set({ sortOrder: i }).where(eq(groups.id, id)).run());
  });
  return visibleGroups(db, member.id);
}

/** Archived groups this member could see, newest first, for restoring. */
export function archivedGroups(db: Db, memberId: string) {
  return db
    .select()
    .from(groups)
    .where(and(isNotNull(groups.archivedAt), or(isNull(groups.privateTo), eq(groups.privateTo, memberId))))
    .orderBy(desc(groups.archivedAt))
    .all();
}

/**
 * Hides a group from every view. Its open tasks move to no group so they stay in the backlog;
 * restoring puts back the ones nobody has regrouped since. A list keeps its items.
 */
export function archiveGroup(db: Db, actor: Actor, ref: string, restore = false): Group {
  if (!restore) {
    const group = resolveGroup(db, actor.member, ref);
    return db.transaction(() => {
      const moved = db
        .update(tasks)
        .set({ groupId: null, updatedAt: new Date() })
        .where(and(eq(tasks.groupId, group.id), eq(tasks.status, 'open')))
        .returning({ id: tasks.id })
        .all()
        .map((t) => t.id);
      const archived = db.update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, group.id)).returning().get();
      logActivity(db, actor, 'group.archived', null, { groupId: group.id, name: group.name, kind: group.kind, movedTasks: moved });
      return archived;
    });
  }
  const group = archivedGroups(db, actor.member.id).find((g) => g.id === ref);
  if (!group) throw new DomainError(`No archived group with id ${ref}.`);
  return db.transaction(() => {
    const last = db
      .select({ detail: activity.detail })
      .from(activity)
      .where(and(eq(activity.action, 'group.archived'), sql`json_extract(${activity.detail}, '$.groupId') = ${group.id}`))
      .orderBy(desc(activity.createdAt))
      .limit(1)
      .get();
    const moved = ((last?.detail as { movedTasks?: string[] } | null)?.movedTasks ?? []).filter(Boolean);
    if (moved.length) {
      db.update(tasks)
        .set({ groupId: group.id, updatedAt: new Date() })
        .where(and(inArray(tasks.id, moved), isNull(tasks.groupId)))
        .run();
    }
    const restored = db.update(groups).set({ archivedAt: null }).where(eq(groups.id, group.id)).returning().get();
    logActivity(db, actor, 'group.restored', null, { groupId: group.id, name: group.name, kind: group.kind });
    return restored;
  });
}

export function logActivity(
  db: Db,
  actor: Actor,
  action: string,
  taskId: string | null,
  detail?: Record<string, unknown>,
) {
  db.insert(activity)
    .values({ memberId: actor.member.id, via: actor.via, action, taskId, detail: detail ?? null, ...(actor.at && { createdAt: actor.at }) })
    .run();
}
